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
pub mod storage;

use platform::{ForegroundApp, PlatformProbe};
use serde::Serialize;
// Brings `get_webview_window` and friends into scope on `App`/`AppHandle`.
use tauri::Manager;

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

/// Begin an OS-level window drag.
///
/// The frontend calls this once it has decided a mouse-down is a drag rather
/// than a click, so the companion can be picked up and moved without losing
/// click-to-interact. Dragging is deliberately NOT done with a drag region:
/// a region covering the whole window swallows every click, and the earlier
/// attempt used `-webkit-app-region`, which is an Electron API that Tauri
/// ignores entirely — the first Mac build could not be moved at all.
#[tauri::command]
fn start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

/// The OS data directory — `~/Library/Application Support` or `%APPDATA%`.
///
/// Note this is `data_dir`, not `app_data_dir`: the latter appends the bundle
/// identifier, and the history we have to keep reading lives under a literal
/// `LoafPlus` folder. See [`storage`] for why that matters.
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().data_dir().map_err(|e| e.to_string())
}

/// The whole screen-time history as written on disk, or `null` if there is none.
///
/// Errors are returned rather than swallowed. "Could not read the file" must not
/// arrive at the tracker looking like "you have no history", or the next save
/// overwrites months of data with an empty day.
#[tauri::command]
fn read_stats(app: tauri::AppHandle) -> Result<Option<String>, String> {
    storage::read_or_inherit(&data_dir(&app)?)
}

#[tauri::command]
fn write_stats(app: tauri::AppHandle, json: String) -> Result<(), String> {
    storage::write_atomic(&data_dir(&app)?, &json)
}

/// Park the companion in the bottom-right of the work area, the way the Swift
/// original does on first launch.
///
/// Without this the OS picks, which puts it dead centre of the screen — the
/// first Mac test build opened over whatever the tester was working on.
fn park_bottom_right(window: &tauri::WebviewWindow) {
    const MARGIN: i32 = 24;
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let x = origin.x + screen.width as i32 - size.width as i32 - MARGIN;
    // Extra bottom margin clears the macOS Dock / Windows taskbar. Tauri does
    // not expose the work area, so this is a deliberate approximation rather
    // than a computed inset.
    let y = origin.y + screen.height as i32 - size.height as i32 - MARGIN * 3;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// The tray icon and its menu.
///
/// This is not optional polish. On macOS the app hides itself from the Dock
/// (see the activation policy below), so without a tray entry there is no way
/// left to quit — the first Mac tester had to force it closed from the Dock,
/// and removing the Dock icon without adding this would have made it strictly
/// worse.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let quit = MenuItem::with_id(app, "quit", "Quit Loaf", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Loaf")
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // A desktop pet is an accessory, not an application: no Dock icon,
            // no app switcher entry, and it never steals focus. This is the
            // macOS half of what `skipTaskbar` does on Windows, and the
            // equivalent of LSUIElement in the Swift original's Info.plist.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;

            if let Some(window) = app.get_webview_window("companion") {
                park_bottom_right(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            foreground_app,
            idle_seconds,
            platform_name,
            start_drag,
            read_stats,
            write_stats
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
