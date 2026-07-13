use std::time::Duration;

/// Tri-state API-key validation used by the Welcome wizard. The endpoint
/// is a free metadata GET — no tokens are billed. The result is a string
/// rather than a bool so the frontend can distinguish "the key is wrong"
/// (block with an escape hatch) from "we couldn't check" (never block):
///   200        → "valid"
///   401 / 403  → "invalid"
///   anything else, incl. network error / timeout → "unknown"
fn classify(status: u16) -> &'static str {
    match status {
        200 => "valid",
        401 | 403 => "invalid",
        _ => "unknown",
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client: {e}"))
}

#[tauri::command]
pub async fn validate_anthropic_key(key: String) -> Result<String, String> {
    let resp = client()?
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await;
    Ok(match resp {
        Ok(r) => classify(r.status().as_u16()),
        Err(_) => "unknown",
    }
    .to_string())
}
