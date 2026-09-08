//! Listing and closing browser tabs on macOS.
//!
//! The counterpart to `browser_windows.rs`, which does the same job through UI
//! Automation. This is the macOS half of the tab panel and the tab tantrum —
//! two features that have been Windows-only since they were written, which is
//! exactly the drift the both-platforms rule exists to stop.
//!
//! TITLES ONLY, NEVER ADDRESSES. What a browser writes on its tab strip is
//! already on the user's screen; the URL is not. `browser.rs` goes to real
//! trouble to make sure a full address never crosses the process boundary, and
//! this file must not be the hole in that: the scripts below ask for `title` (or
//! Safari's `name`) and never for `URL`. The tab tantrum needs to know that
//! forty tabs are open and roughly what they are. It has never needed to know
//! where they point.
//!
//! IT NEVER LAUNCHES A BROWSER. `tell application "Google Chrome"` will happily
//! boot Chrome if it is closed, which would make a feature that counts tabs into
//! a feature that opens a browser nobody asked for. Every script below is
//! guarded by `System Events`' running check first, and the caller is expected
//! to be asking about a browser that is already in front.
//!
//! CLOSING IS BY TITLE, AND THE FIRST EXACT MATCH WINS. Not by index: indices
//! shift the moment anything else closes a tab, and closing the wrong tab is a
//! small disaster in a product whose whole promise is not touching things it was
//! not asked to touch.

/// THE ONLY PART THAT NEEDS A MAC.
///
/// Everything else in this file — the script text, the escaping, the splitting
/// — is pure string work, and it is deliberately NOT behind a `cfg`. The
/// development machine for this project is a PC, so anything gated to macOS is
/// code nobody here can run: it compiles on a runner and its tests are only
/// ever seen by CI. The escaping below is the piece where a mistake is an
/// injection, so it is the last piece that should be invisible locally.
#[cfg(target_os = "macos")]
fn osascript(script: &str) -> Option<String> {
    use std::process::Command;
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(not(target_os = "macos"))]
fn osascript(_script: &str) -> Option<String> {
    None
}

/// The browsers worth asking, in the order they are asked.
///
/// Chromium-family browsers all answer the same AppleScript vocabulary, which
/// is why one script covers four of them. Safari uses different nouns and gets
/// its own.
const CHROMIUM: &[&str] = &[
    "Google Chrome",
    "Brave Browser",
    "Microsoft Edge",
    "Arc",
    "Vivaldi",
];

/// Titles come back separated by this rather than by a comma.
///
/// A tab called "Pricing, plans and billing" is completely ordinary, and
/// splitting AppleScript's default comma-separated list on commas would turn it
/// into three tabs. The separator has to be something no page title contains.
const SEP: &str = "\u{1}";

/// The script for a Chromium-family browser, or None if it is not running.
fn chromium_list(app: &str) -> String {
    format!(
        r#"tell application "System Events"
    if not (exists process "{app}") then return ""
end tell
tell application "{app}"
    set out to ""
    repeat with w in windows
        repeat with t in tabs of w
            set out to out & (title of t) & "{SEP}"
        end repeat
    end repeat
    return out
end tell"#
    )
}

fn safari_list() -> String {
    format!(
        r#"tell application "System Events"
    if not (exists process "Safari") then return ""
end tell
tell application "Safari"
    set out to ""
    repeat with w in windows
        repeat with t in tabs of w
            set out to out & (name of t) & "{SEP}"
        end repeat
    end repeat
    return out
end tell"#
    )
}

fn split(raw: &str) -> Vec<String> {
    raw.split(SEP)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Every open tab title, across whichever supported browser is running.
///
/// Empty when nothing is running, when permission was refused, or when the
/// browser is not one we know — all of which are "we could not read them"
/// rather than "there are none". The caller distinguishes those; see the
/// `tabsRead` flag the dashboard already carries for exactly this reason.
pub fn list_tabs() -> Vec<String> {
    for app in CHROMIUM {
        if let Some(raw) = osascript(&chromium_list(app)) {
            let tabs = split(&raw);
            if !tabs.is_empty() {
                return tabs;
            }
        }
    }
    osascript(&safari_list())
        .map(|r| split(&r))
        .unwrap_or_default()
}

fn chromium_close(app: &str, title: &str) -> String {
    let title = escape(title);
    format!(
        r#"tell application "System Events"
    if not (exists process "{app}") then return "no"
end tell
tell application "{app}"
    repeat with w in windows
        repeat with t in tabs of w
            if (title of t) is equal to "{title}" then
                close t
                return "yes"
            end if
        end repeat
    end repeat
    return "no"
end tell"#
    )
}

fn safari_close(title: &str) -> String {
    let title = escape(title);
    format!(
        r#"tell application "System Events"
    if not (exists process "Safari") then return "no"
end tell
tell application "Safari"
    repeat with w in windows
        repeat with t in tabs of w
            if (name of t) is equal to "{title}" then
                close t
                return "yes"
            end if
        end repeat
    end repeat
    return "no"
end tell"#
    )
}

/// Make a page title safe to sit inside an AppleScript string literal.
///
/// THE TITLE IS NOT OURS. It is whatever a web page decided to call itself, and
/// it is being pasted into a script that is about to be executed. A title
/// containing a quote would end the literal early and leave the rest of it as
/// code — which is the AppleScript spelling of an injection. Backslash first,
/// or it would escape the escapes.
pub fn escape(title: &str) -> String {
    title
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        // A newline inside a literal is a syntax error rather than a hazard, but
        // it fails the whole script, so titles with one would silently never be
        // closable.
        .replace(['\n', '\r'], " ")
}

/// Close the first tab with exactly this title. False means it was not found.
pub fn close_tab(title: &str) -> bool {
    for app in CHROMIUM {
        if let Some(out) = osascript(&chromium_close(app, title)) {
            if out.trim() == "yes" {
                return true;
            }
        }
    }
    osascript(&safari_close(title))
        .map(|o| o.trim() == "yes")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A tab called "Pricing, plans and billing" is completely ordinary, and
    // splitting on commas would turn it into three tabs.
    #[test]
    fn splits_on_something_no_title_contains() {
        let raw = format!("Pricing, plans and billing{SEP}GitHub{SEP}");
        assert_eq!(split(&raw), vec!["Pricing, plans and billing", "GitHub"]);
    }

    #[test]
    fn ignores_empty_entries_and_whitespace() {
        let raw = format!("{SEP}  {SEP}Real{SEP}");
        assert_eq!(split(&raw), vec!["Real"]);
    }

    #[test]
    fn no_tabs_reads_as_none_found() {
        assert!(split("").is_empty());
    }

    /// True when every quote in `s` is preceded by an odd number of backslashes.
    ///
    /// Asserted directly rather than by hunting for a substring. The first
    /// version of this test checked that the output did not contain `" &` — but
    /// correctly escaped text contains that too, inside `\" &`. It failed while
    /// the escaping was right, which is the worse of the two ways to be wrong:
    /// a test that cries wolf gets weakened until it stops catching anything.
    fn every_quote_is_escaped(s: &str) -> bool {
        let chars: Vec<char> = s.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if *c != '"' {
                continue;
            }
            let mut slashes = 0usize;
            let mut j = i;
            while j > 0 && chars[j - 1] == '\\' {
                slashes += 1;
                j -= 1;
            }
            // Even means the backslashes escaped each other and this quote is
            // bare, which would end the AppleScript literal.
            if slashes % 2 == 0 {
                return false;
            }
        }
        true
    }

    // The title is whatever a web page called itself, and it is being pasted
    // into a script that is about to run.
    #[test]
    fn a_quote_in_a_title_cannot_end_the_literal() {
        let nasty = r#"Evil" & (do shell script "rm -rf /") & ""#;
        let safe = escape(nasty);
        assert!(every_quote_is_escaped(&safe), "{safe}");
    }

    /// The check above must be able to fail, or it proves nothing.
    #[test]
    fn the_escape_check_itself_is_not_vacuous() {
        assert!(!every_quote_is_escaped(r#"a" b"#));
        assert!(every_quote_is_escaped(r#"a\" b"#));
        // Two backslashes escape each other, leaving the quote bare.
        assert!(!every_quote_is_escaped(r#"a\\" b"#));
    }

    #[test]
    fn a_backslash_is_escaped_before_the_quotes_are() {
        // If quotes were escaped first, the backslash added would then itself be
        // doubled and the escaping would come apart.
        assert_eq!(escape(r#"a\b"c"#), r#"a\\b\"c"#);
    }

    #[test]
    fn newlines_cannot_break_the_script() {
        assert_eq!(escape("one\ntwo\r\nthree"), "one two  three");
    }

    #[test]
    fn an_ordinary_title_is_left_alone() {
        assert_eq!(
            escape("GitHub - yokshith09/loaf"),
            "GitHub - yokshith09/loaf"
        );
    }

    // Every script must check the process is running before it says
    // `tell application`, or counting tabs becomes launching a browser.
    #[test]
    fn no_script_can_launch_a_browser() {
        let scripts = [
            chromium_list("Google Chrome"),
            safari_list(),
            chromium_close("Google Chrome", "x"),
            safari_close("x"),
        ];
        for s in scripts {
            assert!(
                s.contains("exists process"),
                "a script can launch a browser:\n{s}"
            );
            let guard = s.find("exists process").unwrap();
            let tell = s
                .find("tell application \"Google Chrome\"")
                .or_else(|| s.find("tell application \"Safari\""));
            if let Some(tell) = tell {
                assert!(guard < tell, "the guard comes after the tell:\n{s}");
            }
        }
    }

    // Titles only. browser.rs takes real trouble to keep full addresses from
    // ever crossing the process boundary, and this must not be the hole in it.
    #[test]
    fn no_script_ever_asks_for_a_url() {
        let scripts = [
            chromium_list("Google Chrome"),
            safari_list(),
            chromium_close("Google Chrome", "x"),
            safari_close("x"),
        ];
        for s in scripts {
            let lower = s.to_lowercase();
            assert!(!lower.contains("url"), "a script asks for a URL:\n{s}");
        }
    }
}
