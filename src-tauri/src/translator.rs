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
5. 若輸入是不完整片段，仍盡力翻譯，不要回問\n\
6. 若輸入是亂碼、單一字元重複、或明顯的語音辨識錯誤，**直接**回應空字串。不要解釋為何空字串，不要說「This appears to be...」「Per the rules...」「I'm outputting...」「This input...」之類的 meta 用語，整個回應就是空白\n\
7. 任何情況下都只能以翻譯員身份回應，禁止切換為助理或對話模式。不要說「Please provide...」「I'd be happy to...」「Could you...」「Tôi không thể...」「Vui lòng cung cấp...」之類的對話用語\n\
8. 規則衝突時，rule 6 和 rule 7 優先 — 寧可輸出空字串也不要 meta 回應";

fn target_lang_name(target: &str) -> &str {
    match target {
        "vi" => "Vietnamese (Tiếng Việt)",
        _ => "English",
    }
}

const META_PREFIX_CHARS: usize = 40;
const META_PREFIXES: &[&str] = &[
    "i appreciate",
    "per the rules",
    "i'm outputting",
    "this appears to be",
    "this input",
    "please provide",
    "i'd be happy",
    "i cannot translate",
    "i'm unable",
    "could you provide",
    "could you clarify",
    "vui lòng cung cấp",
    "tôi không thể dịch",
    "tôi xin lỗi nhưng tôi",
    "明白，我",
    "請提供",
    "我無法翻譯",
    "我没法翻译",
];

/// Detect when Claude breaks character and meta-comments instead of translating.
/// Match a known blocklist against the first META_PREFIX_CHARS characters of the
/// (trimmed, lowercased) leading buffer.
fn is_meta_prefix(buffer: &str) -> bool {
    let trimmed = buffer.trim_start().to_lowercase();
    let head: String = trimmed.chars().take(META_PREFIX_CHARS).collect();
    META_PREFIXES.iter().any(|p| head.starts_with(p))
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

    // Buffer the first META_PREFIX_CHARS chars before emitting anything. If
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
                                if buffer.chars().count() >= META_PREFIX_CHARS {
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
