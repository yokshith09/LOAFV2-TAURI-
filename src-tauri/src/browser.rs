//! Reading the active tab's **domain** and the open-tab count out of a browser.
//! Ported from `BrowserProbe.swift`.
//!
//! This is the one thing Loaf does that needs a real permission, and the design
//! is built around asking for as little as it can:
//!
//! 1. **Domain only.** The path, query and fragment are stripped *inside the
//!    AppleScript*, so the full URL never crosses the process boundary and never
//!    exists in Loaf's memory — not "we promise not to store it". Non-http(s)
//!    URLs (chrome://, file://) return nothing at all.
//! 2. **Never launches a browser.** `tell application` would happily boot one
//!    that was closed, so the caller only ever probes the app that is already in
//!    front.
//!
//! Both platforms are supported, by different routes and with a difference
//! worth stating: on macOS the truncation happens inside the browser, so the
//! full URL never crosses a process boundary at all. Windows has no such route
//! and reads the address bar as text, so the URL exists here briefly before
//! being cut down. See `browser_windows.rs` for what that costs and the two
//! mitigations that keep it small.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProbeOutcome {
    Reading {
        domain: Option<String>,
        #[serde(rename = "tabCount")]
        tab_count: u32,
    },
    /// The user said no in the permission prompt, or never answered it.
    Denied,
    /// No windows, an unreadable window, a script error, or a timeout.
    Unavailable { why: String },
}

/// Whether this build can read tabs at all.
///
/// Checked before the radar is offered rather than after every browser fails:
/// a list of five browsers all saying "couldn't be read" is a worse answer than
/// one sentence saying the feature is not here.
pub const fn supported() -> bool {
    cfg!(any(target_os = "macos", windows))
}

/// How the domain was obtained, so the dashboard can be honest about it.
pub const fn reads_inside_the_browser() -> bool {
    cfg!(target_os = "macos")
}

/// Writing and reading the macOS "which browsers are running" script.
///
/// DELIBERATELY NOT BEHIND A `cfg`, for the reason `browser_macos.rs` gives
/// about its own escaping: the development machine for this project is a PC, and
/// this module contains the injection boundary. Gating it to macOS would make the
/// one piece of code that must be right the one piece nobody here can run.
///
/// The `allow` is narrowed to "not macOS" rather than blanket, so that on the
/// platform which actually calls this, an unused function is still an error.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod applescript {
    /// Process names come back separated by this, not by a comma.
    ///
    /// Same reason `browser_macos.rs` uses it for titles: AppleScript's own list
    /// separator is ", " and "Brave Browser, Beta" would split into two.
    pub const SEP: &str = "\u{1}";

    /// Whether this name can go into an AppleScript string literal untouched.
    ///
    /// NOT escaping — refusing. Every browser process name is letters, digits,
    /// spaces, dots and dashes, so anything containing a quote or a backslash is
    /// either a mistake or an attempt to close the string early and append a
    /// line of script. There is no reading of that where guessing what was meant
    /// beats skipping the entry.
    pub fn safe(name: &str) -> bool {
        let trimmed = name.trim();
        !trimmed.is_empty()
            && trimmed.len() <= 64
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '.' || c == '-')
    }

    /// A script asking System Events which of these processes exist right now.
    ///
    /// System Events, and not `running of application id "X"`: `tell
    /// application` will happily boot a browser that was closed, and a pet that
    /// opens Chrome in order to count its tabs has become the problem it was
    /// reporting on.
    ///
    /// Empty when nothing survives `safe`, so the caller can skip the spawn.
    pub fn running_script(names: &[String]) -> String {
        let checks: Vec<String> = names
            .iter()
            .filter(|n| safe(n))
            .map(|n| {
                let name = n.trim();
                format!(
                    "    if exists process \"{name}\" then set out to out & \"{name}\" & \"{SEP}\""
                )
            })
            .collect();
        if checks.is_empty() {
            return String::new();
        }
        format!(
            "tell application \"System Events\"\n    set out to \"\"\n{}\n    return out\nend tell",
            checks.join("\n")
        )
    }

    pub fn parse_running(raw: &str) -> Vec<String> {
        raw.split(SEP)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ProbeOutcome;
    use std::process::Command;

    /// Counts tabs across every window and reduces the active tab's URL to its
    /// host **before returning**. `text item delimiters` does the truncation
    /// in-script, so `https://mail.google.com/mail/u/0/#inbox` leaves the
    /// browser as `mail.google.com` and the rest is never handed to Loaf.
    fn script(bundle_id: &str, safari: bool, timeout_secs: u32) -> String {
        let active_tab = if safari { "current tab" } else { "active tab" };
        format!(
            r#"with timeout of {timeout_secs} seconds
tell application id "{bundle_id}"
    set tabTotal to 0
    repeat with w in windows
        try
            set tabTotal to tabTotal + (count of tabs of w)
        end try
    end repeat
    set theHost to ""
    try
        set theURL to URL of {active_tab} of front window
        if theURL starts with "http://" or theURL starts with "https://" then
            set AppleScript's text item delimiters to "://"
            set theRest to item 2 of text items of theURL
            set AppleScript's text item delimiters to "/"
            set theHost to item 1 of text items of theRest
            if theHost contains "@" then
                set AppleScript's text item delimiters to "@"
                set theHost to last text item of theHost
            end if
            set AppleScript's text item delimiters to ""
        end if
    end try
    return (tabTotal as text) & " " & theHost
end tell
end timeout"#
        )
    }

    pub fn probe(bundle_id: &str, safari: bool, timeout_secs: u32) -> ProbeOutcome {
        // A separate `osascript` process rather than an in-process API: a script
        // that hangs on a wedged browser takes a child process with it and not
        // the app.
        let output = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script(bundle_id, safari, timeout_secs))
            .output();

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                return ProbeOutcome::Unavailable {
                    why: format!("could not run osascript: {e}"),
                }
            }
        };

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).to_lowercase();
            // -1743 is errAEEventNotPermitted: Automation permission not granted.
            if err.contains("-1743") || err.contains("not authorized") {
                return ProbeOutcome::Denied;
            }
            if err.contains("-600") || err.contains("-609") {
                return ProbeOutcome::Unavailable {
                    why: "isn't running".into(),
                };
            }
            return ProbeOutcome::Unavailable {
                why: "couldn't be read".into(),
            };
        }

        parse(&String::from_utf8_lossy(&output.stdout))
    }

    pub fn running(ids: &[String]) -> Vec<String> {
        let script = super::applescript::running_script(ids);
        if script.is_empty() {
            return Vec::new();
        }
        let Ok(output) = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(&script)
            .output()
        else {
            return Vec::new();
        };
        if !output.status.success() {
            // Almost always Automation permission for System Events not granted.
            // An empty list reads as "no browsers", which the dashboard already
            // renders honestly; it is not worth inventing a browser to say so.
            return Vec::new();
        }
        super::applescript::parse_running(&String::from_utf8_lossy(&output.stdout))
    }

    /// `"<tabCount> <host>"`, where the host may be empty for a non-web page.
    pub fn parse(raw: &str) -> ProbeOutcome {
        let trimmed = raw.trim();
        let (count_part, host_part) = match trimmed.split_once(' ') {
            Some((a, b)) => (a, b.trim()),
            None => (trimmed, ""),
        };
        match count_part.parse::<u32>() {
            Ok(tab_count) => ProbeOutcome::Reading {
                domain: if host_part.is_empty() {
                    None
                } else {
                    Some(host_part.to_string())
                },
                tab_count,
            },
            Err(_) => ProbeOutcome::Unavailable {
                why: "gave an answer Loaf didn't understand".into(),
            },
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::ProbeOutcome;

    /// The safari flag and timeout are macOS's business; on Windows `id` is the
    /// executable name, and every window belonging to it is counted.
    pub fn probe(id: &str, _safari: bool, _timeout_secs: u32) -> ProbeOutcome {
        crate::browser_windows::probe(id)
    }

    pub fn running(ids: &[String]) -> Vec<String> {
        crate::browser_windows::running(ids)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::ProbeOutcome;

    pub fn probe(_bundle_id: &str, _safari: bool, _timeout_secs: u32) -> ProbeOutcome {
        ProbeOutcome::Unavailable {
            why: "reading tabs is not supported on this platform".into(),
        }
    }

    pub fn running(_ids: &[String]) -> Vec<String> {
        Vec::new()
    }
}

pub use imp::{probe, running};

/// Runs on every platform, because this is the injection boundary.
#[cfg(test)]
mod running_tests {
    use super::applescript::{
        parse_running, running_script, safe as script_safe, SEP as RUNNING_SEP,
    };

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn asks_about_each_browser_by_process_name() {
        let script = running_script(&names(&["Google Chrome", "Safari"]));
        assert!(script.contains(r#"exists process "Google Chrome""#));
        assert!(script.contains(r#"exists process "Safari""#));
        assert!(script.contains("System Events"));
    }

    #[test]
    fn never_tells_an_application_anything() {
        // `tell application id "..."` would LAUNCH a closed browser. The whole
        // point of going through System Events is that this cannot happen, so
        // the script must not contain the phrase that would do it.
        let script = running_script(&names(&["Google Chrome", "Firefox"]));
        assert!(!script.contains("tell application id"));
        assert!(!script.contains(r#"tell application "Google Chrome""#));
    }

    #[test]
    fn refuses_a_name_that_could_end_the_string_early() {
        // The attack: a name that closes the quote and adds a line of its own.
        for bad in [
            r#"Chrome" then do shell script "rm -rf ~" -- "#,
            "Chrome\"",
            "Chrome\\",
            "Chrome\nreturn",
            "",
            "   ",
        ] {
            assert!(!script_safe(bad), "should have refused: {bad:?}");
            assert_eq!(
                running_script(&names(&[bad])),
                "",
                "leaked into script: {bad:?}"
            );
        }
    }

    #[test]
    fn one_bad_name_does_not_take_the_good_ones_with_it() {
        let script = running_script(&names(&["Google Chrome", "Evil\" -- ", "Safari"]));
        assert!(script.contains(r#""Google Chrome""#));
        assert!(script.contains(r#""Safari""#));
        assert!(!script.contains("Evil"));
    }

    #[test]
    fn reads_back_what_the_script_reports() {
        let raw = format!("Google Chrome{RUNNING_SEP}Safari{RUNNING_SEP}");
        assert_eq!(parse_running(&raw), vec!["Google Chrome", "Safari"]);
    }

    #[test]
    fn nothing_running_is_an_empty_list_not_a_blank_name() {
        assert!(parse_running("").is_empty());
        assert!(parse_running("\n").is_empty());
    }

    #[test]
    fn a_browser_whose_name_has_a_comma_survives_the_split() {
        // Why the separator is not a comma: AppleScript's own list separator is
        // ", " and this would otherwise arrive as two browsers.
        let raw = format!("Brave Browser{RUNNING_SEP}");
        assert_eq!(parse_running(&raw), vec!["Brave Browser"]);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::imp::parse;
    use super::ProbeOutcome;

    #[test]
    fn reads_a_count_and_a_host() {
        match parse("47 github.com\n") {
            ProbeOutcome::Reading { domain, tab_count } => {
                assert_eq!(tab_count, 47);
                assert_eq!(domain.as_deref(), Some("github.com"));
            }
            other => panic!("expected a reading, got {other:?}"),
        }
    }

    #[test]
    fn a_non_web_page_has_a_count_but_no_host() {
        // A new tab, a PDF, the settings page. Still worth the tab count.
        match parse("3 \n") {
            ProbeOutcome::Reading { domain, tab_count } => {
                assert_eq!(tab_count, 3);
                assert!(domain.is_none());
            }
            other => panic!("expected a reading, got {other:?}"),
        }
    }

    #[test]
    fn a_lone_count_is_still_a_reading() {
        match parse("0") {
            ProbeOutcome::Reading { tab_count, .. } => assert_eq!(tab_count, 0),
            other => panic!("expected a reading, got {other:?}"),
        }
    }

    #[test]
    fn anything_else_is_unavailable_rather_than_guessed_at() {
        assert!(matches!(parse(""), ProbeOutcome::Unavailable { .. }));
        assert!(matches!(parse("what"), ProbeOutcome::Unavailable { .. }));
    }
}
