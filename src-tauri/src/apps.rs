//! Opening and closing the programs on this machine, by name.
//!
//! WHY THIS EXISTS AT ALL. "Open Notepad" cannot work through a closed speech
//! vocabulary unless the vocabulary knows the word "Notepad" before you say it.
//! So the list of installed programs IS part of the grammar: it is read once,
//! turned into phrases, and handed to the recogniser. That is what lets Loaf
//! launch anything on the machine while still never using Windows' online
//! dictation. See `speech.rs` for why that distinction is the whole feature.
//!
//! CLOSING IS NOT KILLING. `close` posts `WM_CLOSE` to a program's windows,
//! which is exactly what clicking the X does: the program decides what to do,
//! and an editor with unsaved work gets to put its own save prompt up. Nothing
//! here calls `TerminateProcess`. A voice command is the least reliable input
//! the app has, and the worst outcome of a misheard one should be a window
//! closing politely, never a document lost.
//!
//! Some programs are refused outright regardless of what was heard — see
//! `PROTECTED`. Closing the shell or the session manager by accident is not a
//! recoverable mistake, and no phrasing makes it one.

/// Programs Loaf will never close, whatever it thinks it heard.
///
/// ONE LIST FOR BOTH PLATFORMS, not two. A misheard word is a misheard word
/// wherever it happens, the list is short, and nothing on either platform is
/// called by the other's names — so splitting it would only create a second
/// place to forget to add something.
///
/// Windows: `explorer` is the desktop itself; the rest end the session or take
/// the machine down with them. macOS: `finder` is the desktop, `dock` and
/// `systemuiserver` are the menu bar and the Dock, `loginwindow` ends the
/// session, and `windowserver` takes the display with it.
///
/// Loaf is on the list because a pet that can be told to kill itself
/// mid-sentence is a bug report nobody can describe.
pub const PROTECTED: &[&str] = &[
    // Windows
    "explorer",
    "csrss",
    "winlogon",
    "wininit",
    "services",
    "lsass",
    "smss",
    "svchost",
    "dwm",
    "system",
    // macOS
    "finder",
    "dock",
    "systemuiserver",
    "loginwindow",
    "windowserver",
    "coreservicesuiagent",
    // Always
    "loaf",
];

/// One program Loaf can start.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct App {
    /// What a person calls it, and what they would say out loud.
    pub name: String,
    /// The shortcut or executable to launch.
    pub path: String,
}

/// Lower-case, no punctuation, single spaces.
///
/// Shortcut names are full of things nobody says: "Visual Studio Code" ships as
/// "Visual Studio Code", but "Firefox" ships as "Firefox Private Browsing" too,
/// and version numbers and vendor names are everywhere.
pub fn normalise(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut space = false;
    for c in raw.chars() {
        if c.is_alphanumeric() {
            for l in c.to_lowercase() {
                out.push(l);
            }
            space = false;
        } else if !space && !out.is_empty() {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

/// Whether this program is one Loaf refuses to close.
pub fn is_protected(exe: &str) -> bool {
    let stem = exe
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(exe)
        .trim_end_matches(".exe")
        .trim_end_matches(".EXE")
        .trim_end_matches(".app")
        .trim_end_matches(".APP");
    let stem = normalise(stem);
    PROTECTED.iter().any(|p| stem == *p)
}

/// Find the program a spoken name meant.
///
/// Exact match first, then a whole-word prefix. Deliberately NOT fuzzy: a
/// near-miss that launches the wrong program is worse than a miss that says it
/// did not understand, and the recogniser has already done the guessing. When
/// two programs match equally the shorter name wins, because "Firefox" should
/// beat "Firefox Private Browsing" for the word "firefox".
pub fn best_match<'a>(spoken: &str, apps: &'a [App]) -> Option<&'a App> {
    let want = normalise(spoken);
    if want.is_empty() {
        return None;
    }

    let mut best: Option<&App> = None;
    for app in apps {
        let have = normalise(&app.name);
        let hit = have == want || have.starts_with(&format!("{want} "));
        if !hit {
            continue;
        }
        let better = match best {
            None => true,
            Some(b) => {
                // An exact match always beats a prefix match.
                (have == want && normalise(&b.name) != want)
                    || (have.len() < normalise(&b.name).len()
                        && (have == want) == (normalise(&b.name) == want))
            }
        };
        if better {
            best = Some(app);
        }
    }
    best
}

/// Every program Loaf can be asked to open, deduplicated by name.
pub fn installed() -> Vec<App> {
    let mut apps = imp::installed();
    apps.sort_by_key(|a| normalise(&a.name));
    apps.dedup_by(|a, b| normalise(&a.name) == normalise(&b.name));
    apps
}

/// Start a program. `Ok` means Windows accepted the request, not that a window
/// appeared — some programs take seconds, and some are already running.
pub fn open(path: &str) -> Result<(), String> {
    imp::open(path)
}

/// Ask a program's windows to close. Returns how many were asked.
///
/// Zero is a normal answer meaning "it was not running", and the caller should
/// say so rather than reporting a failure.
pub fn close(name: &str) -> Result<usize, String> {
    if is_protected(name) {
        // Named by what it is rather than by which OS it belongs to: the
        // sentence has to be true on both, and "part of Windows" read as a bug
        // on a Mac.
        return Err(format!(
            "{name} is part of the operating system, so Loaf will not close it."
        ));
    }
    imp::close(name)
}

#[cfg(windows)]
mod imp {
    use super::App;
    use std::path::{Path, PathBuf};

    /// The two Start Menu trees: everyone's, and this user's.
    fn start_menus() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        for (var, tail) in [
            ("ProgramData", r"Microsoft\Windows\Start Menu\Programs"),
            ("APPDATA", r"Microsoft\Windows\Start Menu\Programs"),
        ] {
            if let Ok(base) = std::env::var(var) {
                roots.push(Path::new(&base).join(tail));
            }
        }
        roots
    }

    /// Walk a Start Menu tree for shortcuts.
    ///
    /// Depth-limited because the Start Menu is a user-writable folder tree and
    /// a symlink loop in it should not hang the app at startup.
    fn collect(dir: &Path, depth: usize, out: &mut Vec<App>) {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, depth - 1, out);
            } else if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
            {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    // Uninstallers and help links are in here too, and none of
                    // them is something anyone means by "open".
                    let lower = stem.to_lowercase();
                    if lower.contains("uninstall") || lower.contains("readme") {
                        continue;
                    }
                    out.push(App {
                        name: stem.to_string(),
                        path: path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }

    /// What the Start menu itself lists, Store apps included.
    ///
    /// The shortcut scan above cannot see Notepad or Calculator on Windows 11,
    /// because they are packaged apps with no `.lnk` anywhere — they exist only
    /// in the shell's Applications folder. `Get-StartApps` returns both kinds
    /// with the names the Start menu shows, which are also the names a person
    /// would say out loud.
    ///
    /// This costs one PowerShell launch, so it happens once and is cached. A
    /// program installed while Loaf is running is not spoken until restart,
    /// which is the trade for not paying a second of startup on every call.
    fn start_apps() -> Vec<App> {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-StartApps | ConvertTo-Json -Compress",
            ])
            .output();
        let Ok(out) = out else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
            return Vec::new();
        };
        let rows = match &parsed {
            serde_json::Value::Array(a) => a.clone(),
            // A machine with exactly one entry serialises as an object.
            other => vec![other.clone()],
        };
        rows.iter()
            .filter_map(|row| {
                let name = row.get("Name")?.as_str()?.trim();
                let id = row.get("AppID")?.as_str()?.trim();
                if name.is_empty() || id.is_empty() {
                    return None;
                }
                let lower = name.to_lowercase();
                if lower.contains("uninstall") || lower.contains("readme") {
                    return None;
                }
                Some(App {
                    name: name.to_string(),
                    // Both kinds launch the same way through the shell's
                    // Applications folder, so the AppID is stored as the
                    // launch target rather than a path.
                    path: format!("shell:AppsFolder\\{id}"),
                })
            })
            .collect()
    }

    pub fn installed() -> Vec<App> {
        static CACHE: std::sync::OnceLock<Vec<App>> = std::sync::OnceLock::new();
        CACHE
            .get_or_init(|| {
                // Start menu first: its names win the later dedupe, and they
                // are the ones the user sees.
                let mut out = start_apps();
                for root in start_menus() {
                    collect(&root, 5, &mut out);
                }
                out
            })
            .clone()
    }

    pub fn open(path: &str) -> Result<(), String> {
        if path.starts_with("shell:AppsFolder\\") {
            // Packaged apps have no executable to run. Explorer resolves the
            // AppID against the shell's Applications folder, which is the same
            // thing clicking the Start menu tile does.
            return std::process::Command::new("explorer.exe")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        // `cmd /c start` resolves a .lnk the way double-clicking it does, which
        // is what makes shortcuts usable as launch targets at all. The empty
        // "" is start's title argument; without it a quoted path is read as the
        // window title and nothing launches.
        std::process::Command::new("cmd")
            .args(["/c", "start", "", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn close(name: &str) -> Result<usize, String> {
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
        };

        struct Hunt {
            want: String,
            asked: usize,
        }

        unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let hunt = unsafe { &mut *(lparam.0 as *mut Hunt) };
            if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
                return true.into();
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid == 0 {
                return true.into();
            }
            let Ok(handle) =
                (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
            else {
                return true.into();
            };
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let got = unsafe {
                QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(buf.as_mut_ptr()),
                    &mut len,
                )
            };
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
            if got.is_err() {
                return true.into();
            }
            let exe = String::from_utf16_lossy(&buf[..len as usize]);
            let stem = exe
                .rsplit('\\')
                .next()
                .unwrap_or(&exe)
                .trim_end_matches(".exe")
                .trim_end_matches(".EXE");
            if super::normalise(stem) == hunt.want && !super::is_protected(stem) {
                // WM_CLOSE, not TerminateProcess: the program decides, and an
                // unsaved document gets its own prompt. See the module note.
                if unsafe { PostMessageW(hwnd, WM_CLOSE, None, None) }.is_ok() {
                    hunt.asked += 1;
                }
            }
            true.into()
        }

        let mut hunt = Hunt {
            want: super::normalise(name),
            asked: 0,
        };
        if hunt.want.is_empty() {
            return Ok(0);
        }
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut hunt as *mut Hunt as isize));
        }
        Ok(hunt.asked)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::App;

    /// The folders macOS keeps applications in.
    ///
    /// Not recursive beyond one level. Utilities sits inside
    /// /System/Applications and is worth having, but walking the whole tree
    /// finds every helper bundled inside every app — dozens of "Updater" and
    /// "Crash Reporter" entries nobody would ever say out loud, in a list whose
    /// entire job is to be things people say out loud.
    #[cfg(target_os = "macos")]
    fn roots() -> Vec<std::path::PathBuf> {
        let mut out = vec![
            std::path::PathBuf::from("/Applications"),
            std::path::PathBuf::from("/Applications/Utilities"),
            std::path::PathBuf::from("/System/Applications"),
            std::path::PathBuf::from("/System/Applications/Utilities"),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            out.push(std::path::Path::new(&home).join("Applications"));
        }
        out
    }

    #[cfg(target_os = "macos")]
    pub fn installed() -> Vec<App> {
        let mut found: Vec<App> = Vec::new();
        for root in roots() {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("app") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                found.push(App {
                    name: stem.to_string(),
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
        // Two copies of the same app — one in /Applications and one in
        // ~/Applications — are one app as far as anybody speaking is concerned.
        found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        found.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
        found
    }

    #[cfg(not(target_os = "macos"))]
    pub fn installed() -> Vec<App> {
        Vec::new()
    }

    pub fn open(path: &str) -> Result<(), String> {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Ask an application to quit, the way the user pressing Cmd-Q would.
    ///
    /// `quit`, never `kill`. A quit lets the app save and close its documents;
    /// killing it loses whatever was unsaved. A companion that can be asked to
    /// close a program must not be a companion that can lose your work, and the
    /// difference between the two is one AppleScript verb.
    #[cfg(target_os = "macos")]
    pub fn close(name: &str) -> Result<usize, String> {
        let safe = super::applescript_name(name);
        if safe.is_empty() {
            return Err("That is not a program name Loaf can use.".into());
        }
        let script = format!(
            r#"tell application "System Events"
    if not (exists process "{safe}") then return "0"
end tell
tell application "{safe}" to quit
return "1""#
        );
        let out = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("could not run osascript: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(if String::from_utf8_lossy(&out.stdout).trim() == "1" {
            1
        } else {
            0
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn close(_name: &str) -> Result<usize, String> {
        Err("Closing programs by voice is not supported on this platform.".into())
    }
}

/// Keep only what can safely sit inside an AppleScript string literal.
///
/// A REJECT LIST WOULD BE THE WRONG SHAPE HERE. The name reaching this function
/// came from a spoken command, and it is about to be pasted into a script that
/// will be executed — so it is filtered down to the characters a real
/// application name is made of rather than having dangerous ones removed. There
/// is no application called `Mail" & (do shell script "...")`, so nothing is
/// lost, and anything that would end the literal early cannot survive.
pub fn applescript_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '+'))
        .take(60)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> App {
        App {
            name: name.into(),
            path: format!(r"C:\{name}.lnk"),
        }
    }

    // The name came from a spoken command and is about to be pasted into a
    // script that will be executed. Filtered down to what an application name
    // is made of, rather than having dangerous characters removed — there is no
    // app called `Mail" & (do shell script "...")`, so nothing real is lost.
    #[test]
    fn refuses_to_close_the_desktop_on_either_platform() {
        for name in [
            "explorer.exe",
            "Finder",
            "Finder.app",
            "Dock",
            "loginwindow",
        ] {
            assert!(is_protected(name), "{name} should be protected");
        }
    }

    #[test]
    fn refuses_to_close_itself() {
        assert!(is_protected("Loaf"));
        assert!(is_protected("Loaf.app"));
        assert!(is_protected("loaf.exe"));
    }

    #[test]
    fn ordinary_programs_are_not_protected() {
        for name in ["Google Chrome", "Notepad.exe", "Slack.app", "Spotify"] {
            assert!(!is_protected(name), "{name} should not be protected");
        }
    }

    #[test]
    fn an_app_name_cannot_carry_applescript_with_it() {
        let nasty = r#"Mail" & (do shell script "rm -rf /") & ""#;
        let safe = applescript_name(nasty);
        assert!(!safe.contains('"'), "{safe}");
        assert!(!safe.contains('&'), "{safe}");
        assert!(!safe.contains('('), "{safe}");
    }

    #[test]
    fn ordinary_app_names_survive_intact() {
        for name in [
            "Google Chrome",
            "Visual Studio Code",
            "Microsoft Word",
            "IINA",
            "Adobe Photoshop 2024",
            "iTerm2",
        ] {
            assert_eq!(applescript_name(name), name);
        }
    }

    #[test]
    fn names_that_are_only_punctuation_come_back_empty() {
        assert_eq!(applescript_name(r#""""#), "");
        assert_eq!(applescript_name("   "), "");
        assert_eq!(applescript_name(""), "");
    }

    #[test]
    fn a_very_long_name_is_cut_rather_than_passed_on() {
        assert!(applescript_name(&"a".repeat(500)).len() <= 60);
    }

    #[test]
    fn normalises_the_things_nobody_says() {
        assert_eq!(normalise("Visual Studio Code"), "visual studio code");
        assert_eq!(normalise("Firefox (Private)"), "firefox private");
        assert_eq!(normalise("  Notepad++  "), "notepad");
    }

    #[test]
    fn finds_an_exact_name() {
        let apps = [app("Notepad"), app("Calculator")];
        assert_eq!(best_match("notepad", &apps).unwrap().name, "Notepad");
    }

    // The recogniser has already done the guessing. A near-miss that launches
    // the wrong program is worse than one that says it did not understand.
    #[test]
    fn refuses_a_near_miss() {
        let apps = [app("Notepad")];
        assert!(best_match("note", &apps).is_none());
        assert!(best_match("nodepad", &apps).is_none());
        assert!(best_match("", &apps).is_none());
    }

    #[test]
    fn prefers_the_plain_name_over_a_variant() {
        let apps = [app("Firefox Private Browsing"), app("Firefox")];
        assert_eq!(best_match("firefox", &apps).unwrap().name, "Firefox");
    }

    #[test]
    fn matches_a_whole_word_prefix() {
        let apps = [app("Visual Studio Code")];
        assert_eq!(
            best_match("visual studio", &apps).unwrap().name,
            "Visual Studio Code"
        );
    }

    // Closing the shell by accident is not a recoverable mistake, and no
    // phrasing makes it one.
    #[test]
    fn never_closes_the_desktop() {
        for name in [
            "explorer",
            "Explorer.exe",
            r"C:\Windows\explorer.exe",
            "LSASS",
        ] {
            assert!(is_protected(name), "{name} should be protected");
        }
        assert!(close("explorer").is_err());
    }

    /// What this machine actually has. Ignored in CI, where the Start Menu is
    /// empty and the answer would mean nothing.
    ///
    ///     cargo test -- --ignored --nocapture what_is_installed
    #[test]
    #[ignore]
    fn what_is_installed() {
        let found = installed();
        println!("{} programs found", found.len());
        for want in ["notepad", "calculator", "firefox", "google chrome"] {
            match best_match(want, &found) {
                Some(a) => println!("  {want:14} -> {} ({})", a.name, a.path),
                None => println!("  {want:14} -> not found"),
            }
        }
        assert!(!found.is_empty(), "no Start Menu shortcuts found at all");
    }

    #[test]
    fn does_not_protect_ordinary_programs() {
        for name in ["notepad", "chrome.exe", "Spotify"] {
            assert!(!is_protected(name), "{name} should be closable");
        }
    }
}
