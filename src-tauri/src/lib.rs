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
//!
//! ONE THING QUALIFIES THAT NOW, and it is better said here than discovered.
//! `connections` lets the user attach an MCP server: another program, chosen by
//! them, that Loaf starts and talks to over a pipe. Loaf still opens no sockets.
//! The program on the other end may open as many as it likes, and Loaf can
//! neither see nor stop it. So the promise that survives is "Loaf makes no
//! network calls", and it stops being a useful description of the whole system
//! the moment a server is connected. Nothing is connected by default, nothing
//! starts until it is used, and every call is written to a log the user can
//! read. See `connections.rs` for why each of those is load-bearing.

pub mod apps;
pub mod audio;
pub mod browser;
// NOT gated to macOS. Only the `osascript` call inside it is; the script text
// and the escaping are pure string work, and gating them would mean the one
// place a mistake is an injection could never be tested on the machine this is
// developed on. See the note at the top of the file.
pub mod browser_macos;
#[cfg(windows)]
pub mod browser_windows;
pub mod connections;
pub mod control;
pub mod mcp;
pub mod mcp_client;
pub mod packs;
pub mod platform;
pub mod remote;
pub mod scroll;
pub mod sounds;
pub mod speak;
pub mod speech;
pub mod storage;
pub mod store;
pub mod transcribe;
pub mod turn;
pub mod vad;
pub mod wake;
pub mod watch;
pub mod whisper_setup;

use platform::{ForegroundApp, PlatformProbe};
use rusqlite::OptionalExtension;
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
    storage::write_atomic(&data_dir(&app)?, &json)?;

    // AND INTO THE STORE, the same dual write save_meetings does and for the
    // same reasons: the file stays the source of truth so nothing that reads it
    // breaks and an older build loses nothing, while the store gets the copy
    // that can be queried a day at a time instead of by reading the whole
    // history into memory.
    //
    // A failure here must NOT fail the command. write_atomic above is what the
    // tracker actually depends on, and losing a queryable copy is not worth
    // losing somebody's day.
    if let Err(e) = with_store(&app, |c| store::import_stats(c, &json)) {
        eprintln!("loaf/store could not index the history: {e}");
    }
    Ok(())
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
    // THE ONLY WAY BACK FROM AN INVISIBLE PET, and until now there was none.
    //
    // A transparent, undecorated, no-taskbar window that ends up off-screen,
    // behind the Dock, on another Space, or simply never shown is
    // indistinguishable from a crash: the app is running, and there is nothing
    // to click. That happened on macOS with a Dock icon showing and no
    // character anywhere, and the honest answer was that the app had no
    // recovery path at all.
    //
    // This does not diagnose why he went; it puts him back. Shown, on top,
    // re-parked bottom right, and pulled onto the current Space — the four
    // things any of the causes would need undone.
    let find = MenuItem::with_id(
        app,
        "find",
        "Can’t see him? Bring him back",
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
            &find,
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
                "find" => bring_him_back(app),
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
/// Print where the companion actually ended up.
///
/// Costs one line of stderr per launch and is the only way anybody on a Mac can
/// tell "the window was never shown" from "the window is at -20000,50" from
/// "the window is fine and the drawing failed". Two testers have now reported
/// the same empty screen, and neither report could distinguish those.
fn describe_the_companion(window: &tauri::WebviewWindow) {
    let pos = window.outer_position();
    let size = window.outer_size();
    let visible = window.is_visible();
    let scale = window.scale_factor();
    eprintln!("loaf/companion position={pos:?} size={size:?} visible={visible:?} scale={scale:?}");
    match window.current_monitor() {
        Ok(Some(m)) => eprintln!(
            "loaf/monitor name={:?} position={:?} size={:?} scale={}",
            m.name(),
            m.position(),
            m.size(),
            m.scale_factor()
        ),
        Ok(None) => eprintln!("loaf/monitor NONE — the window is on no monitor"),
        Err(e) => eprintln!("loaf/monitor could not be read: {e}"),
    }
}

/// Keep the character on screen no matter which Space you switch to.
///
/// THIS WAS HALF THE FIX. `set_visible_on_all_workspaces` sets exactly one
/// Cocoa flag, `NSWindowCollectionBehaviorCanJoinAllSpaces` — which follows you
/// between ordinary Spaces and does nothing at all the moment another app goes
/// full screen, because macOS treats a full-screen app as its own separate
/// Space with its own rule: a window needs the SEPARATE
/// `FullScreenAuxiliary` flag to be allowed to float above one. Without it,
/// "the cat is only on my main desktop" is exactly what a full-screen browser,
/// call or editor produces — which for most people covers most of the day.
///
/// `tao` (the windowing crate under Tauri) has a method for the first flag and
/// none for the second, so this reaches the one flag it does not expose the
/// same way `control.rs` reaches DisplayServices: directly, through the
/// system's own Objective-C runtime. `NSWindowCollectionBehavior` is a public,
/// documented AppKit enum — this is not a private API, and it needs no new
/// dependency: `objc2`'s own machinery already sits in `Cargo.lock` because
/// `tao` depends on it, we are simply not routing through it, to avoid pinning
/// this file to that crate's exact macro syntax for one enum bit this machine
/// cannot compile to check.
fn follow_the_user(window: &tauri::WebviewWindow) {
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(target_os = "macos")]
    macos::add_full_screen_auxiliary(window);
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_void, CString};

    /// `NSWindowCollectionBehaviorFullScreenAuxiliary`, from AppKit's public
    /// `NSWindowCollectionBehavior` enum. A fixed bit position Apple has not
    /// moved since it shipped in Mac OS X 10.5 — see
    /// `NSWindow.h`/`NSWindowCollectionBehavior` in the AppKit headers.
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;

    // The Objective-C runtime's own C entry point. Declared with a fixed,
    // 2-argument shape because Rust needs SOME concrete signature to name a
    // function pointer by; every call below transmutes it to the exact shape
    // that call actually needs before using it. This is the same technique
    // every hand-written Rust/Objective-C bridge uses in place of a bridging
    // crate — `objc_msgSend`'s real C signature is `(id, SEL, ...)`, which
    // Rust cannot call directly, and the transmute is what stands in for the
    // variadic part C itself resolves at compile time.
    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const std::os::raw::c_char) -> *mut c_void;
        fn objc_msgSend(receiver: *mut c_void, selector: *mut c_void) -> usize;
    }

    fn selector(name: &str) -> Option<*mut c_void> {
        let cname = CString::new(name).ok()?;
        // SAFETY: `cname` is a valid, NUL-terminated C string for the lifetime
        // of this call. `sel_registerName` cannot fail for a well-formed name.
        Some(unsafe { sel_registerName(cname.as_ptr()) })
    }

    /// Add the one collection-behaviour bit `tao` does not set, without
    /// disturbing whatever else is already on the window (Tauri's own
    /// transparency and always-on-top setup among them) — read the current
    /// value and OR the new bit into it, never overwrite.
    pub fn add_full_screen_auxiliary(window: &tauri::WebviewWindow) {
        let Ok(ns_window) = window.ns_window() else {
            return;
        };
        if ns_window.is_null() {
            return;
        }
        let (Some(get_behavior), Some(set_behavior)) = (
            selector("collectionBehavior"),
            selector("setCollectionBehavior:"),
        ) else {
            return;
        };

        // SAFETY: `ns_window` is a live NSWindow* for as long as this function
        // runs — it comes straight from Tauri, which owns the window. Both
        // selectors exist on every NSWindow; `collectionBehavior` returns an
        // `NSUInteger` (word-sized, hence `usize`) and `setCollectionBehavior:`
        // takes one back and returns nothing, so this is exactly the
        // "read one word out, write one word in" case plain `objc_msgSend`
        // handles correctly — no struct is crossing this boundary, so there is
        // no need for the `objc_msgSend_stret` variant that struct-returning
        // Objective-C calls require instead.
        unsafe {
            let get: extern "C" fn(*mut c_void, *mut c_void) -> usize =
                std::mem::transmute(objc_msgSend as *const ());
            let current = get(ns_window, get_behavior);

            let set: extern "C" fn(*mut c_void, *mut c_void, usize) =
                std::mem::transmute(objc_msgSend as *const ());
            set(ns_window, set_behavior, current | FULL_SCREEN_AUXILIARY);
        }
    }
}

/// Put the companion somewhere the user can actually see him.
///
/// Every step is a separate `let _ =` rather than a chain, because these are
/// four independent recoveries and the one that would have helped must not be
/// skipped because an earlier one failed. If he is off-screen, re-parking is
/// what fixes it; if he was never shown, `show` is; if he is on another Space,
/// the workspace call is. We do not know which, so we do all of them.
///
/// Also prints where he was. A tester who runs this from a terminal can then
/// say whether the window was at a sane coordinate or somewhere impossible,
/// which is the one fact that separates "never shown" from "shown off-screen"
/// — and it cannot be got any other way from a window with no chrome.
fn bring_him_back(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(COMPANION_LABEL) else {
        eprintln!("loaf: there is no companion window to bring back");
        return;
    };
    match (
        window.outer_position(),
        window.outer_size(),
        window.is_visible(),
    ) {
        (Ok(p), Ok(s), visible) => eprintln!(
            "loaf: companion was at {},{} size {}x{} visible={:?}",
            p.x, p.y, s.width, s.height, visible
        ),
        _ => eprintln!("loaf: could not read where the companion was"),
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    park_bottom_right(&window);
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

/// Listen once, and hand back what was heard.
///
/// Async because it BLOCKS until the recogniser decides you have stopped
/// talking — on the main thread that would freeze the character mid-sentence,
/// which is the same deadlock this codebase already learned about the hard way.
///
/// Nothing here decides what the words mean. That is `voice/commands.ts`, which
/// is testable; this only produces the string it is given.
/// `phrases` is the closed vocabulary from `voice/phrases.ts`, and it is
/// required rather than optional. Windows will recognise anything you say if
/// you compile no constraints — by sending the audio to Microsoft. The phrase
/// list is what keeps this local, so an empty one is refused rather than
/// quietly becoming the other thing.
///
/// `model` is only reached on platforms with no OS recogniser, where Whisper
/// takes the turn instead. It is resolved here rather than inside `speech` so
/// that a missing model is refused before a microphone opens.
#[tauri::command(async)]
fn listen_once(app: tauri::AppHandle, model: String, phrases: Vec<String>) -> speech::Heard {
    let setup = match resolved_whisper_setup(&app, model) {
        Ok(s) => s,
        Err(why) => return speech::Heard::Unavailable { why },
    };
    speech::listen_once(&setup, phrases)
}

/// Every program on this machine Loaf could be asked to open.
///
/// Sent to the frontend so it can build spoken phrases from it. A closed
/// speech vocabulary cannot contain "Notepad" unless something told it the
/// word, and this is that something.
#[tauri::command(async)]
fn list_apps() -> Vec<apps::App> {
    apps::installed()
}

/// Start a program by the name that was heard.
///
/// Matching happens here rather than in the frontend because the installed
/// list lives here and the rule that a near miss must NOT launch the closest
/// thing is tested here.
#[tauri::command(async)]
fn open_app(name: String) -> Result<String, String> {
    let installed = apps::installed();
    match apps::best_match(&name, &installed) {
        Some(app) => apps::open(&app.path).map(|()| app.name.clone()),
        None => Err(format!("I could not find a program called {name}.")),
    }
}

/// Ask a program's windows to close.
///
/// Returns how many were asked; zero means it was not running, which is a
/// normal answer rather than a failure. This posts WM_CLOSE and never
/// terminates anything — see apps.rs.
#[tauri::command(async)]
fn close_app(name: String) -> Result<usize, String> {
    apps::close(&name)
}

/// The machine's volume, 0 to 100.
#[tauri::command(async)]
fn get_volume() -> Result<u8, String> {
    control::volume()
}

#[tauri::command(async)]
fn set_volume(percent: i64) -> Result<(), String> {
    control::set_volume(control::clamp_percent(percent))
}

#[tauri::command(async)]
fn set_muted(on: bool) -> Result<(), String> {
    control::set_muted(on)
}

/// The internal display's brightness. External monitors are driven over DDC/CI,
/// which most implement badly or not at all, so this reports an error there
/// rather than appearing to work.
#[tauri::command(async)]
fn get_brightness() -> Result<u8, String> {
    control::brightness()
}

#[tauri::command(async)]
fn set_brightness(percent: i64) -> Result<(), String> {
    control::set_brightness(control::clamp_percent(percent))
}

/// Type text into whatever has focus.
///
/// Reachable from the command box, not from the microphone: knowing WHAT to
/// type means free-form speech, and free-form speech on Windows is the online
/// recogniser. See speech.rs.
#[tauri::command(async)]
fn type_text(text: String) -> Result<(), String> {
    control::type_text(&text)
}

/// Press a key combination, e.g. "ctrl+t".
#[tauri::command(async)]
fn press_keys(combo: String) -> Result<(), String> {
    control::press(&combo)
}

/// The names of everything clickable in the window that is in front.
///
/// This is what makes "click Save" work through a closed vocabulary: the names
/// on screen become phrases, exactly as installed programs do. Control names
/// only \u2014 no values, no text content, no page contents.
#[tauri::command(async)]
fn clickables() -> Vec<String> {
    control::clickables()
}

/// Click something by its name. False means nothing by that name was found.
#[tauri::command(async)]
fn click_element(name: String) -> Result<bool, String> {
    control::click_named(&name)
}

/// Start always-on listening for the wake word.
///
/// `phrases` must include the wake word itself and every command, because a
/// closed grammar is what keeps this on the machine. An empty list is refused
/// rather than started — see wake.rs.
#[tauri::command(async)]
fn start_wake(app: tauri::AppHandle, phrases: Vec<String>) -> Result<(), String> {
    wake::start(app, phrases)
}

#[tauri::command(async)]
fn stop_wake() {
    wake::stop()
}

/// Whether the microphone is currently open, for the indicator.
#[tauri::command]
fn wake_listening() -> bool {
    wake::is_listening()
}

/// Write the meeting log where the MCP server can read it.
///
/// Meetings live in the companion window's storage, which is inside the
/// webview and invisible to anything else. Writing them beside stats.json is
/// what makes "when were my meetings" answerable by an assistant \u2014 without
/// it, the MCP server would have nothing to say about them.
///
/// The log holds when a call happened, where, how long, and whatever the user
/// typed. No audio, no participants, no titles. See meetings/meetings.ts.
#[tauri::command(async)]
fn save_meetings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .data_dir()
        .map_err(|e| e.to_string())?
        .join("LoafPlus");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("meetings.json"), &json).map_err(|e| e.to_string())?;

    // AND INTO THE STORE, so a meeting recorded today is findable today rather
    // than only after a migration that has already run.
    //
    // Written to BOTH places on purpose. The JSON file stays the source of
    // truth for now, so nothing that reads it breaks and a user who drops back
    // to an older build loses nothing. The store is the copy that can be
    // searched. When the frontend reads meetings from the store instead, the
    // file write becomes the redundant one and can go — in that order, so
    // there is never a moment where the only copy is the new one.
    //
    // It re-imports every meeting rather than just the changed one, which is
    // O(all meetings) on each save. That is milliseconds at present scale and
    // is worth revisiting when a user has thousands; `import_meetings` replaces
    // a meeting's lines rather than appending, so doing it repeatedly is safe.
    //
    // A failure here must NOT fail the command: the file above is what the app
    // still runs on, and losing a search index is not worth losing a meeting.
    if let Err(e) = with_store(&app, |c| store::import_meetings(c, &json)) {
        eprintln!("loaf/store could not index the meetings: {e}");
    }
    Ok(())
}

/// A recording in progress, if there is one.
///
/// One at a time, deliberately. Two overlapping recordings would produce two
/// files nobody asked for and a microphone indicator that lies about one of
/// them.
static RECORDING: std::sync::Mutex<Option<audio::Recording>> = std::sync::Mutex::new(None);

/// The microphone Loaf would record, so the user can see it BEFORE agreeing.
///
/// Named rather than assumed: "record this meeting" should show which device
/// is about to open, and it is always an input device \u2014 never system audio.
/// See audio.rs.
#[tauri::command(async)]
fn microphone_name() -> Option<String> {
    audio::input_device_name()
}

/// Start recording the user's own microphone.
///
/// Nothing here checks consent, and that is on purpose: consent is a decision
/// the UI makes with the user in front of it, and burying it in a Rust command
/// would make it look enforced when it is not. What this guarantees is
/// narrower and checkable \u2014 the microphone only, never the room.
#[tauri::command(async)]
fn start_recording() -> Result<(), String> {
    let mut slot = RECORDING.lock().map_err(|_| "recording lock poisoned")?;
    if slot.is_some() {
        return Err("Already recording.".into());
    }
    *slot = Some(audio::start()?);
    Ok(())
}

/// How long the current recording has run, or null when nothing is recording.
#[tauri::command]
fn recording_seconds() -> Option<u64> {
    RECORDING.lock().ok()?.as_ref().map(|r| r.seconds())
}

/// Stop, transcribe, and delete the audio.
///
/// THE RECORDING IS DELETED whether transcription succeeded or not. Loaf keeps
/// the words, not the voice: an audio file of a meeting sitting on disk is a
/// different and much heavier thing to hold than a transcript, and nothing in
/// the product needs it after this point.
#[tauri::command(async)]
fn stop_recording(app: tauri::AppHandle, model: String) -> Result<String, String> {
    let recording = RECORDING
        .lock()
        .map_err(|_| "recording lock poisoned")?
        .take()
        .ok_or("Nothing is recording.")?;

    let wav = transcribe::scratch_wav();
    let seconds = audio::stop(recording, &wav)?;
    let setup = resolved_whisper_setup(&app, model)?;
    let result = if seconds < 0.5 {
        Ok(String::new())
    } else {
        transcribe::transcribe(&setup, &wav)
    };
    let _ = std::fs::remove_file(&wav);
    result
}

// DICTATION_SILENCE AND DICTATION_HUSH_MS USED TO LIVE HERE, and their absence
// is the point. They were a fixed RMS threshold and a fixed hush, and between
// them they decided when somebody had stopped talking. A fixed threshold cannot
// know how loud the room is: a quiet talker never crossed it so nothing was
// ever heard, and a noisy room never dropped below it so every dictation ran to
// its cap. `vad::Vad` learns the room instead, needs a run of frames rather
// than one, and waits out a thinking pause — with the hangover as a named
// setting rather than a constant beside an unrelated one.

/// The longest a single dictation may run, whatever happens. A dictation that
/// never ends is a hot microphone with a friendly name.
const DICTATION_MAX_SECONDS: u64 = 30;

/// Take one dictated sentence with Whisper and return the words.
///
/// THIS IS THE PATH THAT MAKES CHOOSING WHISPER MEAN ANYTHING. `listen_once`
/// uses the Windows recogniser with a closed phrase list, which by design can
/// only hear the commands it was handed — it cannot take dictation at all, and
/// no setting could make it, because free-form Windows recognition IS the
/// online one. Whisper is the local engine that can hear anything, so free
/// text goes through here and nowhere else. Until this existed, picking
/// Whisper in the closet changed the label and nothing else.
///
/// It records until you stop talking rather than for a fixed count: a fixed
/// window either cuts people off or holds the microphone open after they have
/// finished, and both are worse than listening for the pause.
///
/// The audio is deleted before this returns, on every path including failure —
/// the same rule `stop_recording` follows. Loaf keeps words, not voices.
#[tauri::command(async)]
fn dictate_once(
    app: tauri::AppHandle,
    model: String,
    max_seconds: Option<u64>,
) -> Result<String, String> {
    // Resolved BEFORE the microphone opens: refusing afterwards would mean
    // having recorded someone for a transcription that was never going to run.
    let setup = resolved_whisper_setup(&app, model)?;
    if let Some(what) = transcribe::missing(&setup) {
        return Err(transcribe::missing_reason(&what));
    }

    // One microphone, one user. Dictating during a meeting recording would
    // take the device out from under it.
    if RECORDING
        .lock()
        .map_err(|_| "recording lock poisoned")?
        .is_some()
    {
        return Err("Loaf is recording a meeting right now.".into());
    }

    let cap = max_seconds
        .unwrap_or(DICTATION_MAX_SECONDS)
        .clamp(2, DICTATION_MAX_SECONDS);
    let recording = audio::start()?;

    // THE DETECTOR, RATHER THAN A NUMBER. This loop used to compare the last
    // fifth of a second against a fixed threshold. That fails in both
    // directions and both were reported: a quiet talker never crossed it so
    // nothing was ever heard, and a noisy room never dropped below it so the
    // recording ran to its cap every time. `vad::Vad` learns the room, needs a
    // run of frames rather than one, and waits out a thinking pause. See
    // vad.rs for the three attempts the noise floor took.
    let mut vad = vad::Vad::default();
    let mut read_from = 0usize;
    let mut pending: Vec<i16> = Vec::new();
    let started = std::time::Instant::now();
    let mut spoke = false;

    while started.elapsed() < std::time::Duration::from_secs(cap) {
        std::thread::sleep(std::time::Duration::from_millis(20));
        let (fresh, next) = recording.samples_since(read_from);
        read_from = next;
        if fresh.is_empty() {
            continue;
        }
        pending.extend_from_slice(&fresh);

        let mut ended = false;
        while pending.len() >= vad::FRAME {
            let frame: Vec<i16> = pending.drain(..vad::FRAME).collect();
            match vad.push(&frame) {
                vad::Event::Started => spoke = true,
                // Silence only ends the recording once there was something to
                // end. A microphone nobody spoke into would otherwise return an
                // instant empty transcript and read as a broken feature.
                vad::Event::Ended if spoke => {
                    ended = true;
                    break;
                }
                _ => {}
            }
        }
        if ended {
            break;
        }
    }

    // STRAIGHT FROM MEMORY, no file in between. Writing a WAV so it can be read
    // back is pure latency, and this is the one place in the product where the
    // gap between finishing a sentence and something happening IS the feature.
    let audio_f32 = recording.to_f32();
    let _ = audio::stop(recording, &transcribe::scratch_wav());
    if !spoke {
        return Ok(String::new());
    }
    transcribe::transcribe_samples(&setup, &audio_f32)
}

/// Whether Whisper is ready, and what is missing when it is not.
#[tauri::command(async)]
fn whisper_status(app: tauri::AppHandle, model: String) -> Option<String> {
    let Ok(setup) = resolved_whisper_setup(&app, model) else {
        return Some("Whisper needs its model. Download it from Settings.".into());
    };
    transcribe::missing(&setup).map(|m| transcribe::missing_reason(&m))
}

/// An explicit path if the user gave one; otherwise the location the
/// in-app downloader installs to. This is what lets a customer who never
/// typed a path still have Whisper work once they have downloaded it —
/// `whisper_status`/`stop_recording` do not need to know which case they
/// are in.
fn resolved_whisper_setup(
    app: &tauri::AppHandle,
    model: String,
) -> Result<transcribe::WhisperSetup, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let model = if model.trim().is_empty() {
        whisper_setup::model_path(&dir)
            .to_string_lossy()
            .into_owned()
    } else {
        model
    };
    Ok(transcribe::WhisperSetup { model })
}

/// Total bytes the Whisper engine download will transfer, so the UI can show
/// the size before the download starts — the same rule every engine in
/// section 18 follows.
#[tauri::command]
fn whisper_download_size() -> u64 {
    whisper_setup::total_bytes()
}

/// Whether the in-app download already completed.
#[tauri::command(async)]
fn whisper_installed(app: tauri::AppHandle) -> bool {
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else {
        return false;
    };
    whisper_setup::is_installed(&dir)
}

/// Fetch and install the Whisper engine. Emits `loaf://whisper/progress`
/// events as bytes arrive, so the closet can show a real progress bar rather
/// than a spinner across a 190 MB download.
///
/// Nothing here runs until this command is called — picking the engine in
/// the closet does not download it, only pressing the download button does.
#[tauri::command(async)]
fn download_whisper_engine(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sink = app.clone();
    whisper_setup::install(&dir, move |progress| {
        let _ = sink.emit("loaf://whisper/progress", progress);
    })
}

/// The titles of the tabs open in the front browser window.
///
/// Titles only \u2014 what the browser writes on the tab strip, which is what you
/// can already read by looking at the screen. No URLs, no page content.
#[tauri::command(async)]
fn list_tabs() -> Vec<String> {
    #[cfg(windows)]
    {
        browser_windows::list_tabs()
    }
    #[cfg(target_os = "macos")]
    {
        browser_macos::list_tabs()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Vec::new()
    }
}

/// Close one tab by title. False means it was not found.
#[tauri::command(async)]
fn close_tab(title: String) -> Result<bool, String> {
    #[cfg(windows)]
    {
        browser_windows::close_tab(&title)
    }
    #[cfg(target_os = "macos")]
    {
        Ok(browser_macos::close_tab(&title))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = title;
        Err("Closing tabs is not supported on this platform.".into())
    }
}

/// A native OS notification — the meeting-detected prompt uses this so it is
/// not missed just because nobody happened to be looking at the character
/// right then. Best effort: a denied or unavailable notification permission
/// is not an error worth surfacing, since the bubble and spoken prompt (built
/// separately, in TypeScript) already carry the same ask.
#[tauri::command(async)]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
    Ok(())
}

/// Whether to offer a microphone button at all.
///
/// Async because answering now means compiling a real constraint, which is the
/// only honest test of the offline recogniser and far too slow for the main
/// thread.
#[tauri::command(async)]
fn speech_available(app: tauri::AppHandle, model: String) -> bool {
    let Ok(setup) = resolved_whisper_setup(&app, model) else {
        return false;
    };
    speech::available(&setup)
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

// ---------------------------------------------------------------------------
// Connections: the MCP servers the user has attached.
//
// Every command here is thin on purpose. The decisions — what the window may
// see, what a save is allowed to overwrite, when a program gets started — all
// live in `connections.rs` where they are testable without a running app. What
// is left below is plumbing, and plumbing is the right place for nothing to be
// happening.
//
// All of them are `async`: opening a server spawns a process and waits for a
// handshake, and a slow one must not freeze the pet.
// ---------------------------------------------------------------------------

/// The servers as configured, with every secret stripped out.
#[tauri::command(async)]
fn mcp_servers(app: tauri::AppHandle) -> Result<Vec<connections::ServerView>, String> {
    Ok(connections::redact(&connections::load(&data_dir(&app)?)?))
}

/// Save the list the window is showing, and hand back what it may now see.
///
/// `secrets` is the one direction a value travels: up. It is keyed by server
/// and variable, holds only what was actually typed, and anything absent from
/// it leaves the stored value alone.
#[tauri::command(async)]
fn mcp_save_servers(
    app: tauri::AppHandle,
    servers: Vec<connections::ServerView>,
    secrets: Option<connections::SecretsIn>,
) -> Result<Vec<connections::ServerView>, String> {
    let dir = data_dir(&app)?;
    let stored = connections::load(&dir)?;
    let next = connections::apply(&stored, servers, &secrets.unwrap_or_default());
    // Round-trip through the parser so a config the app writes is one the app
    // would also agree to read. Two names the same, an empty command — the
    // rules are in one place and this is how they get enforced on writes too.
    let json = serde_json::to_string(&next).map_err(|e| e.to_string())?;
    let checked = mcp_client::parse_config(&json)?;
    connections::save(&dir, &checked)?;
    Ok(connections::redact(&checked))
}

/// What a server can do. THE FIRST CALL TO THIS IS WHAT STARTS IT.
#[tauri::command(async)]
fn mcp_tools(
    app: tauri::AppHandle,
    pool: tauri::State<'_, connections::Pool>,
    name: String,
) -> Result<Vec<String>, String> {
    let config = connections::load(&data_dir(&app)?)?;
    connections::with_connection(&pool, &config, &name, |conn| conn.tools())
}

/// Tell the companion whether an MCP call is in flight right now.
///
/// ONE FUNCTION FOR BOTH START AND STOP, so the two can never drift apart —
/// exactly the reasoning behind `announceTasks` sending two broadcasts from
/// one call site on the TypeScript side. A caller that emitted `true` directly
/// and forgot the matching `false` on one exit path (an early return, a
/// dropped error) would leave the character looking busy forever, which is a
/// worse bug than never reacting at all.
///
/// Best-effort: a window that is not listening, or not open, is not an error.
fn tell_the_companion_mcp_is(app: &tauri::AppHandle, busy: bool) {
    use tauri::Emitter;
    let _ = app.emit("loaf://mcp/busy", busy);
}

/// Ask a server to do one named thing.
///
/// The record is written whether the call worked or not, and BEFORE the answer
/// is returned. A log that only remembers successes is not an audit trail; the
/// call that failed still sent the arguments.
///
/// THIS IS ALSO WHERE THE CHARACTER STARTS REACTING. A call to another
/// program is exactly the kind of "something is happening that is not
/// instant" the `working` mood already exists for — the same pose the
/// companion takes while the foreground app is busy, borrowed rather than
/// drawn again, because the feeling is identical: Loaf is waiting on
/// something on your behalf.
#[tauri::command(async)]
fn mcp_call(
    app: tauri::AppHandle,
    pool: tauri::State<'_, connections::Pool>,
    name: String,
    tool: String,
    arguments: String,
) -> Result<String, String> {
    let dir = data_dir(&app)?;
    let config = connections::load(&dir)?;
    let parsed: serde_json::Value = if arguments.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&arguments)
            .map_err(|e| format!("Those arguments are not JSON: {e}"))?
    };

    tell_the_companion_mcp_is(&app, true);
    let outcome = connections::with_connection(&pool, &config, &name, |conn| {
        conn.call(&tool, parsed.clone())
    });
    tell_the_companion_mcp_is(&app, false);

    let _ = mcp_client::record(
        &dir,
        &mcp_client::CallRecord {
            server: name,
            tool,
            arguments: parsed.to_string(),
            at: connections::now(),
            ok: outcome.is_ok(),
        },
    );
    outcome
}

/// The things Loaf checks on its own.
#[tauri::command(async)]
fn watches_list(app: tauri::AppHandle) -> Result<Vec<watch::Watch>, String> {
    Ok(connections::load(&data_dir(&app)?)?.watches)
}

/// Replace the whole list, which is how the Connections screen saves it.
///
/// Whole-list rather than per-item for the same reason the server list is:
/// one writer, one shape, and no way for the window and the file to disagree
/// about what exists.
#[tauri::command(async)]
fn watches_save(app: tauri::AppHandle, watches: Vec<watch::Watch>) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let mut config = connections::load(&dir)?;
    config.watches = watches;
    connections::save(&dir, &config)
}

/// What the poller has seen: when each watch last ran, and what it said then.
#[derive(Default)]
pub struct Seen(pub std::sync::Mutex<std::collections::BTreeMap<(String, String), (u64, String)>>);

/// Check every watch that is due, and say so when one changes.
///
/// IN MEMORY, NOT ON DISK, and that is a decision rather than laziness. The
/// baseline is what a watch looked like last time Loaf ran; keeping it across
/// a restart would mean announcing everything that happened while Loaf was
/// closed, which for a mailbox is the whole mailbox. A restart starts quiet.
///
/// One thread waking often and usually doing nothing, rather than a timer per
/// watch: a dozen sleeping threads to make one call a minute is a lot of
/// machinery for a pet.
fn poll_watches(app: &tauri::AppHandle) {
    use tauri::Emitter;
    use tauri::Manager;

    let Ok(dir) = data_dir(app) else { return };
    let Ok(config) = connections::load(&dir) else {
        return;
    };
    let now = connections::now();
    // Bound once. `app.state::<Seen>()` is a temporary, and locking it inline
    // borrows something that is dropped at the end of the statement.
    let seen_state = app.state::<Seen>();

    for w in &config.watches {
        let key = (w.server.clone(), w.tool.clone());
        let last = {
            let Ok(seen) = seen_state.0.lock() else {
                return;
            };
            seen.get(&key).cloned()
        };
        if !watch::due(w, now, last.as_ref().map(|(at, _)| *at)) {
            continue;
        }

        // The same path a person pressing the button takes, so a watch and a
        // press are logged identically and neither can drift from the other.
        let parsed: serde_json::Value = if w.arguments.trim().is_empty() {
            serde_json::json!({})
        } else {
            match serde_json::from_str(&w.arguments) {
                Ok(v) => v,
                // A watch with broken arguments is disabled in effect rather
                // than retried every minute forever.
                Err(_) => continue,
            }
        };
        let pool = app.state::<connections::Pool>();
        tell_the_companion_mcp_is(app, true);
        let outcome = connections::with_connection(&pool, &config, &w.server, |conn| {
            conn.call(&w.tool, parsed.clone())
        });
        tell_the_companion_mcp_is(app, false);
        let _ = mcp_client::record(
            &dir,
            &mcp_client::CallRecord {
                server: w.server.clone(),
                tool: w.tool.clone(),
                arguments: parsed.to_string(),
                at: now,
                ok: outcome.is_ok(),
            },
        );

        let Ok(answer) = outcome else {
            // A server that is down is not news. The failure is already in the
            // call log, and a bubble every minute about a broken watch is what
            // gets the whole feature switched off.
            continue;
        };

        let digest = watch::digest(&answer);
        let verdict = watch::compare(last.as_ref().map(|(_, d)| d.as_str()), &digest);
        if let Ok(mut seen) = seen_state.0.lock() {
            seen.insert(key, (now, digest));
        }
        if verdict == watch::Outcome::Changed {
            let _ = app.emit("loaf://watch/changed", watch::bubble_line(w, &answer));
        }
    }
}

/// Everything Loaf has sent to a server, oldest first.
#[tauri::command(async)]
fn mcp_calls(app: tauri::AppHandle) -> Result<Vec<mcp_client::CallRecord>, String> {
    Ok(connections::calls(&data_dir(&app)?))
}

/// Which servers are running right now.
#[tauri::command(async)]
fn mcp_connected(pool: tauri::State<'_, connections::Pool>) -> Vec<String> {
    connections::connected(&pool)
}

/// Stop a server. It is started again by the next thing that needs it.
#[tauri::command(async)]
fn mcp_disconnect(pool: tauri::State<'_, connections::Pool>, name: String) {
    connections::disconnect(&pool, &name);
}

/// Say something out loud. Returns as soon as it starts, not when it finishes.
///
/// Off until the user turns it on — the setting lives in the closet with the
/// other voice choices, and this command is only reached when it is on. A
/// desktop pet that starts talking unprompted is not a feature anybody wants
/// twice.
#[tauri::command(async)]
fn speak(text: String) -> Result<(), String> {
    speak::say(&text)
}

/// Stop mid-sentence.
#[tauri::command(async)]
fn stop_speaking() {
    speak::stop();
}

/// Whether this machine can speak at all, so the setting can be hidden if not.
#[tauri::command(async)]
fn can_speak() -> bool {
    speak::available()
}

/// Where the frontend's uncaught errors go, so a blank window can say why.
///
/// stderr rather than a file. A tester who has been asked to run the app from a
/// terminal sees it immediately, and nothing is written to their disk for a
/// problem that only matters while somebody is looking. See src/boot.ts for the
/// other half, and for why an invisible pet is otherwise undiagnosable from a PC.
/// Where voice actually got to, written somewhere it can be sent back.
///
/// WHY THIS IS SEPARATE FROM `report_error`. That one fires once per run and
/// posts a notification, because it means something broke. This means nothing
/// broke — it is the state of a feature that has now been reported as "not
/// working" three times running, with no way to tell which of six cases it was:
/// listening switched off, no microphone, no model, the OS refusing the wake
/// session, wake running and mishearing, or the frontend never reaching this
/// code at all. Those need different fixes and look identical from outside.
///
/// Overwritten each time rather than appended: the current state is the whole
/// question, and a growing file is one more thing to explain over a screenshot.
#[tauri::command]
fn voice_report(app: tauri::AppHandle, detail: String) {
    let detail: String = detail.chars().take(2000).collect();
    eprintln!("loaf/voice {detail}");
    if let Ok(dir) = data_dir(&app) {
        let dir = dir.join("LoafPlus");
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::fs::write(
                dir.join("voice.txt"),
                format!(
                    "Loaf {}
{} (seconds since 1970)

{detail}
",
                    env!("CARGO_PKG_VERSION"),
                    connections::now()
                ),
            );
        }
    }
}

#[tauri::command]
fn report_error(app: tauri::AppHandle, what: String, detail: String) {
    // Truncated on the way in as well as on the way out: this is reachable from
    // a window, and an unbounded string from a window should not be able to
    // fill a terminal buffer.
    let detail: String = detail.chars().take(4000).collect();
    let what: String = what.chars().take(80).collect();
    eprintln!("loaf/webview {what}: {detail}");

    // AND ON SCREEN, BECAUSE stderr IS NOT WHERE ANYBODY IS LOOKING.
    //
    // This is what the last three days of the invisible-pet bug came down to.
    // The diagnostic worked exactly as designed — the mark appeared, which
    // proved the window was alive and the drawing had failed — and then the
    // actual exception went to a terminal nobody was running the app from, so
    // the one fact that would end it was written down where it could not be
    // read. A desktop app that can only be diagnosed by launching it from a
    // shell is a desktop app that cannot be diagnosed.
    //
    // ONCE PER RUN. A render loop that throws throws every frame, and sixty
    // notifications a second is its own emergency.
    static TOLD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if TOLD.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }

    // A FILE FIRST, BECAUSE A NOTIFICATION CAN BE REFUSED.
    //
    // macOS asks before an app may post notifications, and a user who has never
    // granted it — or who dismissed the request months ago — would get nothing
    // at all from the line below. That is the same failure this whole function
    // exists to fix, one layer up: the answer written somewhere the person who
    // needs it cannot see. A file is not refusable.
    if let Ok(dir) = data_dir(&app) {
        let dir = dir.join("LoafPlus");
        if std::fs::create_dir_all(&dir).is_ok() {
            let when = connections::now();
            let _ = std::fs::write(
                dir.join("last-error.txt"),
                format!(
                    "Loaf {}
{when} (seconds since 1970)
{what}

{detail}
",
                    env!("CARGO_PKG_VERSION")
                ),
            );
        }
    }

    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Loaf hit an error and could not start")
        .body(detail.chars().take(400).collect::<String>())
        .show();
}

// ---------------------------------------------------------------------------
// The store (M3): search, delete, export.
//
// The connection is opened LAZILY and kept behind a mutex. Lazily because a
// store that cannot be opened must not stop the pet from appearing — screen
// time tracking, the character and the focus timer have nothing to do with
// SQLite, and an app that refuses to launch because a database file is locked
// would be a worse product than one whose search box says why it is empty.
//
// Behind a mutex because rusqlite's Connection is Send but not Sync, and
// because the tracker writes on a timer while a search may be reading. WAL mode
// (see store.rs) means those do not block each other at the SQLite level; the
// mutex is about Rust's rules, not about contention.
// ---------------------------------------------------------------------------

/// The one connection, opened the first time something needs it.
#[derive(Default)]
pub struct Store(std::sync::Mutex<Option<rusqlite::Connection>>);

/// Run `f` against the store, opening and importing it if this is the first ask.
///
/// The import runs here rather than at startup deliberately: it reads two files
/// and writes every day of somebody's history, and doing that during launch
/// would delay the character appearing for the one reason a user would never
/// guess. Doing it on first use means it happens when the dashboard is opened,
/// which is exactly when the results are wanted.
fn with_store<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let dir = data_dir(app)?;
    let state = app.state::<Store>();
    let mut held = state.0.lock().map_err(|_| "the store lock broke")?;
    if held.is_none() {
        let conn = store::open(&dir)?;
        match store::import_once(&conn, &dir) {
            Ok((0, 0)) => {}
            Ok((days, meetings)) => {
                eprintln!("loaf/store imported {days} days and {meetings} meetings");
            }
            // A failed import must not make the store unusable. The old files
            // are untouched, so this can be retried by deleting loaf.db.
            Err(e) => eprintln!("loaf/store could not import the old files: {e}"),
        }
        *held = Some(conn);
    }
    let conn = held.as_ref().ok_or("the store vanished as it was opened")?;
    f(conn)
}

/// Find a phrase in anything the user has said or written.
#[tauri::command(async)]
fn store_search(
    app: tauri::AppHandle,
    phrase: String,
    limit: Option<usize>,
) -> Result<Vec<store::Hit>, String> {
    // Capped rather than trusted: the limit arrives from a window, and a search
    // asking for every row would hold the lock for as long as it took.
    let limit = limit.unwrap_or(50).clamp(1, 500);
    with_store(&app, |c| store::search(c, &phrase, limit))
}

#[tauri::command(async)]
fn store_meetings(app: tauri::AppHandle) -> Result<Vec<store::Meeting>, String> {
    with_store(&app, store::meetings)
}

/// What deleting a range WOULD remove. Changes nothing.
#[tauri::command(async)]
fn store_preview_range(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<store::Removal, String> {
    with_store(&app, |c| store::preview_range(c, &from, &to))
}

#[tauri::command(async)]
fn store_delete_range(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<store::Removal, String> {
    with_store(&app, |c| store::delete_range(c, &from, &to))
}

#[tauri::command(async)]
fn store_delete_meeting(app: tauri::AppHandle, id: String) -> Result<store::Removal, String> {
    with_store(&app, |c| store::delete_meeting(c, &id))
}

/// Forget every line mentioning a phrase, wherever it was said.
#[tauri::command(async)]
fn store_delete_matching(app: tauri::AppHandle, phrase: String) -> Result<store::Removal, String> {
    with_store(&app, |c| store::delete_matching(c, &phrase))
}

#[tauri::command(async)]
fn store_delete_everything(app: tauri::AppHandle) -> Result<(), String> {
    with_store(&app, store::delete_everything)
}

/// Every line still in the store, newest first.
///
/// EXISTS SO MEMORY CAN BE REBUILT AFTER A DELETE. The knowledge graph is
/// derived from transcripts, so deleting a transcript has to take what was
/// learned from it — otherwise "forget everything about the acquisition"
/// removes the words and leaves the people and topics standing in the memory
/// panel, which is the opposite of what was asked for and worse than not
/// offering the button.
///
/// Rebuilding from what remains is used rather than trying to subtract: working
/// out which entities came only from the deleted lines means tracking
/// provenance per edge, and getting that subtly wrong leaves a trace of
/// something the user believes is gone. Rebuilding cannot be subtly wrong.
#[tauri::command(async)]
fn store_all_lines(app: tauri::AppHandle, limit: Option<usize>) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(20_000).clamp(1, 200_000) as i64;
    with_store(&app, |c| {
        let mut stmt = c
            .prepare("SELECT text FROM lines ORDER BY at DESC LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![limit], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })
}

/// Read one durable value out of the store.
///
/// EXISTS FOR THE KNOWLEDGE GRAPH, and for the class of problem it is in. The
/// graph has been living in the WebView's own storage, which is invisible to
/// this process, capped at a few megabytes, and **wiped without warning if site
/// data is ever cleared**. Everything the user's memory is built from would go
/// with it and nothing would say so. A file the app owns is the fix.
///
/// Deliberately a generic key/value rather than a `graph` command: the closet's
/// choices and the focus timer's state are in the same browser storage for the
/// same reason, and they should move here too rather than needing a command
/// each.
#[tauri::command(async)]
fn store_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    with_store(&app, |c| {
        c.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    })
}

#[tauri::command(async)]
fn store_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    with_store(&app, |c| {
        c.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
}

/// Write everything out as ordinary files, and reveal the folder.
///
/// Into a dated folder rather than one fixed place, so exporting twice does not
/// silently overwrite the first one — an export is usually taken because
/// somebody is about to do something irreversible.
#[tauri::command(async)]
fn store_export(app: tauri::AppHandle) -> Result<String, String> {
    let stamp = connections::now();
    let dir = data_dir(&app)?
        .join("LoafPlus")
        .join("Exports")
        .join(format!("loaf-export-{stamp}"));
    with_store(&app, |c| store::export_to(c, &dir))?;
    let shown = dir.to_string_lossy().into_owned();
    open_in_file_manager(&shown)?;
    Ok(shown)
}

/// Reveal the config file, for the things the window deliberately will not do.
///
/// Editing a secret in place, adding a variable the UI has no field for,
/// reading what is actually stored: all of it belongs to a text editor and the
/// person whose machine it is, not to a WebView.
#[tauri::command(async)]
fn open_mcp_config(app: tauri::AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let path = mcp_client::config_path(&dir);
    if !path.exists() {
        // Made rather than reported missing: "open the file" failing because
        // the file has never been written is a dead end for the user.
        connections::save(&dir, &connections::load(&dir)?)?;
    }
    open_in_file_manager(&path.to_string_lossy())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // Empty at launch and it stays empty: a server appears in here
        // only because something asked it a question.
        .manage(connections::Pool::default())
        // What each watch last returned. Empty at launch on purpose — see
        // poll_watches: a restart starts quiet rather than announcing
        // everything that happened while Loaf was closed.
        .manage(Seen::default())
        // Opened on first use, not at launch: see with_store.
        .manage(Store::default())
        .setup(|app| {
            // A desktop pet is an accessory, not an application: no Dock icon,
            // no app switcher entry, and it never steals focus. This is the
            // macOS half of what `skipTaskbar` does on Windows, and the
            // equivalent of LSUIElement in the Swift original's Info.plist.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Windows needs a listener running; macOS polls and this is a no-op.
            scroll::start();

            // THE ONLY THING IN LOAF THAT REACHES OUT ON ITS OWN SCHEDULE.
            //
            // It does nothing at all until the user makes a watch — the list
            // ships empty, there is no discovery and nothing is suggested. The
            // thread exists regardless because starting it later would mean a
            // watch made now not running until the next launch.
            //
            // Fifteen seconds is the heartbeat, not the poll rate: watch::due
            // decides what actually runs, and it will not let anything run more
            // than once a minute however the config is written.
            let ticker = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(15));
                poll_watches(&ticker);
            });

            build_tray(app.handle())?;
            build_bubble_window(app.handle())?;

            if let Some(window) = app.get_webview_window(COMPANION_LABEL) {
                park_bottom_right(&window);
                follow_the_user(&window);
                // SAID OUT LOUD AT EVERY LAUNCH, because the alternative is
                // asking a tester to describe an empty rectangle. A companion
                // that is off-screen, sized zero, or never shown all look
                // identical from the outside and are three different bugs.
                describe_the_companion(&window);
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
            listen_once,
            speech_available,
            list_apps,
            open_app,
            close_app,
            get_volume,
            set_volume,
            set_muted,
            get_brightness,
            set_brightness,
            type_text,
            press_keys,
            clickables,
            click_element,
            save_meetings,
            notify,
            list_tabs,
            close_tab,
            microphone_name,
            start_recording,
            recording_seconds,
            stop_recording,
            dictate_once,
            whisper_status,
            whisper_download_size,
            whisper_installed,
            download_whisper_engine,
            start_wake,
            stop_wake,
            wake_listening,
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
            hide_bubble,
            mcp_servers,
            mcp_save_servers,
            mcp_tools,
            mcp_call,
            mcp_calls,
            watches_list,
            watches_save,
            mcp_connected,
            mcp_disconnect,
            open_mcp_config,
            report_error,
            voice_report,
            speak,
            stop_speaking,
            can_speak,
            store_search,
            store_meetings,
            store_preview_range,
            store_delete_range,
            store_delete_meeting,
            store_delete_matching,
            store_delete_everything,
            store_get,
            store_set,
            store_all_lines,
            store_export
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
