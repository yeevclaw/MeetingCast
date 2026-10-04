//! Reachability monitor for the LLM endpoint.
//!
//! Venues often have no (or captive) Wi-Fi. Rather than letting every
//! translate call walk the retry ladder into DNS timeouts, a background task
//! opens a TCP connection to the active provider's API host every few seconds
//! and publishes the result:
//!
//! * `network:status` event `{ "online": bool }` on every change (and once on
//!   the first probe), consumed by the control window's 網路 chip and the
//!   translation windows' paused banner;
//! * an `AtomicBool` that `translator::translate` and `interp::call_llm` read
//!   to fail fast with [`OFFLINE_ERR`], which the frontend treats as "paused",
//!   not as an error.
//!
//! The probe is a plain TCP connect (no TLS handshake, no request), so it is
//! free in API terms and completes in tens of milliseconds on a working link.
//! Offline is re-probed faster than online so recovery is noticed promptly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::config::SharedConfig;

/// Error string returned by LLM entry points while offline. The frontend
/// matches on this prefix (see `src/lib/errors.ts`).
pub const OFFLINE_ERR: &str = "offline: no network connection";

const ONLINE_INTERVAL: Duration = Duration::from_secs(20);
const OFFLINE_INTERVAL: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2500);

#[derive(Clone)]
pub struct NetworkState {
    online: Arc<AtomicBool>,
}

pub fn new_state() -> NetworkState {
    // Optimistic until the first probe lands — a fresh launch shouldn't flash
    // "離線" for the half-second before we know.
    NetworkState { online: Arc::new(AtomicBool::new(true)) }
}

pub fn is_online(app: &AppHandle) -> bool {
    app.state::<NetworkState>().online.load(Ordering::Relaxed)
}

async fn provider_host(cfg: &SharedConfig) -> &'static str {
    let cfg = cfg.lock().await;
    if cfg.api.provider == "openai" {
        "api.openai.com"
    } else {
        "api.anthropic.com"
    }
}

async fn probe(host: &str) -> bool {
    let addr = format!("{host}:443");
    matches!(
        tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

fn publish(app: &AppHandle, online: bool) {
    let _ = app.emit("network:status", serde_json::json!({ "online": online }));
}

/// Start the background monitor. Call once from `setup`.
pub fn spawn_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<NetworkState>().inner().clone();
        let cfg: SharedConfig = app.state::<SharedConfig>().inner().clone();
        let mut first = true;
        loop {
            let host = provider_host(&cfg).await;
            let online = probe(host).await;
            let prev = state.online.swap(online, Ordering::Relaxed);
            if first || prev != online {
                publish(&app, online);
                first = false;
            }
            tokio::time::sleep(if online { ONLINE_INTERVAL } else { OFFLINE_INTERVAL }).await;
        }
    });
}

/// Current cached reachability (no probe).
#[tauri::command]
pub async fn network_status(state: tauri::State<'_, NetworkState>) -> Result<bool, String> {
    Ok(state.online.load(Ordering::Relaxed))
}

/// Probe the active provider right now, update the cached state and publish
/// `network:status` on a change. Used by the 重新檢查 button and by
/// `translator::post_llm_with_retry` the moment a request fails at the
/// transport level, so a dropped link flips the UI to "paused" within one
/// probe instead of after the whole retry ladder plus the next 20 s tick.
pub async fn probe_now(app: &AppHandle) -> bool {
    let cfg: SharedConfig = app.state::<SharedConfig>().inner().clone();
    let host = provider_host(&cfg).await;
    let online = probe(host).await;
    let prev = app.state::<NetworkState>().online.swap(online, Ordering::Relaxed);
    if prev != online {
        publish(app, online);
    }
    online
}

/// Probe right now (e.g. the user pressed 重新檢查) and publish the result.
#[tauri::command]
pub async fn network_probe_now(app: AppHandle) -> Result<bool, String> {
    Ok(probe_now(&app).await)
}
