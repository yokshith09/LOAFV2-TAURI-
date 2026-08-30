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

    /// The bundle id and timeout are macOS's business; Windows reads whatever
    /// window is in front, which the radar has already decided is a browser.
    pub fn probe(_bundle_id: &str, _safari: bool, _timeout_secs: u32) -> ProbeOutcome {
        crate::browser_windows::probe()
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
}

pub use imp::probe;

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
