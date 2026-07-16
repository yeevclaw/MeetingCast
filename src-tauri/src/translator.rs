use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::config::SharedConfig;
use crate::errors;
use crate::languages;
use crate::session;
use crate::traces::{self, TraceRecord};
use crate::verify;

/// Accumulates per-request trace state (latency, token usage, cache activity,
/// outcome) and flushes exactly one `TraceRecord` on drop — so every exit path
/// of `translate` / `generate_summary`, including early `?`/`return Err`, gets
/// recorded without a `record()` call before each return. `outcome` defaults
/// to "error"; the happy path overwrites it before returning.
struct TraceGuard {
    kind: &'static str,
    id: String,
    target: String,
    model: String,
    start: Instant,
    ttft_ms: Option<u64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    stop_reason: Option<String>,
    retries: u32,
    outcome: &'static str,
    glossary_violations: Option<Vec<String>>,
}

impl TraceGuard {
    fn new(kind: &'static str, id: String, target: String, model: String) -> Self {
        Self {
            kind,
            id,
            target,
            model,
            start: Instant::now(),
            ttft_ms: None,
            input_tokens: None,
            output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            stop_reason: None,
            retries: 0,
            outcome: "error",
            glossary_violations: None,
        }
    }

    fn mark_ttft(&mut self) {
        if self.ttft_ms.is_none() {
            self.ttft_ms = Some(self.start.elapsed().as_millis() as u64);
        }
    }

    /// Record usage counters from a `message_start` event's `message.usage`.
    fn absorb_message_start(&mut self, parsed: &Value) {
        if let Some(usage) = parsed.get("message").and_then(|m| m.get("usage")) {
            self.input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64());
            self.cache_creation_input_tokens = usage
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64());
            self.cache_read_input_tokens = usage
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64());
        }
    }

    /// Record usage counters from an OpenAI `usage` object (the final
    /// streaming chunk under `stream_options.include_usage`, or the
    /// non-streaming response body). Field mapping: `prompt_tokens` →
    /// input, `completion_tokens` → output, `prompt_tokens_details.
    /// cached_tokens` → cache_read. `cache_creation_input_tokens` stays
    /// None — OpenAI has no explicit cache-write counter.
    fn absorb_openai_usage(&mut self, usage: &Value) {
        self.input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64());
        self.output_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64());
        self.cache_read_input_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_u64());
    }

    /// Record cumulative output tokens + stop_reason from a `message_delta`.
    fn absorb_message_delta(&mut self, parsed: &Value) {
        if let Some(out) = parsed
            .get("usage")
            .and_then(|u| u.get("output_tokens"))
            .and_then(|v| v.as_u64())
        {
            self.output_tokens = Some(out);
        }
        if let Some(sr) = parsed
            .get("delta")
            .and_then(|d| d.get("stop_reason"))
            .and_then(|v| v.as_str())
        {
            self.stop_reason = Some(sr.to_string());
        }
    }
}

impl Drop for TraceGuard {
    fn drop(&mut self) {
        traces::record(TraceRecord {
            ts: Utc::now().to_rfc3339(),
            kind: self.kind.to_string(),
            id: self.id.clone(),
            target: self.target.clone(),
            model: self.model.clone(),
            ttft_ms: self.ttft_ms,
            total_ms: self.start.elapsed().as_millis() as u64,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_creation_input_tokens: self.cache_creation_input_tokens,
            cache_read_input_tokens: self.cache_read_input_tokens,
            stop_reason: self.stop_reason.clone(),
            retries: self.retries,
            outcome: self.outcome.to_string(),
            glossary_violations: self.glossary_violations.clone(),
        });
    }
}

/// Last N (zh source, target translation) pairs, per target language. Used
/// as light context (pronoun resolution, term consistency) on each new
/// translate call. Max ~2 entries per target keeps the prompt small enough
/// not to blow up the input token cost — most of the lift comes from the
/// most recent sentence anyway.
const CONTEXT_PAIRS: usize = 2;

/// Per target: rolling window of `(t_start, zh source, target translation)`,
/// kept sorted ascending by `t_start`. The leading `t_start` lets write-back
/// order entries by utterance time rather than by completion order — parallel
/// translate calls can finish out of order, and without the key the context
/// would scramble (a later-finishing earlier utterance would look "newer").
pub type TranslationContext = Arc<Mutex<HashMap<String, VecDeque<(f64, String, String)>>>>;

pub fn new_context() -> TranslationContext {
    Arc::new(Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn clear_translation_context(ctx: tauri::State<'_, TranslationContext>) -> Result<(), String> {
    ctx.lock().await.clear();
    Ok(())
}

#[derive(Serialize, Clone)]
struct ChunkPayload {
    id: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct DonePayload {
    id: String,
}

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

/// LLM provider for translation + summary. Selected per call from
/// `config.api.provider`; anything that isn't exactly "openai" degrades to
/// Anthropic so a hand-edited config never hard-errors here.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Provider {
    Anthropic,
    OpenAi,
}

impl Provider {
    fn from_config(s: &str) -> Self {
        if s == "openai" {
            Provider::OpenAi
        } else {
            Provider::Anthropic
        }
    }

    fn url(self) -> &'static str {
        match self {
            Provider::Anthropic => ANTHROPIC_URL,
            Provider::OpenAi => OPENAI_URL,
        }
    }

    /// Prefix used in error strings ("anthropic 429: …" / "openai 429: …") —
    /// matched by the frontend banner rules in src/lib/errors.ts.
    fn label(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
        }
    }
}

/// Process-wide reqwest client shared across every Anthropic call. Pooling one
/// client reuses TCP + TLS connections instead of paying a fresh handshake per
/// `Client::new()`. `connect_timeout` bounds DNS + TCP + TLS setup; `read_timeout`
/// is a between-chunk idle cap that trips only when the stream stalls for that
/// long — safe for long summaries. Deliberately NO total `.timeout()`: it would
/// abort a legitimately long streaming summary mid-flight.
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// Backoff between retries. Two retries (250 ms then 750 ms) catches the
/// transient blips that surface as `request failed` (DNS hiccup, captive-
/// portal probe, TLS handshake reset) while bounding worst-case added
/// latency to ~1 s when both retries fail.
const RETRY_BACKOFF_MS: &[u64] = &[250, 750];

/// Auth headers per provider. Anthropic's arm must stay byte-identical to
/// the pre-provider behavior; OpenAI uses standard Bearer auth.
fn apply_auth(req: reqwest::RequestBuilder, provider: Provider, api_key: &str) -> reqwest::RequestBuilder {
    match provider {
        Provider::Anthropic => req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        Provider::OpenAi => req.header("Authorization", format!("Bearer {api_key}")),
    }
}

/// POST to the LLM provider with bounded retries. Retries cover (a) transport
/// failures where the request never reached the server (`reqwest::Error`
/// from `send()`), and (b) explicit overload / transient-server signals from
/// the API — Anthropic: HTTP 429 (rate-limit), 500 (internal), 503
/// (unavailable), 529 (overloaded); OpenAI: 429, 500, and the 502/503/504
/// its edge returns under load. Other 4xx/5xx surface immediately — retrying
/// a 401 or 400 just produces the same answer while spending more wallclock
/// against the user's perceived latency. When the server sends a `Retry-After`
/// header with an integer-seconds value, the next backoff is
/// `max(fixed_backoff, retry_after)` capped at 10s so we respect the server's
/// pacing without stalling the UI indefinitely.
async fn post_llm_with_retry(
    provider: Provider,
    api_key: &str,
    body: &Value,
    retries: &mut u32,
) -> Result<Response, String> {
    let client = http_client();
    let mut last_err: String = "no attempts made".into();
    // Set by a retryable response carrying Retry-After; consumed by the next
    // iteration's sleep (max'd against the fixed backoff, capped at 10s).
    let mut pending_delay_ms: Option<u64> = None;
    for attempt in 0..=RETRY_BACKOFF_MS.len() {
        // Report attempts performed regardless of eventual success/failure so
        // the caller's trace records the true retry count on every exit path.
        *retries = attempt as u32;
        if attempt > 0 {
            let backoff = RETRY_BACKOFF_MS[attempt - 1];
            let delay = pending_delay_ms
                .take()
                .map(|ra| ra.max(backoff))
                .unwrap_or(backoff);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let resp = apply_auth(client.post(provider.url()), provider, api_key)
            .header("content-type", "application/json")
            .json(body)
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status();
                if status.is_success() {
                    return Ok(r);
                }
                // Read Retry-After before consuming the body with `.text()`.
                let retry_after_ms = r
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .map(|secs| secs.saturating_mul(1000).min(10_000));
                let body_text = r.text().await.unwrap_or_default();
                let msg = format!("{} {status}: {body_text}", provider.label());
                let retryable = match provider {
                    Provider::Anthropic => matches!(status.as_u16(), 429 | 500 | 503 | 529),
                    Provider::OpenAi => matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504),
                };
                if retryable {
                    pending_delay_ms = retry_after_ms;
                    last_err = msg;
                    continue;
                }
                // A 404 (or a body flagging the provider's bad-model error
                // code) on this endpoint almost always means the configured
                // model id is wrong or retired — prefix with an actionable
                // Chinese hint the frontend banner keys off (see
                // src/lib/errors.ts).
                if status.as_u16() == 404
                    || body_text.contains("not_found_error")
                    || body_text.contains("model_not_found")
                {
                    return Err(format!("模型 id 無效（請在設定檢查 model 名稱）: {msg}"));
                }
                return Err(msg);
            }
            Err(e) => {
                last_err = format!("request failed: {e}");
                continue;
            }
        }
    }
    Err(last_err)
}

/// Build the request body for one chat call. The Anthropic arm must stay
/// byte-identical to the pre-provider JSON (system array + ephemeral
/// cache_control); the OpenAI arm uses Chat Completions shape —
/// `max_completion_tokens` (OpenAI deprecated `max_tokens`), system prompt as
/// the leading message, and `stream_options.include_usage` so the final
/// stream chunk carries token usage. `stream_options` is only legal when
/// streaming — the non-streaming fallback strips it.
fn build_chat_body(
    provider: Provider,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    stream: bool,
) -> Value {
    match provider {
        Provider::Anthropic => json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": stream,
            "system": [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"}
            }],
            "messages": [{"role": "user", "content": user}]
        }),
        Provider::OpenAi => {
            let mut body = json!({
                "model": model,
                "max_completion_tokens": max_tokens,
                "stream": stream,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user}
                ]
            });
            if stream {
                body["stream_options"] = json!({"include_usage": true});
            }
            body
        }
    }
}

/// Provider-neutral meaning of one SSE event, extracted so both stream
/// consumers share a single decode path while keeping their own buffering /
/// emit / meta-filter control flow.
#[derive(Debug, PartialEq)]
enum StreamAction {
    /// A text delta to append/emit.
    Delta(String),
    /// The stream finished cleanly.
    Stop,
    /// The provider signalled an in-stream error; carries the message.
    Error(String),
    /// Bookkeeping event (usage, ping, …) — nothing for the consumer to do.
    Ignore,
}

/// Decode one SSE event into a `StreamAction`, feeding usage / stop_reason
/// into `guard` as a side effect. Anthropic uses named events; OpenAI sends
/// unnamed `data:` chunks (surfaced by eventsource_stream with the default
/// event name), a `[DONE]` sentinel, and — with include_usage — a final
/// usage-only chunk whose `choices` array is empty. OpenAI's
/// `finish_reason:"length"` is normalized to Anthropic's `max_tokens` so the
/// existing truncation checks work for both providers.
fn parse_stream_event(
    provider: Provider,
    event_name: &str,
    data: &str,
    guard: &mut TraceGuard,
) -> StreamAction {
    match provider {
        Provider::Anthropic => match event_name {
            "message_start" => {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    guard.absorb_message_start(&parsed);
                }
                StreamAction::Ignore
            }
            "message_delta" => {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    guard.absorb_message_delta(&parsed);
                }
                StreamAction::Ignore
            }
            "content_block_delta" => {
                let delta = serde_json::from_str::<Value>(data).ok().and_then(|parsed| {
                    parsed
                        .get("delta")
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                });
                match delta {
                    Some(text) => StreamAction::Delta(text),
                    None => StreamAction::Ignore,
                }
            }
            "message_stop" => StreamAction::Stop,
            "error" => StreamAction::Error(format!("anthropic stream error: {data}")),
            _ => StreamAction::Ignore,
        },
        Provider::OpenAi => {
            if data.trim() == "[DONE]" {
                return StreamAction::Stop;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                return StreamAction::Ignore;
            };
            if parsed.get("error").is_some() {
                return StreamAction::Error(format!("openai stream error: {data}"));
            }
            if let Some(usage) = parsed.get("usage").filter(|u| !u.is_null()) {
                guard.absorb_openai_usage(usage);
            }
            let choice = parsed.get("choices").and_then(|c| c.get(0));
            if let Some(fr) = choice
                .and_then(|c| c.get("finish_reason"))
                .and_then(|v| v.as_str())
            {
                guard.stop_reason = Some(if fr == "length" {
                    "max_tokens".to_string()
                } else {
                    fr.to_string()
                });
            }
            let delta = choice
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|t| t.as_str())
                .filter(|t| !t.is_empty());
            match delta {
                Some(text) => StreamAction::Delta(text.to_string()),
                None => StreamAction::Ignore,
            }
        }
    }
}

const SYSTEM_TEMPLATE: &str = include_str!("../prompts/translate_system.txt");


/// Wrap the source text with the most recent (source, translated) pairs for
/// this target, so Claude has pronoun + term continuity. The context source
/// line is labeled with the source language code (`zh:` / `ja:` …). Empty
/// context returns the text unchanged so we don't pay tokens for a useless
/// wrapper.
fn build_user_message(
    text: &str,
    source_label: &str,
    lang_label: &str,
    history: &VecDeque<(f64, String, String)>,
) -> String {
    if history.is_empty() {
        return text.to_string();
    }
    let mut s = String::from("<context>\n");
    for (_, src, tgt) in history {
        s.push_str(source_label);
        s.push_str(": ");
        s.push_str(src);
        s.push('\n');
        s.push_str(lang_label);
        s.push_str(": ");
        s.push_str(tgt);
        s.push_str("\n\n");
    }
    s.push_str("</context>\n\n");
    s.push_str(text);
    s
}

/// Full target-language name for the system prompt's `{lang}` slot, from the
/// registry. `None` for an unknown target — the caller turns that into a hard
/// error before any API call rather than silently defaulting to English.
fn target_lang_name(target: &str) -> Option<&'static str> {
    languages::get(target).map(|l| l.prompt_name.as_str())
}

// Buffer this many chars before deciding whether the response is a meta-leak
// and starting to emit. Smaller = lower first-token latency, especially for
// short utterances whose entire translation is under the buffer (in which case
// the user previously only saw text after the stream finished — defeating
// streaming). 32 covers the longest marker ("based on the specific rule",
// "please provide the chinese" = 26 chars) with a small safety margin and
// cuts ~50 chars / ~200ms of perceived latency vs. the old 80.
const META_SCAN_CHARS: usize = 32;
/// Substrings that almost never appear in legit meeting translations but do
/// appear when Claude breaks character to comment on the input. Match anywhere
/// in the first META_SCAN_CHARS characters (case-insensitive).
/// 與 prototype/eval/checks.py META_MARKERS 同步；改任一邊要同步另一邊。
const META_MARKERS: &[&str] = &[
    // English meta
    "per the rules",
    "following rule",
    "based on the specific rule",
    "based on the rule",
    "the rules provided",
    "appears to be incomplete",
    "appears to be garbled",
    "appears to be gibberish",
    "appears to be corrupted",
    "this input appears",
    "this input contains",
    "this input doesn't",
    "this input seems",
    "outputting an empty",
    "outputting empty",
    "empty response",
    "empty string",
    "i'm outputting",
    "i'll output",
    "i'd be happy",
    "i appreciate you",
    "i cannot translate",
    "i'm unable to translate",
    "could you provide",
    "could you clarify",
    "please provide the chinese",
    "please provide actual",
    "doesn't form coherent",
    "don't form coherent",
    "garbled or incomplete",
    "incomplete fragments",
    // Vietnamese meta
    "vui lòng cung cấp",
    "tôi không thể dịch",
    "tôi xin lỗi nhưng tôi",
    // Chinese meta (Claude responding in Chinese instead of target lang)
    "明白，我",
    "請提供",
    "我無法翻譯",
    "我没法翻译",
    "空字串",
    "空字符串",
    // Japanese meta (Claude breaking character for a ja target). Deliberately
    // NO bare 「申し訳ありません」 — a Chinese source often opens with an apology
    // that legitimately translates to that phrase, so matching it would drop
    // real translations.
    "翻訳できません",
    "翻訳することができません",
    "翻訳いたしかねます",
    "翻訳者として",
    "通訳者として",
    "テキストを提供してください",
    "テキストをご提供",
    "有効なテキストを提供",
    "空の文字列を出力",
    "入力が不完全",
    "この入力は不完全",
    "文字化けして",
    "意味を成していない",
];

/// Detect when Claude breaks character and meta-comments instead of translating.
/// Scan the first META_SCAN_CHARS characters for any blocklist substring.
fn is_meta_prefix(buffer: &str) -> bool {
    let head: String = buffer
        .trim_start()
        .to_lowercase()
        .chars()
        .take(META_SCAN_CHARS)
        .collect();
    META_MARKERS.iter().any(|m| head.contains(m))
}

/// Outcome of draining one translation SSE stream.
enum StreamOutcome {
    /// Stream finished cleanly. `full_text` includes the buffered meta-scan
    /// prefix; `is_meta` is set when the response was dropped as a meta-leak.
    Completed { full_text: String, is_meta: bool },
    /// Stream broke mid-flight (transport error or an `error` SSE event).
    /// `partial_emitted` records whether any chunk already reached the UI.
    Broken { partial_emitted: bool, err: String },
}

/// Drain one translation SSE stream: run the meta-scan buffer, emit
/// `translation:chunk` deltas, accumulate the full text, and feed usage /
/// stop_reason / ttft into `guard`. Returns `Completed` on a clean finish or
/// `Broken` the moment the connection errors — the caller decides whether to
/// retry non-streaming.
async fn consume_translation_stream(
    resp: Response,
    app: &AppHandle,
    chunk_event: &str,
    id: &str,
    target: &str,
    provider: Provider,
    guard: &mut TraceGuard,
) -> StreamOutcome {
    let mut stream = resp.bytes_stream().eventsource();

    // Buffer the first META_SCAN_CHARS chars before emitting anything. If those
    // leading chars match a meta-response blocklist (Claude breaking character
    // on garbage input), drop the entire stream silently.
    let mut buffer = String::new();
    let mut decided = false;
    let mut is_meta = false;
    // Accumulate the full translation so the caller can write it back into the
    // rolling context. Includes the buffered prefix.
    let mut full_translation = String::new();
    let mut emitted_any = false;

    while let Some(event) = stream.next().await {
        match event {
            Ok(ev) => match parse_stream_event(provider, ev.event.as_str(), &ev.data, guard) {
                StreamAction::Delta(delta) => {
                    guard.mark_ttft();
                    if decided {
                        full_translation.push_str(&delta);
                        if !is_meta {
                            emitted_any = true;
                            let _ = app.emit(
                                chunk_event,
                                ChunkPayload { id: id.to_string(), text: delta },
                            );
                        }
                    } else {
                        buffer.push_str(&delta);
                        if buffer.chars().count() >= META_SCAN_CHARS {
                            decided = true;
                            is_meta = is_meta_prefix(&buffer);
                            if is_meta {
                                errors::record(
                                    "translation_meta_filtered",
                                    &buffer.chars().take(80).collect::<String>(),
                                    Some(serde_json::json!({ "target": target, "id": id })),
                                );
                            } else {
                                full_translation.push_str(&buffer);
                                emitted_any = true;
                                let _ = app.emit(
                                    chunk_event,
                                    ChunkPayload { id: id.to_string(), text: buffer.clone() },
                                );
                            }
                        }
                    }
                }
                StreamAction::Stop => break,
                StreamAction::Error(err) => {
                    return StreamOutcome::Broken {
                        partial_emitted: emitted_any,
                        err,
                    };
                }
                StreamAction::Ignore => {}
            },
            Err(e) => {
                return StreamOutcome::Broken {
                    partial_emitted: emitted_any,
                    err: format!("sse stream: {e}"),
                };
            }
        }
    }

    // Stream ended before buffer threshold — apply check anyway and flush.
    if !decided && !buffer.is_empty() {
        is_meta = is_meta_prefix(&buffer);
        if is_meta {
            errors::record(
                "translation_meta_filtered",
                &buffer,
                Some(serde_json::json!({ "target": target, "id": id })),
            );
        } else {
            full_translation.push_str(&buffer);
            let _ = app.emit(
                chunk_event,
                ChunkPayload { id: id.to_string(), text: buffer.clone() },
            );
        }
    }

    StreamOutcome::Completed { full_text: full_translation, is_meta }
}

/// Single non-streaming re-issue of a translate request after the SSE stream
/// broke. Reuses `body` with `stream:false` (dropping `stream_options`, which
/// OpenAI rejects on non-streaming calls), sends it once through the shared
/// client (no retry loop — that already ran on the original streaming call),
/// and folds usage / stop_reason into `guard` (bumping the retry count).
async fn translate_once_nonstreaming(
    provider: Provider,
    api_key: &str,
    body: &Value,
    guard: &mut TraceGuard,
) -> Result<String, String> {
    guard.retries += 1;
    let mut nb = body.clone();
    nb["stream"] = Value::Bool(false);
    if let Some(obj) = nb.as_object_mut() {
        obj.remove("stream_options");
    }
    let resp = apply_auth(http_client().post(provider.url()), provider, api_key)
        .header("content-type", "application/json")
        .json(&nb)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("{} {status}: {body_text}", provider.label()));
    }
    let parsed: Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    match provider {
        Provider::Anthropic => {
            if let Some(usage) = parsed.get("usage") {
                guard.input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64());
                guard.output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64());
                guard.cache_creation_input_tokens =
                    usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64());
                guard.cache_read_input_tokens =
                    usage.get("cache_read_input_tokens").and_then(|v| v.as_u64());
            }
            if let Some(sr) = parsed.get("stop_reason").and_then(|v| v.as_str()) {
                guard.stop_reason = Some(sr.to_string());
            }
            let text = parsed
                .get("content")
                .and_then(|c| c.get(0))
                .and_then(|b| b.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Ok(text)
        }
        Provider::OpenAi => {
            if let Some(usage) = parsed.get("usage") {
                guard.absorb_openai_usage(usage);
            }
            let choice = parsed.get("choices").and_then(|c| c.get(0));
            if let Some(fr) = choice
                .and_then(|c| c.get("finish_reason"))
                .and_then(|v| v.as_str())
            {
                guard.stop_reason = Some(if fr == "length" {
                    "max_tokens".to_string()
                } else {
                    fr.to_string()
                });
            }
            let text = choice
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Ok(text)
        }
    }
}

#[tauri::command]
pub async fn translate(
    app: AppHandle,
    config: tauri::State<'_, SharedConfig>,
    ctx: tauri::State<'_, TranslationContext>,
    id: String,
    text: String,
    target: String,
) -> Result<(), String> {
    let (provider, api_key, model, source_code, glossary_block, glossary_entries) = {
        let cfg = config.lock().await;
        // Only feed glossary entries into the observe-only check when the active
        // book applies to the current source language (empty otherwise).
        let glossary_entries = if cfg.glossary_applies() {
            cfg.active_entries().to_vec()
        } else {
            Vec::new()
        };
        let provider = Provider::from_config(&cfg.api.provider);
        let (api_key, model) = match provider {
            Provider::Anthropic => (cfg.api.anthropic_api_key.clone(), cfg.api.model.clone()),
            Provider::OpenAi => (cfg.api.openai_api_key.clone(), cfg.api.openai_model.clone()),
        };
        (
            provider,
            api_key,
            model,
            cfg.language.source.clone(),
            cfg.render_glossary_section(&target),
            glossary_entries,
        )
    };
    if api_key.is_empty() {
        return Err(match provider {
            Provider::Anthropic => "Anthropic API key not configured (open Settings)".into(),
            Provider::OpenAi => "OpenAI API key not configured (open Settings)".into(),
        });
    }
    // Reject an unknown target before spending a single token — this replaces
    // the old silent English fallback.
    let Some(target_name) = target_lang_name(&target) else {
        return Err(format!("invalid target: {target}"));
    };
    // Source-language name for the prompt's {source_lang} slot. The config
    // source is registry-valid post-sanitize; "中文" is a defensive fallback.
    let source_name = languages::get(&source_code)
        .map(|l| l.zh_ui_name.as_str())
        .unwrap_or("中文");

    let history_snapshot: VecDeque<(f64, String, String)> = {
        let map = ctx.lock().await;
        map.get(&target).cloned().unwrap_or_default()
    };
    let user_message = build_user_message(&text, &source_code, &target, &history_snapshot);

    let system = SYSTEM_TEMPLATE
        .replace("{source_lang}", source_name)
        .replace("{lang}", target_name)
        .replace("{glossary_section}", &glossary_block);
    let body = build_chat_body(provider, &model, &system, &user_message, 1024, true);

    let mut guard = TraceGuard::new("translate", id.clone(), target.clone(), model.clone());
    let resp = match post_llm_with_retry(provider, &api_key, &body, &mut guard.retries).await {
        Ok(r) => r,
        Err(msg) => {
            errors::record(
                "translation_api",
                &msg,
                Some(serde_json::json!({
                    "target": target,
                    "id": id,
                    "text_excerpt": text.chars().take(60).collect::<String>(),
                })),
            );
            return Err(msg);
        }
    };

    let chunk_event = format!("translation:chunk:{}", target);
    let done_event = format!("translation:done:{}", target);
    let replace_event = format!("translation:replace:{}", target);

    let (full_text, is_meta) =
        match consume_translation_stream(resp, &app, &chunk_event, &id, &target, provider, &mut guard).await {
            StreamOutcome::Completed { full_text, is_meta } => (full_text, is_meta),
            StreamOutcome::Broken { partial_emitted, err } => {
                // The connection dropped mid-stream but the request was accepted.
                // Retry once WITHOUT streaming, then replace whatever partial the
                // UI already showed with the complete text.
                match translate_once_nonstreaming(provider, &api_key, &body, &mut guard).await {
                    Ok(text) => {
                        let _ = app.emit(
                            &replace_event,
                            ChunkPayload { id: id.clone(), text: text.clone() },
                        );
                        (text, false)
                    }
                    Err(e2) => {
                        errors::record(
                            "translation_stream_broken",
                            &format!("stream broke: {err}; non-streaming retry failed: {e2}"),
                            Some(serde_json::json!({
                                "target": target,
                                "id": id,
                                "partial_emitted": partial_emitted,
                            })),
                        );
                        return Err(e2);
                    }
                }
            }
        };

    // Language guard: the 32-char meta prefix filter can't catch a full reply
    // that stayed in Chinese for an en/vi target. Re-check the whole text; if it
    // reads as Chinese, clear the chunks already on screen with an empty
    // `replace` and treat the utterance as filtered — same delivered-empty
    // semantics as the meta filter, just decided after the stream completed.
    let wrong_lang = !is_meta && verify::wrong_language(&full_text, &target);
    if wrong_lang {
        let _ = app.emit(
            &replace_event,
            ChunkPayload { id: id.clone(), text: String::new() },
        );
        errors::record(
            "translation_wrong_language",
            &full_text.chars().take(80).collect::<String>(),
            Some(serde_json::json!({ "target": target, "id": id })),
        );
    }

    let _ = app.emit(&done_event, DonePayload { id: id.clone() });

    // The translation is still delivered above even when truncated — just log
    // it so a systematically-too-low max_tokens shows up in the error record.
    if guard.stop_reason.as_deref() == Some("max_tokens") {
        errors::record(
            "translation_truncated",
            "translation output hit max_tokens",
            Some(serde_json::json!({ "target": target, "id": id })),
        );
    }

    // Write back to the rolling context so the next translate call for this
    // target sees this pair as recent context. Skip if filtered as meta or
    // if the model returned an empty string (e.g. hallucination per rule 6).
    let final_text = full_text.trim().to_string();
    guard.outcome = if is_meta || wrong_lang {
        "filtered"
    } else if final_text.is_empty() {
        "empty"
    } else {
        "ok"
    };
    if !is_meta && !wrong_lang && !final_text.is_empty() {
        // Observe-only glossary check: log any glossary term present in the
        // source whose required target translation is missing from the output.
        // Never blocks or retranslates — the delivered text stands.
        let violations = verify::check_glossary(&text, &final_text, &glossary_entries, &target);
        if !violations.is_empty() {
            errors::record(
                "glossary_violation",
                &violations.join("; "),
                Some(serde_json::json!({ "id": id, "target": target })),
            );
            guard.glossary_violations = Some(violations);
        }

        let mut map = ctx.lock().await;
        let entry = map.entry(target.clone()).or_insert_with(VecDeque::new);
        // Insert ordered by t_start (the id is the stringified t_start). On an
        // unparseable id, treat this entry as newest. Trimming from the front
        // keeps the most recent CONTEXT_PAIRS — and if this entry is older than
        // everything already kept in a full deque, the insert-then-trim drops
        // it right back off, so stale late arrivals don't evict fresher context.
        let t_start = id
            .parse::<f64>()
            .unwrap_or_else(|_| entry.back().map(|(k, _, _)| k + 1.0).unwrap_or(0.0));
        let pos = entry
            .iter()
            .position(|(k, _, _)| *k > t_start)
            .unwrap_or(entry.len());
        entry.insert(pos, (t_start, text.clone(), final_text));
        while entry.len() > CONTEXT_PAIRS {
            entry.pop_front();
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct SummaryChunk {
    session_id: String,
    target: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct SummaryDone {
    session_id: String,
    target: String,
    path: String,
}

/// Per (template, target) section heading list. Section count varies by
/// template (4–6) so we return a Vec rather than a fixed-size array. The
/// headings show up verbatim as `## {heading}` in the model's output.
fn template_headings(template: &str, target: &str) -> Option<Vec<&'static str>> {
    match (template, target) {
        ("exec_brief", "zh") => Some(vec!["摘要", "決議事項", "Action items", "待澄清議題"]),
        ("exec_brief", "en") => Some(vec!["Summary", "Decisions", "Action Items", "Open Questions"]),
        ("exec_brief", "ja") => Some(vec!["概要", "決定事項", "アクションアイテム", "未解決の課題"]),
        ("exec_brief", "vi") => Some(vec!["Tóm tắt", "Quyết định", "Hành động", "Vấn đề chưa rõ"]),

        ("minutes", "zh") => Some(vec!["與會者", "議題清單", "討論摘要", "決議事項", "行動方案", "後續事項"]),
        ("minutes", "en") => Some(vec!["Attendees", "Agenda", "Discussion", "Decisions", "Action Items", "Follow-up"]),
        ("minutes", "ja") => Some(vec!["出席者", "アジェンダ", "討議内容", "決定事項", "アクションアイテム", "フォローアップ"]),
        ("minutes", "vi") => Some(vec!["Người tham dự", "Chương trình", "Thảo luận", "Quyết định", "Hành động", "Theo dõi"]),

        ("discussion", "zh") => Some(vec!["議題背景", "主題與觀點", "共識點", "分歧點", "待驗證假設", "Parking Lot"]),
        ("discussion", "en") => Some(vec!["Topic Background", "Themes and Perspectives", "Points of Agreement", "Points of Divergence", "Open Hypotheses", "Parking Lot"]),
        ("discussion", "ja") => Some(vec!["背景", "テーマと見解", "合意点", "相違点", "検証すべき仮説", "Parking Lot"]),
        ("discussion", "vi") => Some(vec!["Bối cảnh", "Chủ đề và quan điểm", "Đồng thuận", "Khác biệt", "Giả định cần xác nhận", "Để dành sau"]),

        ("decision_log", "zh") => Some(vec!["待決策問題", "候選方案", "論點與反論", "最終決定", "未採納方案的理由", "風險與假設"]),
        ("decision_log", "en") => Some(vec!["Decision Question", "Options Considered", "Arguments For and Against", "Decision", "Why Other Options Were Rejected", "Risks and Assumptions"]),
        ("decision_log", "ja") => Some(vec!["決定すべき課題", "選択肢", "賛成論と反対論", "最終決定", "不採用の理由", "リスクと前提"]),
        ("decision_log", "vi") => Some(vec!["Vấn đề cần quyết định", "Phương án", "Lập luận ủng hộ và phản đối", "Quyết định cuối cùng", "Lý do từ chối phương án khác", "Rủi ro và giả định"]),

        ("client_call", "zh") => Some(vec!["客戶情境", "需求與反對意見", "我方承諾", "Champion / Blocker", "Next Steps", "BANT 訊號"]),
        ("client_call", "en") => Some(vec!["Client Context", "Needs and Objections", "Our Commitments", "Champion / Blocker", "Next Steps", "BANT Signals"]),
        ("client_call", "ja") => Some(vec!["顧客の状況", "ニーズと懸念", "当方のコミットメント", "Champion / Blocker", "Next Steps", "BANTシグナル"]),
        ("client_call", "vi") => Some(vec!["Bối cảnh khách hàng", "Nhu cầu và phản đối", "Cam kết của chúng tôi", "Champion / Blocker", "Bước tiếp theo", "Tín hiệu BANT"]),

        _ => None,
    }
}

/// Template-specific section rules. Appended after the shared base rules in
/// the system prompt — these tell the model what each H2 section should
/// actually contain (sentence vs. bullet list, what to do when info is
/// missing, etc.). Written in zh because the model's instructions are
/// language-agnostic; only the *output* needs to match the target lang.
fn template_section_rules(template: &str) -> Option<&'static str> {
    match template {
        "exec_brief" => Some(
            "\n各段落要求：\n\
            - 第 1 段（摘要）：3–5 句陳述會議要點，連續散文不要列點\n\
            - 第 2 段（決議事項）：bullet list；沒有則寫「（無）」/「(none)」/「(không có)」/「（なし）」\n\
            - 第 3 段（Action items）：`- [ ] 任務 — 負責人（期限）`；資訊缺漏寫「未明」\n\
            - 第 4 段（待澄清議題）：bullet list；沒有則寫「（無）」/「（なし）」"
        ),
        "minutes" => Some(
            "\n各段落要求：\n\
            - 與會者：從逐字稿可識別的稱謂列點；無法識別整段寫「（未明確識別）」\n\
            - 議題清單：bullet list 列出本次討論到的所有主題\n\
            - 討論摘要：依時間先後段落式撰寫，每議題 2–4 句\n\
            - 決議事項：bullet list 明確達成的決議\n\
            - 行動方案：`- [ ] 任務 — 負責人（期限）`，缺漏寫「未明」\n\
            - 後續事項：未結論議題、待安排會議、需追蹤事項\n\
            - 全文偏正式語調、第三人稱、保留時間順序"
        ),
        "discussion" => Some(
            "\n各段落要求：\n\
            - 議題背景：1–2 段描述會議起因與探討範圍\n\
            - 主題與觀點：bullet 分組，每組以小標題開始，列出該主題下所有提出的觀點；可識別發言者則標註「（提出：XX）」\n\
            - 共識點：bullet list；沒有則寫「（無）」\n\
            - 分歧點：bullet list 描述對立觀點與各自理由\n\
            - 待驗證假設：bullet list 列出需要更多資訊才能確認的假設\n\
            - Parking Lot：值得記下但這次未深入的支線\n\
            - 不要強求結論，保留多元觀點"
        ),
        "decision_log" => Some(
            "\n各段落要求：\n\
            - 待決策問題：1 段清楚描述問題框架\n\
            - 候選方案：每方案一個 bullet，含名稱 + 一句描述\n\
            - 論點與反論：每方案標題下分「支持」與「反對」兩組子 bullet\n\
            - 最終決定：明確說明選了哪個方案、為什麼\n\
            - 未採納方案的理由：每未採納方案一個 bullet；逐字稿未明說則從脈絡推理並標註「（推論）」\n\
            - 風險與假設：bullet list 列出已知風險與決策依據的假設\n\
            - 因果鏈要清楚、tradeoffs 要顯性"
        ),
        "client_call" => Some(
            "\n各段落要求：\n\
            - 客戶情境：1–2 段描述客戶現況與痛點\n\
            - 需求與反對意見：bullet list，每點前綴「需求：」或「反對：」\n\
            - 我方承諾：bullet list 條列明確答應的事項\n\
            - Champion / Blocker：bullet 標註對話中支持與反對推進的人；沒提到寫「未識別」\n\
            - Next Steps：`- [ ] 任務 — 負責人（期限）`\n\
            - BANT 訊號：四個 sub-bullet（預算 / 決策權 / 需求 / 時程），各寫對話中提到的訊號或「未提及」\n\
            - 客戶為中心、CRM 友善的條目化"
        ),
        _ => None,
    }
}

fn build_summary_system(
    target_label: &str,
    source_label: &str,
    headings: &[&str],
    section_rules: &str,
    glossary_block: &str,
) -> String {
    let heading_block = headings
        .iter()
        .map(|h| format!("   ## {h}"))
        .collect::<Vec<_>>()
        .join("\n");
    let n = headings.len();
    format!(
        "你是專業會議分析師。根據使用者提供的{source_label}會議逐字稿，輸出結構化會議總結。\n\
\n\
共通規則：\n\
1. 整份輸出以 {target_label} 撰寫（除人名、公司名、產品名等專有名詞保留原文）\n\
2. Markdown 格式，僅包含以下 {n} 個 H2 段落，順序固定：\n\
{heading_block}\n\
3. 不要編造逐字稿沒有的資訊、不要寫開場或結尾客套\n\
4. 不要直接複製逐字稿原文進總結\
{section_rules}{glossary_block}"
    )
}

/// Slide-outline template uses a *variable* number of H2 sections
/// (one per slide, 6–10 total) instead of a fixed list — so it bypasses
/// the heading-list scaffolding in `build_summary_system` and gets its
/// own prompt.
fn build_slide_outline_system(
    target_label: &str,
    source_label: &str,
    target: &str,
    glossary_block: &str,
) -> String {
    let (cover, agenda, decisions, next_steps) = match target {
        "en" => ("Cover", "Agenda", "Decisions & Action Items", "Next Steps"),
        "ja" => ("表紙", "アジェンダ", "決定事項・アクションアイテム", "次のステップ"),
        "vi" => ("Trang bìa", "Chương trình", "Quyết định & Hành động", "Bước tiếp theo"),
        _ => ("封面", "議程", "決議與 Action Items", "Next Steps"),
    };
    format!(
        "你是專業會議分析師。將{source_label}會議逐字稿轉成投影片大綱，輸出格式可直接餵給 AI 簡報生成工具（ChatGPT / Gemini Slides / Claude 等）一鍵產生 PowerPoint / Google Slides。\n\
\n\
規則：\n\
1. 整份輸出以 {target_label} 撰寫（除人名、公司名、產品名等專有名詞保留原文）\n\
2. Markdown 格式，由多張投影片組成；每張投影片以 `## Slide N: 標題` 起頭（N 從 1 開始連續編號，標題不超過 12 字）\n\
3. 每張投影片 3–5 個 bullet 重點，每個 bullet 以 `-` 開頭、5–15 字，精簡如投影片用語\n\
4. 不要寫散文、不要長句、不要解釋；保留人名 / 公司名 / 產品名 / 數據 / 期限\n\
5. 投影片總數 6–10 張，依逐字稿內容多寡決定（議題少就少張，不要硬湊）\n\
6. 投影片結構（順序固定）：\n\
   - Slide 1（{cover}）：會議主題、日期、參與方；資訊不明寫「（未明）」\n\
   - Slide 2（{agenda}）：本次討論的主要議題列表\n\
   - Slide 3 到 N-2：各主議題一張，標題清楚、bullet 列出該議題的關鍵討論點與數據\n\
   - Slide N-1（{decisions}）：本次明確達成的決議與 Action items（Action items 用 `- [ ] 任務 — 負責人（期限）` 格式）\n\
   - Slide N（{next_steps}）：後續行動、下次會議或追蹤事項\n\
7. 每張投影片後可選加 `### Speaker Notes`（1–2 句口頭補充細節給簡報者）；沒必要可省略，不要每張都硬寫\n\
8. 不要編造逐字稿沒有的資訊、不要寫開場或結尾客套{glossary_block}"
    )
}

/// Outcome of draining one summary SSE stream.
enum SummaryStreamOutcome {
    /// Stream finished cleanly with the full accumulated markdown.
    Completed(String),
    /// Stream broke mid-flight; carries the error message.
    Broken(String),
}

/// Drain one summary SSE stream: emit `summary:chunk` deltas, accumulate the
/// full markdown, and feed usage / stop_reason / ttft into `guard`.
async fn consume_summary_stream(
    resp: Response,
    app: &AppHandle,
    session_id: &str,
    target: &str,
    provider: Provider,
    guard: &mut TraceGuard,
) -> SummaryStreamOutcome {
    let mut stream = resp.bytes_stream().eventsource();
    let mut full = String::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(ev) => match parse_stream_event(provider, ev.event.as_str(), &ev.data, guard) {
                StreamAction::Delta(delta) => {
                    guard.mark_ttft();
                    full.push_str(&delta);
                    let _ = app.emit(
                        "summary:chunk",
                        SummaryChunk {
                            session_id: session_id.to_string(),
                            target: target.to_string(),
                            text: delta,
                        },
                    );
                }
                StreamAction::Stop => break,
                StreamAction::Error(err) => {
                    return SummaryStreamOutcome::Broken(err);
                }
                StreamAction::Ignore => {}
            },
            Err(e) => {
                return SummaryStreamOutcome::Broken(format!("sse stream: {e}"));
            }
        }
    }
    SummaryStreamOutcome::Completed(full)
}

/// Stream a structured meeting summary for one session/target. Reads the
/// session's zh transcript, calls the configured summary model, emits
/// `summary:chunk` events as text streams in, then writes the full markdown
/// to `summary.{target}.md` in the session directory before emitting
/// `summary:done`. On a mid-stream break, retries once (emitting
/// `summary:restart` so the UI clears its partial buffer). On failure, emits
/// `summary:error` and returns Err.
#[tauri::command]
pub async fn generate_summary(
    app: AppHandle,
    config: tauri::State<'_, SharedConfig>,
    session_id: String,
    target: String,
    template: Option<String>,
) -> Result<(), String> {
    let template = template.unwrap_or_else(|| "exec_brief".into());
    // Target-language label = registry native_name (日本語 / English / …).
    // Byte-compatible with the old target_lang_label for zh/en/vi; unknown
    // targets still hit the invalid-target error path below.
    let Some(target_label) = languages::get(&target).map(|l| l.native_name.as_str()) else {
        return Err(format!("invalid target: {target}"));
    };

    // Glossary block + the meeting's source language, read under one lock. The
    // glossary maps a source term to its target translation, so a source→source
    // "translation" is the identity and adds nothing — skip injection whenever
    // the target equals the meeting source (the common zh-meeting→zh-summary
    // case). For a differing target the block forces the model to render proper
    // nouns the same way the live-translation path does, keeping summary and
    // chunked translation in sync. render_glossary_section itself returns ""
    // when the active book doesn't apply to the current source language.
    let (glossary_block, source_code) = {
        let cfg = config.lock().await;
        let source_code = cfg.language.source.clone();
        let block = if !cfg.glossary_applies() || target == source_code {
            String::new()
        } else {
            cfg.render_glossary_section(&target)
        };
        (block, source_code)
    };
    // Source-language label = registry zh_ui_name (中文 / 英文 / 日文 / 越南文);
    // the config source is registry-valid post-sanitize, "中文" is a defensive
    // fallback (and keeps the zh-source prompt byte-identical to the old one).
    let source_label = languages::get(&source_code)
        .map(|l| l.zh_ui_name.as_str())
        .unwrap_or("中文");

    // Slide outline has a variable number of slides — bypass the fixed-
    // heading scaffolding entirely. All other templates fall through to
    // the headings/section_rules path.
    let system = if template == "slide_outline" {
        build_slide_outline_system(target_label, source_label, &target, &glossary_block)
    } else {
        let Some(headings) = template_headings(&template, &target) else {
            return Err(format!("invalid template: {template}"));
        };
        let Some(section_rules) = template_section_rules(&template) else {
            return Err(format!("invalid template: {template}"));
        };
        build_summary_system(target_label, source_label, &headings, section_rules, &glossary_block)
    };

    let utterances = session::read_transcript(&session_id)?;
    let meta = session::read_meta(&session_id)?;

    let transcript_lines: Vec<String> = utterances
        .iter()
        .filter(|u| !u.src.trim().is_empty())
        .map(|u| u.src.trim().to_string())
        .collect();
    if transcript_lines.is_empty() {
        return Err("這場會議沒有可總結的逐字稿".into());
    }
    let transcript_body = transcript_lines.join("\n");
    // Guard against a single Sonnet call on an unreasonably long transcript —
    // both a cost and a context-window risk. 150k chars is well beyond any
    // real meeting we support one-shot.
    if transcript_body.chars().count() > 150_000 {
        let msg = "逐字稿過長（超過 15 萬字），暫不支援單次總結".to_string();
        let _ = app.emit(
            "summary:error",
            json!({ "session_id": session_id, "target": target, "message": msg.clone() }),
        );
        return Err(msg);
    }
    let duration_min = (meta.duration_secs as f64 / 60.0).ceil() as u64;

    let (provider, api_key, summary_model) = {
        let cfg = config.lock().await;
        let provider = Provider::from_config(&cfg.api.provider);
        let (api_key, summary_model) = match provider {
            Provider::Anthropic => {
                (cfg.api.anthropic_api_key.clone(), cfg.api.summary_model.clone())
            }
            Provider::OpenAi => {
                (cfg.api.openai_api_key.clone(), cfg.api.openai_summary_model.clone())
            }
        };
        (provider, api_key, summary_model)
    };
    if api_key.is_empty() {
        return Err(match provider {
            Provider::Anthropic => "Anthropic API key not configured (open Settings)".into(),
            Provider::OpenAi => "OpenAI API key not configured (open Settings)".into(),
        });
    }

    let user_text = format!(
        "以下是 {duration_min} 分鐘的會議逐字稿（{source_label}）：\n\n---\n{transcript_body}\n---\n\n請輸出 {target_label} 的會議總結。"
    );

    let body = build_chat_body(provider, &summary_model, &system, &user_text, 4096, true);

    let mut guard = TraceGuard::new(
        "summary",
        session_id.clone(),
        target.clone(),
        summary_model.clone(),
    );
    let resp = match post_llm_with_retry(provider, &api_key, &body, &mut guard.retries).await {
        Ok(r) => r,
        Err(msg) => {
            errors::record(
                "summary_api",
                &msg,
                Some(json!({ "target": target, "session_id": session_id })),
            );
            let _ = app.emit(
                "summary:error",
                json!({ "session_id": session_id, "target": target, "message": msg.clone() }),
            );
            return Err(msg);
        }
    };

    let full = match consume_summary_stream(resp, &app, &session_id, &target, provider, &mut guard).await {
        SummaryStreamOutcome::Completed(full) => full,
        SummaryStreamOutcome::Broken(err) => {
            // The stream dropped mid-summary. Tell the UI to clear the partial
            // it accumulated, then re-issue ONCE as a fresh stream so the new
            // chunks don't append onto stale text.
            let _ = app.emit(
                "summary:restart",
                json!({ "session_id": session_id, "target": target }),
            );
            let mut retry_attempts: u32 = 0;
            match post_llm_with_retry(provider, &api_key, &body, &mut retry_attempts).await {
                Ok(resp2) => {
                    guard.retries += 1 + retry_attempts;
                    match consume_summary_stream(resp2, &app, &session_id, &target, provider, &mut guard).await
                    {
                        SummaryStreamOutcome::Completed(full) => full,
                        SummaryStreamOutcome::Broken(err2) => {
                            errors::record(
                                "summary_stream_broken",
                                &format!("stream broke: {err}; re-stream failed: {err2}"),
                                Some(json!({ "session_id": session_id, "target": target })),
                            );
                            let _ = app.emit(
                                "summary:error",
                                json!({ "session_id": session_id, "target": target, "message": err2.clone() }),
                            );
                            return Err(err2);
                        }
                    }
                }
                Err(e2) => {
                    guard.retries += 1 + retry_attempts;
                    errors::record(
                        "summary_stream_broken",
                        &format!("stream broke: {err}; re-post failed: {e2}"),
                        Some(json!({ "session_id": session_id, "target": target })),
                    );
                    let _ = app.emit(
                        "summary:error",
                        json!({ "session_id": session_id, "target": target, "message": e2.clone() }),
                    );
                    return Err(e2);
                }
            }
        }
    };

    if full.trim().is_empty() {
        guard.outcome = "empty";
        let msg = "模型回傳空內容".to_string();
        let _ = app.emit(
            "summary:error",
            json!({ "session_id": session_id, "target": target, "message": msg }),
        );
        return Err(msg);
    }

    // Deterministic structure check (pure string logic — no extra LLM call).
    // Heading templates must carry every expected H2 in order; slide_outline
    // must land in the supported slide count. Findings are non-fatal — we still
    // write whatever streamed — but surfaced via `summary:verify` + error log so
    // the user knows the summary may be incomplete.
    let structure_issues: Vec<String> = if template == "slide_outline" {
        verify::check_slide_outline(&full).into_iter().collect()
    } else if let Some(headings) = template_headings(&template, &target) {
        let expected: Vec<String> = headings.iter().map(|h| h.to_string()).collect();
        verify::check_summary_structure(&expected, &full)
    } else {
        Vec::new()
    };
    if !structure_issues.is_empty() {
        errors::record(
            "summary_structure",
            &structure_issues.join("; "),
            Some(json!({ "session_id": session_id, "target": target })),
        );
        let _ = app.emit(
            "summary:verify",
            json!({ "session_id": session_id, "target": target, "issues": structure_issues }),
        );
    }

    let path = session::session_dir(&session_id).join(format!("summary.{target}.md"));
    if let Err(e) = std::fs::write(&path, &full) {
        let msg = format!("write summary: {e}");
        errors::record(
            "summary_write",
            &msg,
            Some(json!({ "session_id": session_id, "target": target })),
        );
        let _ = app.emit(
            "summary:error",
            json!({ "session_id": session_id, "target": target, "message": msg }),
        );
        return Err(msg);
    }

    // Refresh meta.json so list_sessions reflects the new has_summary_*
    // flag without requiring the user to restart the app.
    if let Err(e) = session::touch_meta_summary_flags(&session_id) {
        errors::record(
            "summary_meta_touch",
            &e,
            Some(json!({ "session_id": session_id })),
        );
    }

    // The partial summary was written and meta refreshed above, so the user
    // keeps what did stream. But a max_tokens stop means it's incomplete —
    // surface that instead of a clean "done" so they know to shorten input or
    // pick a leaner template.
    if guard.stop_reason.as_deref() == Some("max_tokens") {
        guard.outcome = "ok";
        errors::record(
            "summary_truncated",
            "summary output hit max_tokens",
            Some(json!({ "session_id": session_id, "target": target })),
        );
        let msg = "總結輸出達到長度上限而被截斷，請改用較精簡的模板或縮短會議".to_string();
        let _ = app.emit(
            "summary:error",
            json!({ "session_id": session_id, "target": target, "message": msg.clone() }),
        );
        return Err(msg);
    }

    guard.outcome = "ok";
    let _ = app.emit(
        "summary:done",
        SummaryDone {
            session_id: session_id.clone(),
            target: target.clone(),
            path: path.to_string_lossy().to_string(),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn read_summary(session_id: String, target: String) -> Result<Option<String>, String> {
    session::validate_session_id(&session_id)?;
    if !languages::is_valid(&target) {
        return Err(format!("invalid target: {target}"));
    }
    let path = session::session_dir(&session_id).join(format!("summary.{target}.md"));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read summary: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// TraceGuard flushes a TraceRecord to the real traces.jsonl on Drop —
    /// tests must never do that, so every guard built here is leaked with
    /// `mem::forget` after its fields are asserted.
    fn test_guard() -> TraceGuard {
        TraceGuard::new("translate", "test".into(), "en".into(), "m".into())
    }

    // ---- provider seam ----

    #[test]
    fn provider_from_config_unknown_falls_back_to_anthropic() {
        assert_eq!(Provider::from_config("openai"), Provider::OpenAi);
        assert_eq!(Provider::from_config("anthropic"), Provider::Anthropic);
        assert_eq!(Provider::from_config(""), Provider::Anthropic);
        assert_eq!(Provider::from_config("gemini"), Provider::Anthropic);
    }

    #[test]
    fn build_chat_body_anthropic_is_byte_compatible() {
        // Must reproduce the pre-provider request JSON exactly — system array
        // with ephemeral cache_control, `max_tokens`, single user message.
        let body = build_chat_body(Provider::Anthropic, "claude-haiku-4-5", "SYS", "USER", 1024, true);
        let expected = json!({
            "model": "claude-haiku-4-5",
            "max_tokens": 1024,
            "stream": true,
            "system": [{
                "type": "text",
                "text": "SYS",
                "cache_control": {"type": "ephemeral"}
            }],
            "messages": [{"role": "user", "content": "USER"}]
        });
        assert_eq!(body, expected);
    }

    #[test]
    fn build_chat_body_openai_shape() {
        let body = build_chat_body(Provider::OpenAi, "gpt-5.6-terra", "SYS", "USER", 4096, true);
        assert_eq!(body["model"], "gpt-5.6-terra");
        assert_eq!(body["max_completion_tokens"], 4096);
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("system").is_none(), "system must be a message, not a top-level block");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "USER");
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(!body.to_string().contains("cache_control"));

        // stream_options is only legal on streaming calls.
        let nb = build_chat_body(Provider::OpenAi, "gpt-5.6-terra", "SYS", "USER", 4096, false);
        assert!(nb.get("stream_options").is_none());
        assert_eq!(nb["stream"], false);
    }

    #[test]
    fn parse_stream_event_openai_delta_and_done() {
        let mut guard = test_guard();
        let chunk = r#"{"choices":[{"delta":{"content":"Hello"},"index":0}]}"#;
        assert_eq!(
            parse_stream_event(Provider::OpenAi, "message", chunk, &mut guard),
            StreamAction::Delta("Hello".into())
        );
        assert_eq!(
            parse_stream_event(Provider::OpenAi, "message", "[DONE]", &mut guard),
            StreamAction::Stop
        );
        std::mem::forget(guard);
    }

    #[test]
    fn parse_stream_event_openai_length_normalizes_to_max_tokens() {
        let mut guard = test_guard();
        let chunk = r#"{"choices":[{"delta":{},"finish_reason":"length","index":0}]}"#;
        assert_eq!(
            parse_stream_event(Provider::OpenAi, "message", chunk, &mut guard),
            StreamAction::Ignore
        );
        assert_eq!(guard.stop_reason.as_deref(), Some("max_tokens"));
        std::mem::forget(guard);
    }

    #[test]
    fn parse_stream_event_openai_usage_chunk_with_empty_choices() {
        // The include_usage final chunk has an empty `choices` array — must
        // absorb tokens without panicking.
        let mut guard = test_guard();
        let chunk = r#"{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45,"prompt_tokens_details":{"cached_tokens":100}}}"#;
        assert_eq!(
            parse_stream_event(Provider::OpenAi, "message", chunk, &mut guard),
            StreamAction::Ignore
        );
        assert_eq!(guard.input_tokens, Some(120));
        assert_eq!(guard.output_tokens, Some(45));
        assert_eq!(guard.cache_read_input_tokens, Some(100));
        assert_eq!(guard.cache_creation_input_tokens, None);
        std::mem::forget(guard);
    }

    #[test]
    fn parse_stream_event_openai_error() {
        let mut guard = test_guard();
        let chunk = r#"{"error":{"message":"boom","type":"server_error"}}"#;
        match parse_stream_event(Provider::OpenAi, "message", chunk, &mut guard) {
            StreamAction::Error(msg) => assert!(msg.starts_with("openai stream error:"), "{msg}"),
            other => panic!("expected Error, got {other:?}"),
        }
        std::mem::forget(guard);
    }

    #[test]
    fn parse_stream_event_anthropic_regression() {
        let mut guard = test_guard();
        let delta = r#"{"delta":{"type":"text_delta","text":"你好"}}"#;
        assert_eq!(
            parse_stream_event(Provider::Anthropic, "content_block_delta", delta, &mut guard),
            StreamAction::Delta("你好".into())
        );
        assert_eq!(
            parse_stream_event(Provider::Anthropic, "message_stop", "{}", &mut guard),
            StreamAction::Stop
        );
        let msg_delta = r#"{"delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}"#;
        assert_eq!(
            parse_stream_event(Provider::Anthropic, "message_delta", msg_delta, &mut guard),
            StreamAction::Ignore
        );
        assert_eq!(guard.stop_reason.as_deref(), Some("max_tokens"));
        assert_eq!(guard.output_tokens, Some(9));
        std::mem::forget(guard);
    }

    #[test]
    fn is_meta_prefix_flags_japanese_markers() {
        assert!(is_meta_prefix("翻訳できません。入力が不完全です。"));
        assert!(is_meta_prefix("通訳者として、この内容は"));
    }

    #[test]
    fn is_meta_prefix_allows_apology_opening() {
        // A Chinese source often opens with an apology that legitimately
        // translates to this — must NOT be dropped (there is deliberately no
        // bare 申し訳ありません marker).
        assert!(!is_meta_prefix("申し訳ありません、遅れました"));
    }

    #[test]
    fn build_user_message_labels_source_with_code() {
        let mut history: VecDeque<(f64, String, String)> = VecDeque::new();
        history.push_back((0.0, "日本語のソース".into(), "the translation".into()));
        let msg = build_user_message("次の文", "ja", "en", &history);
        assert!(msg.contains("ja: 日本語のソース"), "{msg}");
        assert!(msg.contains("en: the translation"), "{msg}");
        assert!(msg.trim_end().ends_with("次の文"), "{msg}");
    }

    #[test]
    fn build_user_message_empty_history_returns_text() {
        let history: VecDeque<(f64, String, String)> = VecDeque::new();
        assert_eq!(build_user_message("原文", "zh", "en", &history), "原文");
    }

    // ---- summary heading templates + source/target parameterization ----

    #[test]
    fn template_headings_every_arm_present_with_expected_count() {
        // Every (heading template × registry language) arm must resolve, with
        // the documented section count (exec_brief 4, the rest 6).
        let expected: &[(&str, usize)] = &[
            ("exec_brief", 4),
            ("minutes", 6),
            ("discussion", 6),
            ("decision_log", 6),
            ("client_call", 6),
        ];
        for (template, count) in expected {
            for lang in ["zh", "en", "ja", "vi"] {
                let headings = template_headings(template, lang)
                    .unwrap_or_else(|| panic!("missing arm for ({template}, {lang})"));
                assert_eq!(headings.len(), *count, "({template}, {lang}) heading count");
            }
        }
    }

    #[test]
    fn template_headings_ja_exec_brief_exact_vector() {
        assert_eq!(
            template_headings("exec_brief", "ja").unwrap(),
            vec!["概要", "決定事項", "アクションアイテム", "未解決の課題"]
        );
    }

    #[test]
    fn template_headings_unknown_returns_none() {
        assert!(template_headings("exec_brief", "fr").is_none());
        assert!(template_headings("nope", "ja").is_none());
    }

    #[test]
    fn build_summary_system_parameterizes_source_and_target() {
        // ja target (native_name 日本語) summarizing an en meeting (zh_ui_name 英文).
        let target_label = crate::languages::get("ja").unwrap().native_name.as_str();
        let source_label = crate::languages::get("en").unwrap().zh_ui_name.as_str();
        let headings = template_headings("exec_brief", "ja").unwrap();
        let sys = build_summary_system(target_label, source_label, &headings, "", "");
        assert!(sys.contains("英文會議逐字稿"), "source label: {sys}");
        assert!(sys.contains("日本語"), "target label: {sys}");
        for h in ["概要", "決定事項", "アクションアイテム", "未解決の課題"] {
            assert!(sys.contains(&format!("## {h}")), "missing ## {h}: {sys}");
        }
    }

    #[test]
    fn build_summary_system_zh_source_is_byte_compatible() {
        // zh source (zh_ui_name 中文) must reproduce the pre-multi-language
        // literal 「中文會議逐字稿」 so the shipped zh-source prompt is unchanged.
        let target_label = crate::languages::get("zh").unwrap().native_name.as_str();
        let source_label = crate::languages::get("zh").unwrap().zh_ui_name.as_str();
        let headings = template_headings("exec_brief", "zh").unwrap();
        let sys = build_summary_system(target_label, source_label, &headings, "", "");
        assert!(sys.contains("中文會議逐字稿"), "{sys}");
    }

    #[test]
    fn slide_outline_system_has_ja_headings_and_source_label() {
        let target_label = crate::languages::get("ja").unwrap().native_name.as_str();
        let source_label = crate::languages::get("zh").unwrap().zh_ui_name.as_str();
        let sys = build_slide_outline_system(target_label, source_label, "ja", "");
        for h in ["表紙", "アジェンダ", "決定事項・アクションアイテム", "次のステップ"] {
            assert!(sys.contains(h), "missing ja slide heading {h}: {sys}");
        }
        assert!(sys.contains("中文會議逐字稿"), "source label: {sys}");
    }

    #[test]
    fn slide_outline_system_zh_source_is_byte_compatible() {
        let target_label = crate::languages::get("zh").unwrap().native_name.as_str();
        let source_label = crate::languages::get("zh").unwrap().zh_ui_name.as_str();
        let sys = build_slide_outline_system(target_label, source_label, "zh", "");
        assert!(sys.contains("將中文會議逐字稿轉成投影片大綱"), "{sys}");
        assert!(sys.contains("封面"), "{sys}");
    }
}
