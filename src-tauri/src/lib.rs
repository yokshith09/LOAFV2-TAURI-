//! Loaf — a private desktop companion.
//!
//! Phase 0 of the Tauri rewrite. The goal of this phase is not features: it is
//! to prove the three things that would invalidate the whole architecture if
//! they did not hold —
//!   1. a transparent, always-on-top, undecorated window on both platforms,
//!   2. the character rendering smoothly in a webview canvas,
//!   3. one platform-adapter seam that hides the OS from everything above it.
//!
//! No network code exists in this crate, and none should. That is the product's
//! central promise and it is enforced by review, not by comment.

pub mod platform;

use platform::{ForegroundApp, PlatformProbe};
use serde::Serialize;

/// What the frontend receives when it asks what is in front.
///
/// Note the shape: `app` is optional and `reason` explains its absence. The UI
/// must be able to tell "nothing focused" from "the OS refused us" from "it
/// worked" — collapsing those into an empty string is how a tracker starts
/// quietly inventing data.
#[derive(Debug, Serialize)]
pub struct ForegroundReport {
    pub app: Option<ForegroundApp>,
    pub reason: Option<String>,
    pub platform: &'static str,
}

#[tauri::command]
fn foreground_app() -> ForegroundReport {
    let probe = platform::native();
    match probe.foreground_app() {
        Ok(app) => ForegroundReport {
            app,
            reason: None,
            platform: probe.platform_name(),
        },
        Err(e) => ForegroundReport {
            app: None,
            reason: Some(e.to_string()),
            platform: probe.platform_name(),
        },
    }
}

#[tauri::command]
fn idle_seconds() -> Option<f64> {
    platform::native().idle_seconds().ok().flatten()
}

#[tauri::command]
fn platform_name() -> &'static str {
    platform::native().platform_name()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            foreground_app,
            idle_seconds,
            platform_name
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loaf");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_report_always_names_its_platform() {
        let r = foreground_app();
        assert!(!r.platform.is_empty());
    }

    #[test]
    fn foreground_report_never_claims_an_app_and_a_failure_at_once() {
        let r = foreground_app();
        assert!(
            !(r.app.is_some() && r.reason.is_some()),
            "report must not carry both an app and a failure reason"
        );
    }

    #[test]
    fn report_serialises_to_the_shape_the_frontend_expects() {
        let json = serde_json::to_value(foreground_app()).unwrap();
        assert!(json.get("app").is_some());
        assert!(json.get("platform").is_some());
    }
}
