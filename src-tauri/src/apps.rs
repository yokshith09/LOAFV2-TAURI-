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

/// Executables Loaf will never close, whatever it thinks it heard.
///
/// `explorer` is the desktop itself; the rest end the session or take the
/// machine down with them. Loaf is on the list because a pet that can be told
/// to kill itself mid-sentence is a bug report nobody can describe.
pub const PROTECTED: &[&str] = &[
    "explorer", "csrss", "winlogon", "wininit", "services", "lsass", "smss", "svchost", "dwm",
    "system", "loaf",
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
        .trim_end_matches(".EXE");
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
        return Err(format!(
            "{name} is part of Windows, so Loaf will not close it."
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

    pub fn close(_name: &str) -> Result<usize, String> {
        Err("Closing programs by voice is Windows-only for now.".into())
    }
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
