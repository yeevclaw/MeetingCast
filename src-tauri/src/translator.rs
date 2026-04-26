use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const MODEL: &str = "claude-haiku-4-5";

const SYSTEM_TEMPLATE: &str = "你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {lang}。\n\
規則：\n\
1. 只輸出譯文，不要任何解釋、引號、標點修飾\n\
2. 保留專有名詞原文（公司名、產品名、人名）\n\
3. 口語化但專業，符合會議場合\n\
4. 若輸入是不完整片段，仍盡力翻譯，不要回問";

fn target_lang_name(target: &str) -> &str {
    match target {
        "vi" => "Vietnamese (Tiếng Việt)",
        _ => "English",
    }
}

#[tauri::command]
pub async fn translate(app: AppHandle, text: String, target: String) -> Result<(), String> {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY not set".to_string())?;

    let system = SYSTEM_TEMPLATE.replace("{lang}", target_lang_name(&target));
    let body = json!({
        "model": MODEL,
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
        return Err(format!("anthropic {status}: {body}"));
    }

    let chunk_event = format!("translation:chunk:{}", target);
    let done_event = format!("translation:done:{}", target);
    let mut stream = resp.bytes_stream().eventsource();

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
                            let _ = app.emit(&chunk_event, delta.to_string());
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

    let _ = app.emit(&done_event, ());
    Ok(())
}
