//! Incremental (simultaneous-interpreter) translation engine.
//!
//! Sentence mode (the original pipeline) translates each final utterance as an
//! independent request, orchestrated by the frontend. This engine instead:
//!
//! * receives clause-level *segments* from the sidecar (see `boundary` on the
//!   `transcript` event) and stitches consecutive segments into a *group* —
//!   one group per sentence, closed by a `sentence` / `pause` boundary or by
//!   the `GROUP_MAX_CHARS` cap;
//! * per target language, keeps exactly one LLM call in flight per group and
//!   asks the model for the *continuation* of what has already been shown,
//!   so translation starts before the speaker finishes the sentence;
//! * enforces append-only output — text already emitted to the UI is never
//!   retracted; a repeated prefix from the model is stripped, never re-shown;
//! * writes one `transcript.jsonl` row per group when every target is done,
//!   and feeds the rolling `TranslationContext` the sentence translator uses.
//!
//! Events reuse the sentence-mode names (`translation:chunk:{lang}` /
//! `translation:done:{lang}`) with the group id as `id`, so the translation
//! windows render both modes with the same code. Design notes:
//! `docs/PLAN_INCREMENTAL_INTERP.md`.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::config::SharedConfig;
use crate::errors;
use crate::languages;
use crate::session::{SharedRecorder, StoredUtterance};
use crate::translator::{
    self, Provider, StreamAction, TraceGuard, TranslationContext, CONTEXT_PAIRS,
};

const INTERPRET_TEMPLATE: &str = include_str!("../prompts/interpret_system.txt");

/// A group closes once its source reaches this many chars even without a
/// sentence boundary — bounds how long one UI row / one utterance can grow
/// when the speaker never pauses and the STT never emits a period.
const GROUP_MAX_CHARS: usize = 40;
/// Groups shorter than this (「嗯」「對」) are persisted source-only without a
/// translate call — same rule the sentence-mode frontend applies.
const MIN_TRANSLATE_CHARS: usize = 2;
const MAX_TOKENS: u32 = 300;
/// How long `flush` waits for in-flight final calls at stop before giving up
/// and letting the session close with whatever was persisted.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(6);
/// Buffer this many chars of a continuation before emitting anything, so the
/// meta-leak check and the repeated-prefix strip see enough text to decide.
const HEAD_SCAN_CHARS: usize = 32;

#[derive(Debug, Default)]
struct TargetState {
    /// Everything shown to the UI for this target so far (append-only).
    emitted: String,
    /// Source chars covered by the last completed call. A worker keeps
    /// looping while the group's source is longer than this.
    translated_chars: usize,
    in_flight: bool,
    /// Set after the call that saw `closed == true` completed (or failed).
    finished: bool,
    failed: bool,
}

struct Group {
    id: String,
    t_start: f64,
    t_end: f64,
    source: String,
    closed: bool,
    closed_at: Option<Instant>,
    targets: BTreeMap<String, TargetState>,
    persisted: bool,
}

impl Group {
    fn new(t_start: f64, targets: Vec<String>) -> Self {
        Self {
            id: t_start.to_string(),
            t_start,
            t_end: t_start,
            source: String::new(),
            closed: false,
            closed_at: None,
            targets: targets
                .into_iter()
                .map(|l| (l, TargetState::default()))
                .collect(),
            persisted: false,
        }
    }

    fn append(&mut self, text: &str, t_end: f64) {
        self.source.push_str(text);
        if t_end > self.t_end {
            self.t_end = t_end;
        }
    }

    fn source_chars(&self) -> usize {
        self.source.chars().count()
    }

    fn all_finished(&self) -> bool {
        self.targets.values().all(|t| t.finished)
    }
}

type SharedGroup = Arc<Mutex<Group>>;

pub struct InterpEngine {
    current: Option<SharedGroup>,
    workers: Vec<JoinHandle<()>>,
}

pub type SharedInterp = Arc<Mutex<InterpEngine>>;

pub fn new_engine() -> SharedInterp {
    Arc::new(Mutex::new(InterpEngine {
        current: None,
        workers: Vec::new(),
    }))
}

/// Whether a segment with this boundary kind ends its group. `clause` /
/// `forced` keep it open; `sentence` / `pause` / unknown / absent close it
/// (absent = an old sidecar that only cuts at sentence ends).
pub fn boundary_closes(boundary: Option<&str>) -> bool {
    !matches!(boundary, Some("clause") | Some("forced"))
}

/// Target languages that should receive translations right now: the
/// configured slots minus the source, minus duplicates, minus slots whose
/// window the user closed (no point paying for text nobody can see — same
/// rule the sentence-mode frontend applies).
async fn live_targets(app: &AppHandle) -> Vec<String> {
    let (source, slots) = {
        let cfg = app.state::<SharedConfig>();
        let cfg = cfg.lock().await;
        (cfg.language.source.clone(), cfg.language.target_slots.clone())
    };
    let mut out: Vec<String> = Vec::new();
    for (i, slot) in slots.iter().enumerate() {
        if slot.is_empty() || *slot == source || out.contains(slot) {
            continue;
        }
        let label = if i == 0 { "t1" } else { "t2" };
        if app.get_webview_window(label).is_some() {
            out.push(slot.clone());
        }
    }
    out
}

/// Entry point from the sidecar stdout reader for every non-empty final
/// segment. Appends to the open group (or opens one), closes it when the
/// boundary says so, and makes sure each target has a worker running.
/// Returns the group id the frontend should use as the utterance id.
pub async fn on_final_segment(
    app: &AppHandle,
    text: &str,
    t_start: f64,
    t_end: f64,
    boundary: Option<&str>,
) -> String {
    let engine = app.state::<SharedInterp>().inner().clone();
    let mut eng = engine.lock().await;
    eng.workers.retain(|h| !h.is_finished());

    let group = match eng.current.clone() {
        Some(g) => g,
        None => {
            let g = Arc::new(Mutex::new(Group::new(t_start, live_targets(app).await)));
            eng.current = Some(g.clone());
            g
        }
    };

    let (id, closes, langs) = {
        let mut g = group.lock().await;
        g.append(text.trim(), t_end);
        let closes = boundary_closes(boundary) || g.source_chars() >= GROUP_MAX_CHARS;
        if closes {
            g.closed = true;
            g.closed_at = Some(Instant::now());
        }
        let langs: Vec<String> = g
            .targets
            .iter()
            .filter(|(_, t)| !t.in_flight)
            .map(|(l, _)| l.clone())
            .collect();
        (g.id.clone(), closes, langs)
    };
    if closes {
        eng.current = None;
    }
    for lang in langs {
        eng.workers
            .push(tokio::spawn(run_target(app.clone(), group.clone(), lang)));
    }
    // A closed group with no targets (both windows shut) still needs its
    // source persisted.
    if closes {
        let g = group.clone();
        let app2 = app.clone();
        eng.workers.push(tokio::spawn(async move {
            maybe_finish(&app2, &g).await;
        }));
    }
    id
}

/// Drop any open group and abort leftover workers. Called on `start_stt` so a
/// new session never inherits the tail of the previous one.
pub async fn reset(app: &AppHandle) {
    let engine = app.state::<SharedInterp>().inner().clone();
    let mut eng = engine.lock().await;
    eng.current = None;
    for h in eng.workers.drain(..) {
        h.abort();
    }
}

/// Close the open group (if any), let every target run its final call, and
/// wait — bounded by `FLUSH_TIMEOUT` — for all workers to finish so the
/// session's last row lands before `stop_session` finalizes meta.json.
pub async fn flush(app: &AppHandle) {
    let engine = app.state::<SharedInterp>().inner().clone();
    let workers = {
        let mut eng = engine.lock().await;
        if let Some(group) = eng.current.take() {
            let langs: Vec<String> = {
                let mut g = group.lock().await;
                g.closed = true;
                g.closed_at = Some(Instant::now());
                g.targets
                    .iter()
                    .filter(|(_, t)| !t.in_flight)
                    .map(|(l, _)| l.clone())
                    .collect()
            };
            for lang in langs {
                eng.workers
                    .push(tokio::spawn(run_target(app.clone(), group.clone(), lang)));
            }
            let g = group.clone();
            let app2 = app.clone();
            eng.workers.push(tokio::spawn(async move {
                maybe_finish(&app2, &g).await;
            }));
        }
        std::mem::take(&mut eng.workers)
    };
    if workers.is_empty() {
        return;
    }
    let _ = tokio::time::timeout(FLUSH_TIMEOUT, futures_util::future::join_all(workers)).await;
}

struct Job {
    id: String,
    source: String,
    emitted: String,
    closed: bool,
    src_chars: usize,
}

/// One worker per (group, target). Loops while the group has untranslated
/// source or an outstanding final call; exits when nothing is pending. A
/// later segment re-spawns a worker via `on_final_segment` — the
/// `in_flight` check at the top makes a duplicate spawn a harmless no-op.
async fn run_target(app: AppHandle, group: SharedGroup, lang: String) {
    loop {
        let job = {
            let mut g = group.lock().await;
            let closed = g.closed;
            let src_chars = g.source_chars();
            let id = g.id.clone();
            let source = g.source.clone();
            let Some(ts) = g.targets.get_mut(&lang) else { break };
            if ts.in_flight {
                return;
            }
            let need = src_chars > ts.translated_chars || (closed && !ts.finished);
            if !need {
                break;
            }
            if closed && src_chars < MIN_TRANSLATE_CHARS {
                ts.finished = true;
                ts.translated_chars = src_chars;
                break;
            }
            ts.in_flight = true;
            Job {
                id,
                source,
                emitted: ts.emitted.clone(),
                closed,
                src_chars,
            }
        };

        let result = call_llm(&app, &job, &lang).await;

        {
            let mut g = group.lock().await;
            if let Some(ts) = g.targets.get_mut(&lang) {
                ts.in_flight = false;
                ts.translated_chars = ts.translated_chars.max(job.src_chars);
                match result {
                    Ok(cont) => {
                        ts.emitted.push_str(&cont);
                    }
                    Err(e) => {
                        ts.failed = true;
                        errors::record(
                            "interp_api",
                            &e,
                            Some(json!({
                                "target": lang,
                                "id": job.id,
                                "closed": job.closed,
                                "text_excerpt": job.source.chars().take(60).collect::<String>(),
                            })),
                        );
                    }
                }
                if job.closed {
                    ts.finished = true;
                }
            }
        }
    }
    maybe_finish(&app, &group).await;
}

/// Once a closed group has every target finished: emit `translation:done`
/// per target, persist the utterance row, and feed the rolling context.
/// Idempotent via `persisted`.
async fn maybe_finish(app: &AppHandle, group: &SharedGroup) {
    let snapshot = {
        let mut g = group.lock().await;
        if !g.closed || g.persisted || !g.all_finished() {
            return;
        }
        g.persisted = true;
        (
            g.id.clone(),
            g.t_start,
            g.t_end,
            g.source.clone(),
            g.targets
                .iter()
                .map(|(l, t)| (l.clone(), t.emitted.trim().to_string(), t.failed))
                .collect::<Vec<_>>(),
            g.closed_at.map(|c| c.elapsed().as_millis() as u64),
        )
    };
    let (id, t_start, t_end, source, targets, ms_since_close) = snapshot;

    let mut translations = BTreeMap::new();
    let mut incomplete = false;
    for (lang, text, failed) in &targets {
        translations.insert(lang.clone(), text.clone());
        incomplete |= *failed;
        let _ = app.emit(&format!("translation:done:{lang}"), json!({ "id": id }));
    }
    let _ = app.emit(
        "interp:group_done",
        json!({ "id": id, "t_start": t_start, "t_end": t_end, "ms_since_close": ms_since_close }),
    );

    {
        let recorder = app.state::<SharedRecorder>();
        let mut guard = recorder.lock().await;
        if let Some(rec) = guard.as_mut() {
            let u = StoredUtterance {
                id: id.clone(),
                t_start,
                t_end,
                src: source.clone(),
                translations,
                incomplete,
                lang: None,
                zh: String::new(),
                en: String::new(),
                vi: String::new(),
            };
            if let Err(e) = rec.append(&u) {
                errors::record(
                    "session_append_failed",
                    &e,
                    Some(json!({ "session_id": rec.session_id, "id": id })),
                );
            }
        }
    }

    let ctx = app.state::<TranslationContext>();
    let mut map = ctx.lock().await;
    for (lang, text, failed) in targets {
        if failed || text.is_empty() {
            continue;
        }
        let entry = map.entry(lang).or_insert_with(VecDeque::new);
        let pos = entry
            .iter()
            .position(|(k, _, _)| *k > t_start)
            .unwrap_or(entry.len());
        entry.insert(pos, (t_start, source.clone(), text));
        while entry.len() > CONTEXT_PAIRS {
            entry.pop_front();
        }
    }
}

/// Whether a space belongs between `emitted` and the continuation for this
/// target: spaced scripts only, and only when neither side already has one.
fn needs_space(emitted: &str, cont: &str, target: &str) -> bool {
    if emitted.is_empty() || cont.is_empty() {
        return false;
    }
    let spaced = !matches!(
        languages::get(target).map(|l| l.script_profile.as_str()),
        Some("cjk") | Some("han") | Some("kana") | Some("zh") | Some("ja")
    ) && !matches!(target, "zh" | "ja");
    if !spaced {
        return false;
    }
    let last = emitted.chars().last().map(|c| c.is_whitespace()).unwrap_or(true);
    let first = cont.chars().next().map(|c| c.is_whitespace()).unwrap_or(true);
    !last && !first
}

/// Strip the part of `cont` that repeats the tail of `emitted`. Prefill makes
/// this rare on Anthropic; the tag-based OpenAI path needs it. Whole-prefix
/// repetition is stripped at any length; a partial overlap only when the
/// shared span is long enough not to be a coincidence.
fn strip_overlap(emitted: &str, cont: &str, target: &str) -> String {
    let e = emitted.trim();
    let c = cont.trim_start();
    if e.is_empty() || c.is_empty() {
        return cont.to_string();
    }
    if c.starts_with(e) {
        return c[e.len()..].to_string();
    }
    let min_overlap = if matches!(target, "zh" | "ja") { 4 } else { 8 };
    let e_chars: Vec<char> = e.chars().collect();
    let c_chars: Vec<char> = c.chars().collect();
    let max_k = e_chars.len().min(c_chars.len());
    for k in (min_overlap..=max_k).rev() {
        if e_chars[e_chars.len() - k..] == c_chars[..k] {
            return c_chars[k..].iter().collect();
        }
    }
    cont.to_string()
}

fn build_user(
    history: &VecDeque<(f64, String, String)>,
    source_label: &str,
    lang_label: &str,
    job: &Job,
    tag_emitted: bool,
) -> String {
    let mut s = String::new();
    if !history.is_empty() {
        s.push_str("<context>\n");
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
    }
    s.push_str("<source>");
    s.push_str(&job.source);
    s.push_str("</source>");
    if job.closed {
        s.push_str("<final/>");
    }
    if tag_emitted && !job.emitted.trim().is_empty() {
        s.push_str("\n<emitted>");
        s.push_str(job.emitted.trim());
        s.push_str("</emitted>");
    }
    s
}

/// Request body. Anthropic gets the emitted translation as an assistant
/// prefill (the model can only continue it — append-only by construction;
/// trailing whitespace is trimmed because the API rejects it). OpenAI has no
/// prefill, so the emitted text rides in the user message as `<emitted>`.
fn build_body(
    provider: Provider,
    model: &str,
    system: &str,
    user: &str,
    prefill: Option<&str>,
) -> Value {
    match provider {
        Provider::Anthropic => {
            let mut messages = vec![json!({"role": "user", "content": user})];
            if let Some(p) = prefill.map(str::trim_end).filter(|p| !p.is_empty()) {
                messages.push(json!({"role": "assistant", "content": p}));
            }
            json!({
                "model": model,
                "max_tokens": MAX_TOKENS,
                "stream": true,
                "system": [{
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"}
                }],
                "messages": messages
            })
        }
        Provider::OpenAi => json!({
            "model": model,
            "max_completion_tokens": MAX_TOKENS,
            "stream": true,
            "stream_options": {"include_usage": true},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ]
        }),
    }
}

/// One streaming continuation call. Emits `translation:chunk:{lang}` deltas
/// as they arrive (after the head buffer clears the meta / overlap checks)
/// and returns the full continuation exactly as shown to the UI.
async fn call_llm(app: &AppHandle, job: &Job, lang: &str) -> Result<String, String> {
    let (provider, api_key, model, source_code, glossary_block) = {
        let cfg = app.state::<SharedConfig>();
        let cfg = cfg.lock().await;
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
            cfg.render_glossary_section(lang),
        )
    };
    if api_key.is_empty() {
        return Err(format!("{} API key not configured", provider.label()));
    }
    if !crate::netcheck::is_online(app) {
        return Err(crate::netcheck::OFFLINE_ERR.into());
    }
    let Some(target_name) = languages::get(lang).map(|l| l.prompt_name.as_str()) else {
        return Err(format!("invalid target: {lang}"));
    };
    let source_name = languages::get(&source_code)
        .map(|l| l.zh_ui_name.as_str())
        .unwrap_or("中文");

    let history: VecDeque<(f64, String, String)> = {
        let ctx = app.state::<TranslationContext>();
        let map = ctx.lock().await;
        map.get(lang).cloned().unwrap_or_default()
    };
    let system = INTERPRET_TEMPLATE
        .replace("{source_lang}", source_name)
        .replace("{lang}", target_name)
        .replace("{glossary_section}", &glossary_block);
    let tag_emitted = provider == Provider::OpenAi;
    let user = build_user(&history, &source_code, lang, job, tag_emitted);
    let prefill = if provider == Provider::Anthropic {
        Some(job.emitted.as_str())
    } else {
        None
    };
    let body = build_body(provider, &model, &system, &user, prefill);

    let mut guard = TraceGuard::new("translate_inc", job.id.clone(), lang.to_string(), model.clone());
    let resp = translator::post_llm_with_retry(provider, &api_key, &body, &mut guard.retries).await?;

    let chunk_event = format!("translation:chunk:{lang}");
    let mut stream = resp.bytes_stream().eventsource();
    let mut head = String::new();
    let mut decided = false;
    let mut shown = String::new();

    while let Some(event) = stream.next().await {
        let ev = match event {
            Ok(ev) => ev,
            Err(e) => return Err(format!("sse stream: {e}")),
        };
        match translator::parse_stream_event(provider, ev.event.as_str(), &ev.data, &mut guard) {
            StreamAction::Delta(delta) => {
                guard.mark_ttft();
                if decided {
                    shown.push_str(&delta);
                    let _ = app.emit(&chunk_event, json!({ "id": job.id, "text": delta }));
                } else {
                    head.push_str(&delta);
                    if head.chars().count() >= HEAD_SCAN_CHARS {
                        decided = true;
                        if translator::is_meta_prefix(&head) {
                            errors::record(
                                "translation_meta_filtered",
                                &head.chars().take(80).collect::<String>(),
                                Some(json!({ "target": lang, "id": job.id, "kind": "interp" })),
                            );
                            guard.outcome = "filtered";
                            return Ok(String::new());
                        }
                        let first = first_chunk(&job.emitted, &head, lang);
                        if !first.is_empty() {
                            shown.push_str(&first);
                            let _ = app.emit(&chunk_event, json!({ "id": job.id, "text": first }));
                        }
                    }
                }
            }
            StreamAction::Stop => break,
            StreamAction::Error(err) => return Err(err),
            StreamAction::Ignore => {}
        }
    }
    if !decided && !head.is_empty() {
        if translator::is_meta_prefix(&head) {
            errors::record(
                "translation_meta_filtered",
                &head,
                Some(json!({ "target": lang, "id": job.id, "kind": "interp" })),
            );
            guard.outcome = "filtered";
            return Ok(String::new());
        }
        let first = first_chunk(&job.emitted, &head, lang);
        if !first.is_empty() {
            shown.push_str(&first);
            let _ = app.emit(&chunk_event, json!({ "id": job.id, "text": first }));
        }
    }
    guard.outcome = if shown.trim().is_empty() { "empty" } else { "ok" };
    Ok(shown)
}

/// The first visible chunk of a continuation: overlap with `emitted`
/// stripped, a joining space added where the target script needs one.
fn first_chunk(emitted: &str, head: &str, lang: &str) -> String {
    let stripped = strip_overlap(emitted, head, lang);
    if stripped.trim().is_empty() {
        return String::new();
    }
    if emitted.is_empty() {
        return stripped;
    }
    // Normalize the seam. Models often start a continuation with " " or
    // "\n" and sometimes end one with a trailing space, which stacked up as
    // double spaces / stray line breaks inside a row. Collapse whatever
    // whitespace sits on either side of the seam to exactly one space for
    // spaced scripts and nothing for CJK.
    let body = stripped.trim_start();
    let emitted_ws = emitted.chars().last().map(|c| c.is_whitespace()).unwrap_or(false);
    if needs_space(emitted.trim_end(), body, lang) && !emitted_ws {
        format!(" {body}")
    } else {
        body.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_semantics() {
        assert!(!boundary_closes(Some("clause")));
        assert!(!boundary_closes(Some("forced")));
        assert!(boundary_closes(Some("sentence")));
        assert!(boundary_closes(Some("pause")));
        assert!(boundary_closes(None), "old sidecars only cut at sentence ends");
        assert!(boundary_closes(Some("weird")));
    }

    #[test]
    fn group_appends_and_tracks_time() {
        let mut g = Group::new(12.5, vec!["en".into(), "vi".into()]);
        assert_eq!(g.id, "12.5");
        g.append("今天我們", 13.0);
        g.append("討論預算，", 14.2);
        assert_eq!(g.source, "今天我們討論預算，");
        assert_eq!(g.t_end, 14.2);
        assert_eq!(g.source_chars(), 9);
        assert!(!g.all_finished());
        g.targets.get_mut("en").unwrap().finished = true;
        g.targets.get_mut("vi").unwrap().finished = true;
        assert!(g.all_finished());
    }

    #[test]
    fn strip_overlap_whole_prefix_repetition() {
        let e = "The first topic we're discussing today";
        let c = "The first topic we're discussing today is about the budget.";
        assert_eq!(strip_overlap(e, c, "en"), " is about the budget.");
    }

    #[test]
    fn strip_overlap_partial_tail_overlap() {
        let e = "We reviewed the Q3 numbers and the marketing";
        let c = "and the marketing budget was cut in half";
        assert_eq!(strip_overlap(e, c, "en"), " budget was cut in half");
        // too short to count as overlap for a spaced language
        let e2 = "Okay, so";
        let c2 = "so we start";
        assert_eq!(strip_overlap(e2, c2, "en"), "so we start");
    }

    #[test]
    fn strip_overlap_cjk_uses_shorter_threshold() {
        let e = "我們今天要討論的第一個議題";
        let c = "第一個議題是預算";
        assert_eq!(strip_overlap(e, c, "zh"), "是預算");
        assert_eq!(strip_overlap("", "hello", "en"), "hello");
        assert_eq!(strip_overlap("abc", "   ", "en"), "   ");
    }

    #[test]
    fn needs_space_only_for_spaced_scripts() {
        assert!(needs_space("Good afternoon", "everyone", "en"));
        assert!(!needs_space("Good afternoon", " everyone", "en"));
        assert!(!needs_space("Good afternoon ", "everyone", "en"));
        assert!(!needs_space("", "everyone", "en"));
        assert!(!needs_space("大家下午好", "今天", "zh"));
        assert!(!needs_space("こんにちは", "今日は", "ja"));
        assert!(needs_space("Chào buổi chiều", "mọi người", "vi"));
    }

    #[test]
    fn first_chunk_strips_and_joins() {
        assert_eq!(
            first_chunk("The first topic", "The first topic is about budget", "en"),
            " is about budget"
        );
        assert_eq!(first_chunk("The first topic", "is about budget", "en"), " is about budget");
        assert_eq!(first_chunk("", "Good afternoon,", "en"), "Good afternoon,");
        assert_eq!(first_chunk("", " Good afternoon,", "en"), " Good afternoon,");
        assert_eq!(first_chunk("Hello", "Hello", "en"), "");
    }

    #[test]
    fn first_chunk_collapses_seam_whitespace() {
        // continuation starts with a space / newline → exactly one space
        assert_eq!(first_chunk("everyone.", "  Today it's hot", "en"), " Today it's hot");
        assert_eq!(first_chunk("country,", "\nyou'll want", "en"), " you'll want");
        // emitted already ends with a space → don't add another
        assert_eq!(first_chunk("areas. ", " The rainfall", "en"), "The rainfall");
        // CJK: never a space
        assert_eq!(first_chunk("皆さん、", " 今日は", "ja"), "今日は");
        assert_eq!(first_chunk("大家好，", "\n今天", "zh"), "今天");
    }

    fn job(source: &str, emitted: &str, closed: bool) -> Job {
        Job {
            id: "1".into(),
            source: source.into(),
            emitted: emitted.into(),
            closed,
            src_chars: source.chars().count(),
        }
    }

    #[test]
    fn user_message_shapes() {
        let empty = VecDeque::new();
        let j = job("我們今天要討論的第一個議題是關於，", "", false);
        assert_eq!(
            build_user(&empty, "zh", "en", &j, false),
            "<source>我們今天要討論的第一個議題是關於，</source>"
        );
        let j = job("我們今天要討論的第一個議題是關於預算。", "The first topic", true);
        let anthropic = build_user(&empty, "zh", "en", &j, false);
        assert!(anthropic.ends_with("</source><final/>"));
        assert!(!anthropic.contains("<emitted>"));
        let openai = build_user(&empty, "zh", "en", &j, true);
        assert!(openai.ends_with("<final/>\n<emitted>The first topic</emitted>"));

        let mut hist = VecDeque::new();
        hist.push_back((1.0, "上一句。".to_string(), "Previous sentence.".to_string()));
        let with_ctx = build_user(&hist, "zh", "en", &j, false);
        assert!(with_ctx.starts_with("<context>\nzh: 上一句。\nen: Previous sentence.\n\n</context>\n\n<source>"));
    }

    #[test]
    fn anthropic_body_uses_prefill_and_trims_trailing_space() {
        let body = build_body(Provider::Anthropic, "m", "SYS", "USER", Some("The first topic "));
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "The first topic");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["max_tokens"], MAX_TOKENS);

        let body = build_body(Provider::Anthropic, "m", "SYS", "USER", Some("   "));
        assert_eq!(body["messages"].as_array().unwrap().len(), 1, "blank prefill is omitted");
        let body = build_body(Provider::Anthropic, "m", "SYS", "USER", None);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn openai_body_has_no_prefill() {
        let body = build_body(Provider::OpenAi, "gpt", "SYS", "USER", Some("ignored"));
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(body["max_completion_tokens"], MAX_TOKENS);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn interpret_template_has_all_slots() {
        for slot in ["{source_lang}", "{lang}", "{glossary_section}"] {
            assert!(INTERPRET_TEMPLATE.contains(slot), "missing {slot}");
        }
    }
}
