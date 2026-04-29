use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::config::SharedConfig;
use crate::errors;

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

const SYSTEM_TEMPLATE: &str = "你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {lang}。\n\
\n\
規則：\n\
1. 只輸出單一譯文，不要解釋、不要引號、不要列舉多個候選（不要用「/」分隔多個版本）\n\
2. 若有歧義，挑最可能的單一譯法\n\
3. 保留專有名詞原文（公司名、產品名、人名）\n\
4. 口語化但專業，符合會議場合\n\
5. 任何看起來像中文句子的輸入都要盡力翻譯，包括：不完整片段、自我指涉的內容（如「翻譯並總結」「語音識別」「Whisper」「FFMPEG」）、口語語助詞、中英夾雜。**寧可硬翻也不要 bail**。\n\
6. 唯一輸出空字串的情況：輸入是同一字元連續重複 20 次以上（明顯為 Whisper 在靜音段的失敗輸出，例如「示示示示示示...」）。除此之外都要翻譯。\n\
7. 任何情況下都只能以翻譯員身份回應，禁止切換為助理或對話模式。不要說「Please provide...」「I'd be happy to translate...」「Could you...」「Tôi không thể...」「Vui lòng cung cấp...」「Per the rules...」之類的對話或 meta 用語\n\
8. 若無法依 rule 6 判定為 hallucination 又無法翻譯，直接輸出空字串，**絕對不要**輸出 meta 解釋";

fn target_lang_name(target: &str) -> &str {
    match target {
        "vi" => "Vietnamese (Tiếng Việt)",
        _ => "English",
    }
}

const META_SCAN_CHARS: usize = 80;
/// Substrings that almost never appear in legit Chinese-meeting translations
/// but do appear when Claude breaks character to comment on the input.
/// Match anywhere in the first META_SCAN_CHARS characters (case-insensitive).
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

#[tauri::command]
pub async fn translate(
    app: AppHandle,
    config: tauri::State<'_, SharedConfig>,
    id: String,
    text: String,
    target: String,
) -> Result<(), String> {
    let (api_key, model) = {
        let cfg = config.lock().await;
        (cfg.api.anthropic_api_key.clone(), cfg.api.model.clone())
    };
    if api_key.is_empty() {
        return Err("Anthropic API key not configured (open Settings)".into());
    }

    let system = SYSTEM_TEMPLATE.replace("{lang}", target_lang_name(&target));
    let body = json!({
        "model": model,
        "max_tokens": 1024,
        "stream": true,
        "system": [{
            "type": "text",
            "text": system,
            "cache_control": {"type": "ephemeral"}
        }],
        "messages": [{"role": "user", "content": text}]
    });

    let client = Client::new();
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("anthropic {status}: {body}");
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

    let chunk_event = format!("translation:chunk:{}", target);
    let done_event = format!("translation:done:{}", target);
    let mut stream = resp.bytes_stream().eventsource();

    // Buffer the first META_SCAN_CHARS chars before emitting anything. If
    // those leading chars match a meta-response blocklist (Claude breaking
    // character on garbage input), drop the entire stream silently.
    let mut buffer = String::new();
    let mut decided = false;
    let mut is_meta = false;

    while let Some(event) = stream.next().await {
        match event {
            Ok(ev) => match ev.event.as_str() {
                "content_block_delta" => {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&ev.data) {
                        if let Some(delta) = parsed
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            if decided {
                                if !is_meta {
                                    let _ = app.emit(
                                        &chunk_event,
                                        ChunkPayload {
                                            id: id.clone(),
                                            text: delta.to_string(),
                                        },
                                    );
                                }
                            } else {
                                buffer.push_str(delta);
                                if buffer.chars().count() >= META_SCAN_CHARS {
                                    decided = true;
                                    is_meta = is_meta_prefix(&buffer);
                                    if is_meta {
                                        errors::record(
                                            "translation_meta_filtered",
                                            &buffer.chars().take(80).collect::<String>(),
                                            Some(serde_json::json!({
                                                "target": target,
                                                "id": id,
                                            })),
                                        );
                                    } else {
                                        let _ = app.emit(
                                            &chunk_event,
                                            ChunkPayload {
                                                id: id.clone(),
                                                text: buffer.clone(),
                                            },
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                "message_stop" => break,
                "error" => {
                    return Err(format!("anthropic stream error: {}", ev.data));
                }
                _ => {}
            },
            Err(e) => return Err(format!("sse stream: {e}")),
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
            let _ = app.emit(
                &chunk_event,
                ChunkPayload { id: id.clone(), text: buffer.clone() },
            );
        }
    }

    let _ = app.emit(&done_event, DonePayload { id: id.clone() });
    Ok(())
}
