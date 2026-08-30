//! Reading a browser's active-tab domain on Windows, through UI Automation.
//!
//! WHAT THIS COSTS, HONESTLY. On macOS the AppleScript truncates the URL to its
//! host *inside the browser*, so the path and query never cross a process
//! boundary. Windows has no such route: the address bar is read as text, and the
//! full URL therefore exists in this process for the few microseconds between
//! reading it and truncating it. That is a real difference, it is disclosed in
//! the dashboard, and it is why the truncation happens HERE, in Rust, before the
//! value can reach the frontend, storage or a log line.
//!
//! Two mitigations make the difference small enough to live with:
//!
//! 1. **Never read while the user is typing.** A focused address bar holds a
//!    half-written search query, which can be anything at all — someone's
//!    question to a search engine is not a domain and must never be treated as
//!    one. If the focused element is an edit box, this returns nothing.
//! 2. **Host only, immediately.** `host_of` runs before the string is stored
//!    anywhere, and anything that is not plainly a host is dropped rather than
//!    guessed at.
//!
//! The other routes were considered and rejected: a browser extension would
//! truncate at the source like macOS does, but means shipping and maintaining
//! three store listings; the window title gives a page *title*, not a domain,
//! and is more revealing rather than less.

#![cfg(windows)]

use crate::browser::ProbeOutcome;
use windows::core::{Interface, VARIANT};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_TabItemControlTypeId,
    UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// Reduce whatever the address bar was showing to a bare host.
///
/// Separate and pure so it can be tested without a browser, a window, or COM.
/// Chromium hides the scheme in the omnibox, so the value is usually already
/// `github.com/user/repo` rather than a full URL — both shapes are handled.
pub fn host_of(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // Only ever the web. A `file://` path or an `edge://` settings page is not
    // somewhere you browsed to, and a local path is nobody's business.
    if let Some(rest) = s.split_once("://") {
        if !matches!(rest.0, "http" | "https") {
            return None;
        }
        s = rest.1;
    } else if s.contains(':') && !s.contains('/') {
        // `edge://settings` with the scheme collapsed by the omnibox, or a
        // host:port. Told apart below by the character check.
    }
    // Everything from the first slash, question mark or hash onward is the part
    // this app has no business seeing.
    let host = s
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let host = host.rsplit('@').next().unwrap_or("").to_string();
    let host = host.split(':').next().unwrap_or("").to_string();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();

    if host.is_empty() || !host.contains('.') {
        // A typed search term has no dot; neither does `newtab`. Requiring one
        // costs us `localhost` and nothing else anyone would miss.
        return None;
    }
    if host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        Some(host)
    } else {
        None
    }
}

/// A COM apartment for the duration of one probe.
///
/// Entered and left per call rather than held: Tauri runs commands on a thread
/// pool, so there is no one thread to initialise once, and a probe happens
/// every five seconds at most.
struct Apartment(bool);

impl Apartment {
    fn enter() -> Self {
        // RPC_E_CHANGED_MODE means this thread is already in an apartment of
        // another kind, which is fine — we just must not uninitialise it.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Apartment(hr.is_ok())
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub fn probe() -> ProbeOutcome {
    let _apartment = Apartment::enter();

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == HWND(std::ptr::null_mut()) {
        return ProbeOutcome::Unavailable {
            why: "no window in front".into(),
        };
    }

    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(_) => {
                return ProbeOutcome::Unavailable {
                    why: "UI Automation is unavailable".into(),
                }
            }
        };

    let root = match unsafe { automation.ElementFromHandle(hwnd) } {
        Ok(e) => e,
        Err(_) => {
            return ProbeOutcome::Unavailable {
                why: "couldn't be read".into(),
            }
        }
    };

    let tab_count = count_tabs(&automation, &root).unwrap_or(0);

    // MITIGATION 1. A focused edit box is an address bar being typed into, and
    // what is in it is a search query, not a destination. The tab count is still
    // honest, so it is still reported.
    if focused_is_edit(&automation) {
        return ProbeOutcome::Reading {
            domain: None,
            tab_count,
        };
    }

    let domain = read_address_bar(&automation, &root).and_then(|v| host_of(&v));
    ProbeOutcome::Reading { domain, tab_count }
}

fn focused_is_edit(automation: &IUIAutomation) -> bool {
    unsafe {
        automation
            .GetFocusedElement()
            .and_then(|e| e.CurrentControlType())
            .map(|t| t == UIA_EditControlTypeId)
            .unwrap_or(false)
    }
}

fn read_address_bar(
    automation: &IUIAutomation,
    root: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<String> {
    unsafe {
        let condition = automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_EditControlTypeId.0),
            )
            .ok()?;
        // The omnibox is the first edit control in a Chromium window. FindFirst
        // rather than FindAll: a page can contain a thousand text inputs of its
        // own, and none of them is the address bar.
        let element = root.FindFirst(TreeScope_Descendants, &condition).ok()?;
        let pattern: IUIAutomationValuePattern =
            element.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
        let value = pattern.CurrentValue().ok()?;
        Some(value.to_string())
    }
}

fn count_tabs(
    automation: &IUIAutomation,
    root: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<u32> {
    unsafe {
        let condition = automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_TabItemControlTypeId.0),
            )
            .ok()?;
        let found = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let length = found.Length().ok()?;
        Some(length.max(0) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::host_of;

    #[test]
    fn takes_the_host_out_of_a_full_url() {
        assert_eq!(
            host_of("https://mail.google.com/mail/u/0/#inbox").as_deref(),
            Some("mail.google.com")
        );
    }

    #[test]
    fn handles_the_omnibox_hiding_the_scheme() {
        // Chromium shows `github.com/user/repo` rather than the full URL.
        assert_eq!(
            host_of("github.com/user/private-repo").as_deref(),
            Some("github.com")
        );
    }

    #[test]
    fn drops_everything_after_the_host() {
        // The whole point. A path or a query must never survive this function.
        for raw in [
            "example.com/secret/path",
            "example.com?q=something+private",
            "example.com#fragment",
        ] {
            assert_eq!(host_of(raw).as_deref(), Some("example.com"), "{raw}");
        }
    }

    #[test]
    fn refuses_a_scheme_that_is_not_the_web() {
        // A local file path is nobody's business, and a settings page is not a
        // site you visited.
        assert!(host_of("file:///C:/Users/me/taxes.pdf").is_none());
        assert!(host_of("edge://settings/privacy").is_none());
        assert!(host_of("chrome://history").is_none());
    }

    #[test]
    fn refuses_a_typed_search_query() {
        // This is the one that matters: if the focus check ever fails, a search
        // term must still not be recorded as a domain. None of these has a dot.
        assert!(host_of("how to leave a job").is_none());
        assert!(host_of("what is a good divorce lawyer").is_none());
        assert!(host_of("").is_none());
        assert!(host_of("   ").is_none());
    }

    #[test]
    fn drops_credentials_and_ports() {
        assert_eq!(
            host_of("https://user:pass@example.com:8443/x").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn sheds_a_leading_www() {
        assert_eq!(host_of("https://www.example.com/").as_deref(), Some("example.com"));
    }
}
