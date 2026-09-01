//! Loaf — a private desktop companion.
//!
//! The native half: four windows, the tray, the platform probe, and the one
//! file on disk.
//!
//!   companion  the pet. Transparent, undecorated, always on top, no taskbar
//!              or Dock entry. Owns all state; the others only display it.
//!   dashboard  today's time. A normal window you read and close.
//!   closet     who is on duty and what they are wearing.
//!   bubble     speech and the hover preview. Transparent, never takes focus.
//!
//! Everything OS-specific below the window layer terminates in `platform`.
//! Adding a window means adding it to `capabilities/default.json` too, or its
//! core calls are denied at runtime with no error the user would ever see.
//!
//! No network code exists in this crate, and none should. That is the product's
//! central promise and it is enforced by review, not by comment.

pub mod browser;
#[cfg(windows)]
pub mod browser_windows;
pub mod packs;
pub mod platform;
pub mod scroll;
pub mod sounds;
pub mod storage;

use platform::{ForegroundApp, PlatformProbe};
use serde::Serialize;
// Brings `get_webview_window` and friends into scope on `App`/`AppHandle`.
use tauri::{Emitter, Manager};

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

/// Ask a browser what its active tab's domain is, and how many tabs are open.
///
/// The caller passes the bundle identifier it already matched, rather than this
/// searching for a browser itself — the radar decides who is worth asking and
/// when, and the answer must never be "some browser I found running".
// `(async)` on a synchronous function is what moves it to Tauri's thread pool;
// without it the body runs inline on the main thread. A UI Automation walk of a
// browser's window tree takes long enough to be seen as a stutter, and freezing
// the companion is not an acceptable price for reading a domain. `Apartment`
// already assumes it is running on a pool thread and enters COM per call.
#[tauri::command(async)]
fn probe_browser(bundle_id: String, safari: bool) -> browser::ProbeOutcome {
    // Long enough that a first-time permission prompt can be read and answered,
    // short enough that a wedged browser does not hold a tick open.
    browser::probe(&bundle_id, safari, 8)
}

/// Whether this build can read tabs, and whether it does so inside the browser.
///
/// The second half is not a detail: on macOS the URL is truncated before it
/// leaves the browser, and on Windows it is not. The dashboard says which.
#[derive(Debug, Serialize)]
pub struct RadarSupport {
    pub supported: bool,
    #[serde(rename = "readsInsideBrowser")]
    pub reads_inside_browser: bool,
}

#[tauri::command]
fn browser_probe_supported() -> RadarSupport {
    RadarSupport {
        supported: browser::supported(),
        reads_inside_browser: browser::reads_inside_the_browser(),
    }
}

/// Seconds since the wheel last moved, or null where that cannot be known.
///
/// The pose it drives is cosmetic, so a platform with no answer simply never
/// strikes it — see `scroll.rs` for what this is deliberately not.
#[tauri::command]
fn seconds_since_scroll() -> Option<f64> {
    scroll::seconds_since_scroll()
}

/// How long since a key was pressed. Timing only — see `scroll.rs`.
#[tauri::command]
fn seconds_since_typing() -> Option<f64> {
    scroll::seconds_since_typing()
}

/// How hard the foreground application is working, 0..100.
///
/// The signal behind "he waits with you": a build, a render, a model thinking.
/// Loaf cannot know WHICH of those it is, and does not try — it knows the
/// window in front of you is busy, which is the honest version of the feature
/// and the one that works for every long job rather than one vendor's.
///
/// Two samples a short time apart, because CPU time is a counter and a
/// percentage is a rate. `None` when the OS will not say.
#[tauri::command(async)]
fn foreground_cpu() -> Option<f64> {
    platform::foreground_cpu()
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
    // Windows runs the WM_NCLBUTTONDOWN move loop only for a foreground window,
    // and it grants SetForegroundWindow only to the process that received the
    // last input event. The click that got us here IS that input, so this is the
    // one moment the request is granted. The companion is created unfocused on
    // purpose — an ambient pet must not steal focus at launch — which means it
    // otherwise never holds foreground rights and `start_dragging` returns Ok
    // while Windows quietly does nothing.
    let _ = window.set_focus();
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

/// Every hand-drawn character in the Characters folder.
#[tauri::command]
fn sprite_packs(app: tauri::AppHandle) -> Result<Vec<packs::LoadedPack>, String> {
    Ok(packs::load_all(&data_dir(&app)?))
}

/// Make the Characters folder, write the format guide, and open it.
#[tauri::command]
fn open_packs_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = packs::ensure(&data_dir(&app)?)?;
    open_in_file_manager(&dir.to_string_lossy())
}

/// Which occasions the user has supplied a sound for.
///
/// Names only. The bytes come from `read_sound`, and no path ever crosses to
/// the frontend.
#[tauri::command]
fn user_sounds(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(sounds::index(&data_dir(&app)?)
        .into_iter()
        .map(|(occasion, _)| occasion)
        .collect())
}

/// One user sound, as a mime type and bytes, for the frontend to wrap in a blob.
#[tauri::command]
fn read_sound(
    app: tauri::AppHandle,
    occasion: String,
) -> Result<Option<(String, Vec<u8>)>, String> {
    Ok(sounds::read(&data_dir(&app)?, &occasion))
}

/// Make the folder, write the README explaining it, and open it.
///
/// Creating it here is fine because the user asked; creating it on launch would
/// not be, which is why nothing else does.
#[tauri::command]
fn open_sounds_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = sounds::ensure(&data_dir(&app)?)?;
    open_in_file_manager(&dir.to_string_lossy())
}

/// Show a folder we made, in whatever the platform calls its file manager.
///
/// Only ever called with a path this app just created, never with one that came
/// from the frontend.
fn open_in_file_manager(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
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
/// The one menu, built in one place.
///
/// The tray shows it and so does a right-click on the companion. Two menus
/// listing the same commands would drift the first time an item was added to
/// one of them, and on Windows the tray icon is filed into a hidden overflow
/// flyout by default — an entry point most users never find. Right-clicking the
/// character is the discoverable route, and it has to offer everything, not a
/// convenience subset.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let stats = MenuItem::with_id(app, "stats", "Today's time…", true, None::<&str>)?;
    let closet = MenuItem::with_id(app, "closet", "Closet…", true, None::<&str>)?;
    let focus = MenuItem::with_id(app, "focus", "Focus timer…", true, None::<&str>)?;
    let sounds_item = MenuItem::with_id(app, "sounds", "Add your own sounds…", true, None::<&str>)?;
    // Phrased as an invitation and placed with the other ordinary items — not a
    // prompt, not a gate, and never checked at runtime. See STAR_URL.
    let recap = MenuItem::with_id(app, "recap", "Save this week’s recap…", true, None::<&str>)?;
    let star = MenuItem::with_id(app, "star", "Star Loaf on GitHub ★", true, None::<&str>)?;
    let packs_item =
        MenuItem::with_id(app, "packs", "Draw your own character…", true, None::<&str>)?;
    // Sends him to sleep NOW, rather than waiting for the idle threshold.
    //
    // "and go quiet" is in the label because that is what it actually does, and
    // a menu item that promises a nap while silencing your reminders is a
    // setting pretending to be a mood. Asleep means: no nudges, no water
    // reminder, no hyperfocus check-in, no tantrum, no sounds. He keeps
    // tracking your time — that is the part you did not ask him to stop.
    let sleep = MenuItem::with_id(
        app,
        "sleep",
        "Send him to sleep, and go quiet",
        true,
        None::<&str>,
    )?;
    let reset = MenuItem::with_id(app, "reset", "Reset today's stats", true, None::<&str>)?;
    let forget = MenuItem::with_id(app, "forget", "Forget all site data", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "About Loaf", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Loaf", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &focus,
            &stats,
            &closet,
            &sounds_item,
            &packs_item,
            &recap,
            &PredefinedMenuItem::separator(app)?,
            &sleep,
            &reset,
            &forget,
            &PredefinedMenuItem::separator(app)?,
            &about,
            &star,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    Ok(menu)
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;

    let menu = build_menu(app)?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Loaf")
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "stats" => {
                    if let Err(e) = show_dashboard(app) {
                        eprintln!("could not open the dashboard: {e}");
                    }
                }
                "closet" => {
                    if let Err(e) = show_closet(app) {
                        eprintln!("could not open the closet: {e}");
                    }
                }
                "focus" => {
                    if let Err(e) = show_focus(app) {
                        eprintln!("could not open the focus timer: {e}");
                    }
                }
                "sounds" => {
                    if let Err(e) = open_sounds_folder(app.clone()) {
                        eprintln!("could not open the sounds folder: {e}");
                    }
                }
                "packs" => {
                    if let Err(e) = open_packs_folder(app.clone()) {
                        eprintln!("could not open the characters folder: {e}");
                    }
                }
                // These three are the same commands the dashboard sends, delivered
                // on the same channel — one handler for them, wherever they came
                // from, rather than a second path that can drift from the first.
                "recap" => send_command(app, "recap"),
                "sleep" => send_command(app, "sleep"),
                "reset" => send_command(app, "reset"),
                "forget" => send_command(app, "sites:forget"),
                "about" => send_command(app, "about"),
                "star" => open_star_page(),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// Hand a tray click to the companion window as a command.
fn send_command(app: &tauri::AppHandle, command: &str) {
    if let Err(e) = app.emit("loaf://command", command) {
        eprintln!("could not deliver {command}: {e}");
    }
}

/// The dashboard window.
///
/// A normal decorated window on purpose: this one is a document you read,
/// scroll and close, not the pet. Closing destroys it — Tauri's default — and
/// reopening builds it again, which costs a page load and buys a guarantee that
/// what you are looking at was read from disk just now.
///
/// If it already exists, it is raised instead of duplicated. Without that check
/// a second menu click fails on the duplicate label rather than doing the
/// obvious thing.
fn show_dashboard(app: &tauri::AppHandle) -> tauri::Result<()> {
    // On macOS the app runs as an Accessory (no Dock icon), and an Accessory
    // app's new windows open behind whatever is in front and never take
    // keyboard focus. A real window needs a real application around it, so the
    // policy goes back to Regular while one is open, and returns to Accessory
    // when it closes.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(DASHBOARD_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        DASHBOARD_LABEL,
        tauri::WebviewUrl::App("dashboard.html".into()),
    )
    .title("Loaf — today")
    .inner_size(560.0, 760.0)
    .min_inner_size(420.0, 480.0)
    .resizable(true)
    // Opened because the user asked for it, so it opens in FRONT. Activating
    // at creation beats raising afterwards, which races the window that spawned
    // it — that race is what buried the consent screen under the dashboard.
    .focused(true)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                // Back to being a pet. Unconditional because the dashboard is
                // the only window that wants a Dock icon — the companion is
                // deliberately hidden from it. A second such window would need
                // this to count them instead.
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
    // The binding is only used on macOS; naming it `_window` elsewhere would
    // read as an oversight rather than a platform difference.
    // A window built by a process that does not hold foreground rights opens
    // BEHIND everything and reads to the user as "it did not open" — while its
    // webview loads and runs perfectly, which is exactly how this hid.
    let _ = window.set_focus();

    Ok(())
}

const DASHBOARD_LABEL: &str = "dashboard";
const BUBBLE_LABEL: &str = "bubble";
const CLOSET_LABEL: &str = "closet";
const FOCUS_LABEL: &str = "focus";
const ONBOARDING_LABEL: &str = "onboarding";
const COMPANION_LABEL: &str = "companion";

/// Where the bubble ended up, so the page can point its tail at the character.
#[derive(Debug, Serialize)]
pub struct BubblePlacement {
    pub side: &'static str,
    #[serde(rename = "tailX")]
    pub tail_x: f64,
}

/// Size the bubble window to the card the page just measured and put it above
/// the companion — WITHOUT showing it.
///
/// Revealing is a separate step (`reveal_bubble`) because the placement decides
/// which side the tail hangs from, and the page has to re-render with that
/// answer before anyone sees it. Showing here instead would put one frame of
/// bubble on screen with its tail hanging off the corner of a short card.
///
/// Positioning lives here rather than in the page because only Rust can see the
/// companion's frame and the monitor it is on. The arithmetic itself is
/// duplicated from `src/bubble/geometry.ts`, which is where it is tested — this
/// is the same rules against the numbers the OS reports.
#[tauri::command]
fn place_bubble(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    interactive: bool,
) -> Result<BubblePlacement, String> {
    const EDGE: f64 = 8.0;
    const GAP: f64 = 4.0;

    let bubble = app
        .get_webview_window(BUBBLE_LABEL)
        .ok_or_else(|| "no bubble window".to_string())?;
    let companion = app
        .get_webview_window(COMPANION_LABEL)
        .ok_or_else(|| "no companion window".to_string())?;

    // The page measured in CSS pixels; windows are placed in physical ones.
    // Skipping this makes the bubble two thirds of its content on a 150% display
    // and clips the last line off every prompt.
    let scale = bubble.scale_factor().map_err(|e| e.to_string())?;
    let w = (width * scale).ceil();
    let h = (height * scale).ceil();

    let pos = companion.outer_position().map_err(|e| e.to_string())?;
    let size = companion.outer_size().map_err(|e| e.to_string())?;
    let (cx, cy) = (pos.x as f64, pos.y as f64);
    let (cw, ch) = (size.width as f64, size.height as f64);

    // Tauri exposes no work area, so the monitor's full bounds stand in and the
    // edge margin absorbs the difference. The same approximation the window walk
    // already makes.
    let monitor = companion
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let (mx, my) = (m_pos.x as f64, m_pos.y as f64);
    let (mw, mh) = (m_size.width as f64, m_size.height as f64);

    let min_x = mx + EDGE;
    let max_x = (mx + mw - w - EDGE).max(min_x);
    let x = (cx + cw / 2.0 - w / 2.0).clamp(min_x, max_x);

    let above = cy - h - GAP;
    let below = cy + ch + GAP;
    let top = my + EDGE;
    let bottom = my + mh - h - EDGE;

    let (y, side) = if above >= top {
        (above, "above")
    } else if below <= bottom {
        (below, "below")
    } else {
        (above.clamp(top, bottom.max(top)), "above")
    };

    // The preview is a peek, not something you interact with — it must not eat
    // a click aimed at whatever is behind it. The speech bubble does take
    // clicks, because clicking it is how you dismiss it.
    bubble
        .set_ignore_cursor_events(!interactive)
        .map_err(|e| e.to_string())?;
    bubble
        .set_size(tauri::PhysicalSize::new(w as u32, h as u32))
        .map_err(|e| e.to_string())?;
    bubble
        .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| e.to_string())?;

    // Tail offset back in CSS pixels, kept inside the rounded corners.
    let tail_x = ((cx + cw / 2.0 - x) / scale).clamp(18.0, (width - 18.0).max(18.0));
    Ok(BubblePlacement { side, tail_x })
}

/// Show the bubble, now that the page has re-rendered around its placement.
#[tauri::command]
fn reveal_bubble(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(bubble) = app.get_webview_window(BUBBLE_LABEL) {
        // Re-asserted on every reveal, not just at creation.
        //
        // The bubble is built hidden and shown over and over. Setting the flag
        // once on a window that has never been displayed does not reliably land
        // it in the topmost band, and the symptom is precise: the character sits
        // above your editor exactly as it should while the card that belongs to
        // him appears only when everything else is minimised. Asking again each
        // time costs one call on a window that is about to be shown anyway.
        let _ = bubble.set_always_on_top(true);
        bubble.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_bubble(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(bubble) = app.get_webview_window(BUBBLE_LABEL) {
        bubble.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The bubble window, built once at startup and hidden until something is said.
///
/// Created up front rather than on demand: it carries a whole webview, and
/// building one while the user is mid-hover would put the preview on screen
/// well after they had stopped looking.
fn build_bubble_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::new(
        app,
        BUBBLE_LABEL,
        tauri::WebviewUrl::App("bubble.html".into()),
    )
    .title("Loaf")
    .inner_size(240.0, 80.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    // Never steals focus: it appears while you are typing in another app, and a
    // pet that pulls the caret out of your editor to tell you to drink water has
    // done more harm than the advice is worth.
    .focused(false)
    .visible(false)
    .build()?;
    let _ = window;
    Ok(())
}

/// The closet: who sits on your desktop, and what they are wearing.
///
/// Same lifecycle as the dashboard — destroyed on close, rebuilt on reopen —
/// and the same macOS activation dance, for the same reason: an Accessory app's
/// windows open behind everything and never take focus.
fn show_closet(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(CLOSET_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        CLOSET_LABEL,
        tauri::WebviewUrl::App("closet.html".into()),
    )
    .title("Closet")
    .inner_size(CLOSET_WIDTH, 560.0)
    .min_inner_size(CLOSET_WIDTH, 320.0)
    // Floating, because the whole point is to watch the character in the corner
    // change as you click. A closet behind the window you were reading is a
    // picker you have to alt-tab away from to see the result of.
    .always_on_top(true)
    .resizable(true)
    // Opened because the user asked for it, so it opens in FRONT. Activating
    // at creation beats raising afterwards, which races the window that spawned
    // it — that race is what buried the consent screen under the dashboard.
    .focused(true)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
    // See show_dashboard: a process without foreground rights opens its windows
    // behind everything, which is indistinguishable from not opening at all.
    let _ = window.set_focus();

    Ok(())
}

const CLOSET_WIDTH: f64 = 500.0;

/// Open the dashboard from the frontend — what clicking the companion does.
///
/// Wraps the same function the tray menu calls, rather than duplicating the
/// window setup, so the two entry points cannot drift into opening two
/// differently configured windows.
// `(async)` moves this to Tauri's thread pool. `show()`, `unminimize()` and
// `set_focus()` dispatch to the event loop and BLOCK until it answers; run from
// a synchronous command they block the very thread that has to answer them, and
// the whole app deadlocks — the IPC queue included, which is why the trace goes
// silent rather than showing an error.
#[tauri::command(async)]
fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    show_dashboard(&app).map_err(|e| e.to_string())
}

/// Size the closet to its own content, and keep it on the screen.
///
/// The reference does the same through a `loafSize` message, for the reason it
/// gives: guessing a pixel height means clipping the last row of cards the day
/// someone adds a fifth animal. There are eighteen now, so that day has been
/// and gone.
// `(async)` moves this to Tauri's thread pool. `show()`, `unminimize()` and
// `set_focus()` dispatch to the event loop and BLOCK until it answers; run from
// a synchronous command they block the very thread that has to answer them, and
// the whole app deadlocks — the IPC queue included, which is why the trace goes
// silent rather than showing an error.
#[tauri::command(async)]
fn fit_closet(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    fit_window(&app, CLOSET_LABEL, CLOSET_WIDTH, height, 320.0)
}

/// The focus timer's window: a ring, a countdown, and six opinions about how
/// long a session should be.
///
/// Floating like the closet, and for the same reason — the dial and the ring at
/// the character's feet show the same session, and watching one while the other
/// is buried behind an editor defeats both.
fn show_focus(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(FOCUS_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        FOCUS_LABEL,
        tauri::WebviewUrl::App("focus.html".into()),
    )
    .title("Focus")
    .inner_size(FOCUS_WIDTH, 620.0)
    .min_inner_size(FOCUS_WIDTH, 380.0)
    .always_on_top(true)
    .resizable(true)
    // Opened because the user asked for it, so it opens in FRONT. Activating
    // at creation beats raising afterwards, which races the window that spawned
    // it — that race is what buried the consent screen under the dashboard.
    .focused(true)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
    // See show_dashboard: a process without foreground rights opens its windows
    // behind everything, which is indistinguishable from not opening at all.
    let _ = window.set_focus();

    Ok(())
}

const FOCUS_WIDTH: f64 = 420.0;
const ONBOARDING_WIDTH: f64 = 560.0;

/// The privacy radar's consent screen.
///
/// Shown once, before the radar has looked at anything. Not always-on-top,
/// unlike the closet and the focus window: this one is a decision to read, not
/// something to watch the character react to, and a consent screen that floats
/// over everything while you try to look something up is a dark pattern.
fn show_onboarding(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(ONBOARDING_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        ONBOARDING_LABEL,
        tauri::WebviewUrl::App("onboarding.html".into()),
    )
    .title("Loaf — privacy radar")
    .inner_size(ONBOARDING_WIDTH, 620.0)
    .min_inner_size(ONBOARDING_WIDTH, 360.0)
    .resizable(true)
    .center()
    // Opened because the user asked for it, so it opens in FRONT. Activating
    // at creation beats raising afterwards, which races the window that spawned
    // it — that race is what buried the consent screen under the dashboard.
    .focused(true)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
    // See show_dashboard: a process without foreground rights opens its windows
    // behind everything, which is indistinguishable from not opening at all.
    let _ = window.set_focus();

    Ok(())
}

/// Open the consent screen from the frontend — what the dashboard's "turn on
/// privacy radar" button does, rather than switching it on without asking.
/// Two taps on the character put the dashboard away.
///
/// Closed rather than hidden: a hidden window keeps its webview alive, its
/// timers running and its stale numbers in memory, and the next tap would show
/// yesterday's figures until a re-read landed. Closing costs one page load and
/// guarantees what is on screen was read from disk when it appeared.
///
/// Silent when there is no dashboard open — a second tap on a character with
/// nothing showing has nothing to close, and that is not an error.
#[tauri::command(async)]
fn close_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    match app.get_webview_window(DASHBOARD_LABEL) {
        Some(window) => window.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// The star invitation, reachable from the dashboard as well as the menu.
///
/// Still an invitation. Nothing checks whether it was clicked, no state is kept
/// about it, and no feature is withheld from anyone who ignores it.
#[tauri::command(async)]
fn open_star() -> Result<(), String> {
    open_star_page();
    Ok(())
}

/// Feature requests, in the browser rather than in a form Loaf would have to send.
#[tauri::command(async)]
fn open_feedback() -> Result<(), String> {
    open_feedback_page();
    Ok(())
}

/// Where the pointer is, in physical screen pixels.
///
/// Used for one thing: pointing the pupils at it, so a still character still
/// reads as awake.
///
/// WHAT THIS IS NOT. It is not input monitoring. One question is asked — the
/// cursor's current position — which is the same question any window asks to
/// draw a hover state, needs no permission on either platform, and reveals
/// nothing about what is clicked, typed, or on screen. Nothing is stored; the
/// answer is used for a frame and replaced by the next one.
///
/// Tauri exposes this cross-platform already, so there is no second
/// implementation to keep in step and nothing to add to `platform`.
#[tauri::command]
fn cursor_pos(window: tauri::Window) -> Option<(f64, f64)> {
    window.cursor_position().ok().map(|p| (p.x, p.y))
}

/// Put a window on every desktop, not just the one it was born on.
///
/// macOS Spaces are the reason this exists. A window belongs to the Space it
/// was created on, so a pet launched on Space 1 vanishes the moment you swipe
/// to Space 2 — and cannot be dragged across, because there is nothing to grab.
/// The first Mac testers reported exactly that: "not visible over all screens"
/// and "cannot shift the cat from one screen to the other".
///
/// An ambient companion is the textbook case for joining all Spaces: it is not
/// a document window that belongs to one piece of work, it is furniture.
///
/// A no-op on Windows, where a window is already on every virtual desktop it is
/// told to be; harmless to call there.
fn follow_the_user(window: &tauri::WebviewWindow) {
    let _ = window.set_visible_on_all_workspaces(true);
}

/// Write a recap card to a file the user can find and post.
///
/// Loaf saves a PNG and stops there. It does not upload it, does not post it,
/// and does not ask for an account to do either — the user shares it if they
/// feel like it, from their own machine, to wherever they like. That is the
/// whole growth loop, and it is the only one available to a product that makes
/// no network calls.
///
/// Returns the path, so the caller can tell the user where it went rather than
/// leaving them to guess.
#[tauri::command(async)]
fn save_recap(app: tauri::AppHandle, png: Vec<u8>, name: String) -> Result<String, String> {
    // Rejected before anything is written: a caller that hands us an empty
    // buffer has a bug, and a 0-byte .png on someone's disk looks like ours.
    if png.is_empty() {
        return Err("nothing to save".into());
    }
    // The name is built by us, but it reaches this function as a string, so it
    // is checked rather than trusted: no separators, no traversal, no surprises
    // about which directory this ends up writing to.
    if name.is_empty()
        || name.len() > 80
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        || name.contains("..")
    {
        return Err("bad filename".into());
    }

    let dir = data_dir(&app)?.join("LoafPlus").join("Recaps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// The running build's version.
///
/// Read from the binary's own package info rather than passed in from the
/// frontend, so it cannot drift: a version the JS believes and a version the
/// user is actually running are the same number here by construction. A bug
/// report naming the wrong build is worse than one naming none.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Open the closet without going through the tray.
///
/// The tray stays the product's entry point, but it cannot be the only one. An
/// icon Windows has filed into the overflow flyout is an entry point the user
/// cannot find, and until now the closet and the focus timer were reachable
/// from nowhere else — one hidden icon made two whole windows unreachable.
// `(async)` moves this to Tauri's thread pool. `show()`, `unminimize()` and
// `set_focus()` dispatch to the event loop and BLOCK until it answers; run from
// a synchronous command they block the very thread that has to answer them, and
// the whole app deadlocks — the IPC queue included, which is why the trace goes
// silent rather than showing an error.
#[tauri::command(async)]
fn open_closet(app: tauri::AppHandle) -> Result<(), String> {
    show_closet(&app).map_err(|e| e.to_string())
}

/// Show the whole menu where the user actually is: on the character.
///
/// Right-clicking the companion is the entry point people find without being
/// told. The menu is the same object the tray builds, so the two can never
/// list different commands, and its clicks land in the same handler — the
/// tray's `on_menu_event` is registered in Tauri's GLOBAL listener list, not a
/// tray-private one, so a popup menu's events reach it with nothing extra
/// wired up.
#[tauri::command(async)]
fn show_companion_menu(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    use tauri::menu::ContextMenu;
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    menu.popup(window).map_err(|e| e.to_string())
}

/// The focus timer's window, for the same reason as [`open_closet`].
// `(async)` moves this to Tauri's thread pool. `show()`, `unminimize()` and
// `set_focus()` dispatch to the event loop and BLOCK until it answers; run from
// a synchronous command they block the very thread that has to answer them, and
// the whole app deadlocks — the IPC queue included, which is why the trace goes
// silent rather than showing an error.
#[tauri::command(async)]
fn open_focus(app: tauri::AppHandle) -> Result<(), String> {
    show_focus(&app).map_err(|e| e.to_string())
}

// `(async)` moves this to Tauri's thread pool. `show()`, `unminimize()` and
// `set_focus()` dispatch to the event loop and BLOCK until it answers; run from
// a synchronous command they block the very thread that has to answer them, and
// the whole app deadlocks — the IPC queue included, which is why the trace goes
// silent rather than showing an error.
#[tauri::command(async)]
fn open_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    show_onboarding(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ONBOARDING_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn fit_onboarding(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    fit_window(&app, ONBOARDING_LABEL, ONBOARDING_WIDTH, height, 360.0)
}

/// Open the macOS Automation settings pane, where a refused browser is undone.
#[tauri::command]
fn open_automation_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
            .spawn();
    }
}

/// Size the focus window to its content. Same reasoning as `fit_closet`: a
/// guessed height clips the footer the day the copy grows by a line.
// `(async)` moves this to Tauri's thread pool. `show()`, `unminimize()` and
// `set_focus()` dispatch to the event loop and BLOCK until it answers; run from
// a synchronous command they block the very thread that has to answer them, and
// the whole app deadlocks — the IPC queue included, which is why the trace goes
// silent rather than showing an error.
#[tauri::command(async)]
fn fit_focus(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    fit_window(&app, FOCUS_LABEL, FOCUS_WIDTH, height, 380.0)
}

/// Resize one of the content-sized windows, clamped to the monitor.
///
/// Shared because the closet and the focus window want exactly the same
/// behaviour, and two copies of a clamp is how one of them ends up able to open
/// taller than the screen.
fn fit_window(
    app: &tauri::AppHandle,
    label: &str,
    width: f64,
    height: f64,
    minimum: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no {label} window"))?;

    let available = match window.current_monitor() {
        Ok(Some(m)) => (m.size().height as f64 / m.scale_factor()) - 80.0,
        _ => 800.0,
    };
    window
        .set_size(tauri::LogicalSize::new(
            width,
            height.clamp(minimum, available.max(minimum)),
        ))
        .map_err(|e| e.to_string())
}

/// The repository, opened in the user's browser from the tray menu.
///
/// A CONSTANT, and the open function takes no argument. The menu item is an
/// invitation to star the project — it is never a condition of running Loaf,
/// nothing checks whether it was clicked, and no network call is made to find
/// out. Beyond that being the product decision, gating an app on stars is rank
/// abuse under GitHub's Acceptable Use Policies.
///
/// Hard-coding it also removes the injection surface: `open_star_page` cannot
/// be handed a path or a `file://` URL because it cannot be handed anything.
const STAR_URL: &str = "https://github.com/yokshith09/LOAFV2-TAURI-";

/// Where feature requests go.
///
/// Discussions rather than a form inside the app, and that is the whole point:
/// a form Loaf could submit would need to reach the network, and "Loaf itself
/// does not upload your data or make AI/network calls" would stop being true
/// the moment it did. Handing the URL to the browser keeps the network the
/// browser's, and the promise intact.
///
/// Issues, NOT Discussions. Discussions has to be switched on per repository
/// and is off by default, so `/discussions` 404s on a repo that never enabled
/// it — which is exactly what it did. `/issues/new` exists on any public repo
/// with issues left on, and lands the user straight in the form.
///
/// Hard-coded for the same reason as [`STAR_URL`]: a function that cannot be
/// handed a URL cannot be handed a `file://` one.
const FEEDBACK_URL: &str = "https://github.com/yokshith09/LOAFV2-TAURI-/issues/new";

/// Hand one of our two fixed URLs to the browser.
fn open_url(url: &'static str) {
    // Deliberately not the opener plugin: this is one fixed URL, and a new
    // dependency is a new way for a build to fail on a machine that already
    // cannot compile locally.
    #[cfg(windows)]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(e) = result {
        eprintln!("could not open {url}: {e}");
    }
}

fn open_star_page() {
    open_url(STAR_URL);
}

fn open_feedback_page() {
    open_url(FEEDBACK_URL);
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

            // Windows needs a listener running; macOS polls and this is a no-op.
            scroll::start();

            build_tray(app.handle())?;
            build_bubble_window(app.handle())?;

            if let Some(window) = app.get_webview_window(COMPANION_LABEL) {
                park_bottom_right(&window);
                follow_the_user(&window);
            }
            if let Some(bubble) = app.get_webview_window(BUBBLE_LABEL) {
                // The card has to follow him. A companion on every Space whose
                // speech bubble is stuck on Space 1 is worse than neither.
                follow_the_user(&bubble);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            foreground_app,
            idle_seconds,
            seconds_since_scroll,
            seconds_since_typing,
            foreground_cpu,
            platform_name,
            start_drag,
            close_dashboard,
            app_version,
            save_recap,
            cursor_pos,
            open_star,
            open_feedback,
            open_closet,
            open_focus,
            show_companion_menu,
            read_stats,
            write_stats,
            probe_browser,
            browser_probe_supported,
            sprite_packs,
            open_packs_folder,
            user_sounds,
            read_sound,
            open_sounds_folder,
            open_dashboard,
            fit_closet,
            fit_focus,
            fit_onboarding,
            open_onboarding,
            close_onboarding,
            open_automation_settings,
            place_bubble,
            reveal_bubble,
            hide_bubble
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
