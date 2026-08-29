//! Turning whatever the OS hands back into a name worth showing a person.
//!
//! Deliberately pure and OS-free so it can be unit-tested everywhere, including
//! on Linux CI where neither native probe compiles. This is where the fiddly
//! cases live, so this is where the tests live.

/// Derive a display name from a Windows executable path or a macOS bundle path.
///
/// Windows hands back `C:\Program Files\Google\Chrome\Application\chrome.exe`;
/// macOS hands back a localised name already, or a bundle id if it does not.
/// Both collapse to the same shape: strip the directories, strip the extension,
/// then tidy the leftovers.
pub fn display_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Take the last path component, tolerating both separators — a macOS path
    // can appear on Windows in logs and vice versa.
    let base = trimmed
        .rsplit(['\\', '/'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed);

    // Drop a trailing .exe / .app. Only those two: an app legitimately named
    // "Notes.and.More" must not lose its tail to a naive rsplit('.').
    let stem = strip_known_extension(base);

    if stem.is_empty() {
        return String::new();
    }

    prettify(stem)
}

fn strip_known_extension(name: &str) -> &str {
    for ext in [".exe", ".EXE", ".app", ".APP"] {
        if let Some(rest) = name.strip_suffix(ext) {
            return rest;
        }
    }
    name
}

/// Tidy an executable stem into something presentable.
///
/// Kept conservative on purpose: we only add capitalisation to names that carry
/// none of their own. Real app names encode deliberate casing ("iTerm", "VLC",
/// "IntelliJ IDEA") and must survive untouched.
fn prettify(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if c == '_' { ' ' } else { c })
        .collect();
    let cleaned = cleaned.trim();

    if cleaned.is_empty() || is_drive_root(cleaned) {
        return String::new();
    }

    // Decide on the presence of uppercase ANYWHERE, not on word count. Testing
    // for a single word here was a bug: `my_editor` becomes `my editor` above,
    // which then stopped looking like one word and never got capitalised.
    if cleaned.chars().any(char::is_uppercase) {
        return cleaned.to_string();
    }

    let mut chars = cleaned.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `C:` and friends. A drive root is a path that lost its file, not an app name.
fn is_drive_root(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Windows reports idle in milliseconds since boot via a wrapping 32-bit tick
/// counter. Convert to seconds, handling the ~49.7-day wraparound rather than
/// reporting a wildly negative idle time when the machine has been up that long.
pub fn idle_seconds_from_ticks(now_tick: u32, last_input_tick: u32) -> f64 {
    // Wrapping subtraction is correct here: if `now` has wrapped past `last`,
    // the wrapped difference is still the true elapsed count.
    let delta_ms = now_tick.wrapping_sub(last_input_tick);
    f64::from(delta_ms) / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_path_and_exe() {
        assert_eq!(
            display_name(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            "Chrome"
        );
    }

    #[test]
    fn strips_macos_bundle_path() {
        assert_eq!(
            display_name("/Applications/Visual Studio Code.app"),
            "Visual Studio Code"
        );
    }

    #[test]
    fn preserves_deliberate_casing() {
        // These are the cases a naive title-caser ruins.
        assert_eq!(display_name("iTerm.app"), "iTerm");
        assert_eq!(display_name("VLC.app"), "VLC");
        assert_eq!(display_name(r"C:\bin\IntelliJ IDEA.exe"), "IntelliJ IDEA");
    }

    #[test]
    fn title_cases_only_bare_lowercase_words() {
        assert_eq!(display_name("notepad.exe"), "Notepad");
        assert_eq!(display_name("code.exe"), "Code");
    }

    #[test]
    fn does_not_eat_dots_inside_a_name() {
        // The bug a rsplit('.') implementation would have.
        assert_eq!(display_name("Notes.and.More.app"), "Notes.and.More");
        assert_eq!(display_name("com.apple.Safari"), "com.apple.Safari");
    }

    #[test]
    fn handles_mixed_separators() {
        assert_eq!(display_name("C:/Windows/System32/notepad.exe"), "Notepad");
    }

    #[test]
    fn underscores_become_spaces() {
        assert_eq!(display_name("my_editor.exe"), "My editor");
    }

    #[test]
    fn empty_and_whitespace_are_empty_not_panics() {
        assert_eq!(display_name(""), "");
        assert_eq!(display_name("   "), "");
        assert_eq!(display_name(r"C:\"), "");
    }

    #[test]
    fn trailing_separator_does_not_yield_empty() {
        // `rsplit` would hand back "" for a trailing slash; we skip empties.
        assert_eq!(display_name("/Applications/Mail.app/"), "Mail");
    }

    #[test]
    fn uppercase_extension_is_stripped_too() {
        assert_eq!(display_name("NOTEPAD.EXE"), "NOTEPAD");
    }

    #[test]
    fn idle_ticks_convert_to_seconds() {
        assert!((idle_seconds_from_ticks(10_000, 4_000) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn idle_ticks_survive_the_49_day_wraparound() {
        // now has wrapped; last_input is near u32::MAX. True elapsed is 1000ms.
        let last = u32::MAX - 499;
        let now = 500u32;
        let secs = idle_seconds_from_ticks(now, last);
        assert!(
            (secs - 1.0).abs() < 1e-9,
            "wraparound produced {secs}s, expected 1s"
        );
    }

    #[test]
    fn idle_is_never_negative() {
        for (now, last) in [(0u32, 0u32), (0, 1), (1, 0), (u32::MAX, 0), (0, u32::MAX)] {
            assert!(idle_seconds_from_ticks(now, last) >= 0.0);
        }
    }
}
