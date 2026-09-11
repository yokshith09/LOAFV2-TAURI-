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
use windows::core::{BSTR, VARIANT};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
    TreeScope_Children, TreeScope_Descendants, UIA_ButtonControlTypeId, UIA_ControlTypePropertyId,
    UIA_EditControlTypeId, UIA_NamePropertyId, UIA_TabItemControlTypeId, UIA_ValuePatternId,
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

/// Every visible top-level window, paired with the lowercased stem of the
/// executable that owns it (`"chrome"`, `"firefox"`).
///
/// One walk answering two separate questions — which browsers are running, and
/// which windows belong to a given one. Those used to be two code paths that
/// agreed only by accident, and the cost was a browser Loaf could count but
/// never find.
fn visible_windows() -> Vec<(HWND, String)> {
    use windows::Win32::Foundation::{BOOL, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let found = unsafe { &mut *(lparam.0 as *mut Vec<(HWND, String)>) };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return true.into();
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return true.into();
        }
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
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
        let exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        let stem = exe
            .rsplit('\\')
            .next()
            .unwrap_or(&exe)
            .trim_end_matches(".exe")
            .to_string();
        found.push((hwnd, stem));
        true.into()
    }

    let mut found: Vec<(HWND, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(visit),
            LPARAM(&mut found as *mut Vec<(HWND, String)> as isize),
        );
    }
    found
}

/// Strip a trailing `.exe` and lowercase, so `"Chrome.exe"` and `"chrome"` are
/// the same thing to every caller.
fn stem_of(exe: &str) -> String {
    exe.trim()
        .to_lowercase()
        .trim_end_matches(".exe")
        .to_string()
}

/// Which of `candidates` have a visible window right now.
///
/// Takes the list rather than holding one: the frontend already knows every
/// browser Loaf recognises, and a second copy here would be a second thing to
/// keep in step — which is exactly how Firefox ended up listed in one place and
/// not the other.
pub fn running(candidates: &[String]) -> Vec<String> {
    let live: std::collections::HashSet<String> = visible_windows()
        .into_iter()
        .map(|(_, stem)| stem)
        .collect();
    candidates
        .iter()
        .filter(|c| live.contains(&stem_of(c)))
        .cloned()
        .collect()
}

/// Count one browser's tabs across ALL of its windows, and read the address bar
/// only if that browser is the one in front.
///
/// Two deliberate properties:
///
/// 1. **Every window, not the foreground one.** A second Chrome window used to
///    be invisible, and a browser you were not currently looking at was never
///    counted at all — so "how many tabs are open" answered for one window of
///    one browser and called it the total.
/// 2. **The domain still comes from the front window only.** Counting is
///    harmless across background browsers; reading their address bars would
///    widen what Loaf sees for no benefit. So a background browser contributes
///    a number and nothing else.
pub fn probe(exe: &str) -> ProbeOutcome {
    let _apartment = Apartment::enter();
    let stem = stem_of(exe);

    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(_) => {
                return ProbeOutcome::Unavailable {
                    why: "UI Automation is unavailable".into(),
                }
            }
        };

    let foreground = unsafe { GetForegroundWindow() };
    let mut tab_count = 0u32;
    let mut windows_seen = 0usize;
    let mut front_root = None;

    for (hwnd, owner) in visible_windows() {
        if owner != stem {
            continue;
        }
        let Ok(root) = (unsafe { automation.ElementFromHandle(hwnd) }) else {
            continue;
        };
        tab_count += real_tabs(&automation, &root).len() as u32;
        windows_seen += 1;
        if hwnd == foreground {
            front_root = Some(root);
        }
    }

    if windows_seen == 0 {
        return ProbeOutcome::Unavailable {
            why: "has no window open".into(),
        };
    }

    // Not in front: the count is honest, and that is all this is entitled to.
    let Some(root) = front_root else {
        return ProbeOutcome::Reading {
            domain: None,
            tab_count,
        };
    };

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

/// Every control in this window that calls itself a tab.
///
/// Includes plenty that are not browser tabs — see `real_tabs`.
fn tab_items(
    automation: &IUIAutomation,
    root: &IUIAutomationElement,
) -> Option<Vec<IUIAutomationElement>> {
    unsafe {
        let condition = automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_TabItemControlTypeId.0),
            )
            .ok()?;
        let found = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let length = found.Length().ok()?;
        let mut out = Vec::new();
        for i in 0..length {
            if let Ok(element) = found.GetElement(i) {
                out.push(element);
            }
        }
        Some(out)
    }
}

/// A browser tab has a close button; a tab-shaped control inside a web page
/// does not.
///
/// Without this, WhatsApp Web's own "All / Unread / Groups" filters came back as
/// browser tabs, because they are TabItems too — and so do the panel tabs of an
/// open DevTools ("Elements", "Console", "Sources"). Counting those inflated the
/// number, which matters more now that the counts of several browsers are added
/// together: three browsers with DevTools open used to be able to invent twenty
/// tabs between them.
fn close_button(
    automation: &IUIAutomation,
    tab: &IUIAutomationElement,
) -> Option<IUIAutomationElement> {
    let condition = unsafe {
        automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_ButtonControlTypeId.0),
            )
            .ok()?
    };
    let found = unsafe { tab.FindAll(TreeScope_Children, &condition) }.ok()?;
    let count = unsafe { found.Length() }.ok()?;
    for i in 0..count {
        let Ok(button) = (unsafe { found.GetElement(i) }) else {
            continue;
        };
        if name_of(&button)
            .unwrap_or_default()
            .to_lowercase()
            .contains("close")
        {
            return Some(button);
        }
    }
    None
}

/// The tabs in this window that are actually browser tabs.
///
/// ponytail: one accessibility call per candidate tab, so a hundred tabs is a
/// hundred small cross-process calls. Fine at one poll every few seconds; if it
/// ever shows up in a profile the fix is a UIA cache request over the tab strip
/// rather than a per-tab lookup.
fn real_tabs(automation: &IUIAutomation, root: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
    tab_items(automation, root)
        .unwrap_or_default()
        .into_iter()
        .filter(|t| close_button(automation, t).is_some())
        .collect()
}

fn name_of(element: &IUIAutomationElement) -> Option<String> {
    let value = unsafe { element.GetCurrentPropertyValue(UIA_NamePropertyId) }.ok()?;
    let text = BSTR::try_from(&value).ok()?.to_string();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The title of every open tab in the front browser window.
///
/// TAB TITLES, NOT PAGE CONTENT. A tab's accessible Name is what the browser
/// itself writes on the tab strip — the same string you can read by looking at
/// the screen. Nothing here opens, reads or scripts a page, and the URL is not
/// collected: the radar records the address bar of the ACTIVE tab only, and
/// this does not extend that.
///
/// Empty when the front window is not a browser, which is a real answer rather
/// than an error.
pub fn list_tabs() -> Vec<String> {
    imp_tabs::list().unwrap_or_default()
}

/// Close one tab by its exact title. False means it was not found.
///
/// Closes it the way you would: by pressing the tab's own close button through
/// UI Automation. NOT by sending Ctrl+W, which closes whatever happens to be in
/// front and would lose the wrong thing if the user changed tabs between asking
/// and Loaf acting.
pub fn close_tab(title: &str) -> Result<bool, String> {
    imp_tabs::close(title)
}

#[cfg(windows)]
mod imp_tabs {
    use super::{close_button, name_of, real_tabs, stem_of, visible_windows, Apartment};
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        UIA_InvokePatternId,
    };

    /// Executables whose windows have a tab strip worth listing.
    ///
    /// Only a fallback ordering now: `list`/`close` act on a browser rather than
    /// on whatever is in front, because the dashboard asking "what tabs are
    /// open" IS the foreground window at that moment and would otherwise list
    /// its own.
    const BROWSERS: &[&str] = &[
        "chrome",
        "msedge",
        "firefox",
        "brave",
        "opera",
        "opera_gx",
        "vivaldi",
        "arc",
        "chromium",
        "chrome_beta",
        "chrome_canary",
    ];

    /// The first browser window found, for the tab list and the close button.
    fn browser_window(automation: &IUIAutomation) -> Option<IUIAutomationElement> {
        let hwnd = visible_windows()
            .into_iter()
            .find(|(_, stem)| BROWSERS.contains(&stem_of(stem).as_str()))
            .map(|(hwnd, _)| hwnd)?;
        unsafe { automation.ElementFromHandle(hwnd).ok() }
    }

    pub fn list() -> Option<Vec<String>> {
        let _apartment = Apartment::enter();
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
        let root = browser_window(&automation)?;
        Some(
            real_tabs(&automation, &root)
                .iter()
                .filter_map(name_of)
                .collect(),
        )
    }

    pub fn close(title: &str) -> Result<bool, String> {
        let _apartment = Apartment::enter();
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| e.to_string())?;
        let Some(root) = browser_window(&automation) else {
            return Ok(false);
        };
        let Some(tab) = real_tabs(&automation, &root)
            .into_iter()
            .find(|t| name_of(t).as_deref() == Some(title))
        else {
            return Ok(false);
        };

        // The close button is a child of THIS tab. Found under the tab rather
        // than searched for in the window, which is what makes this close the
        // tab the user picked instead of whichever one is in front.
        let Some(button) = close_button(&automation, &tab) else {
            // Reported honestly rather than falling back to Ctrl+W, which would
            // close a different tab.
            return Err("That tab has no close button Loaf can press.".into());
        };
        let pattern =
            unsafe { button.GetCurrentPattern(UIA_InvokePatternId) }.map_err(|e| e.to_string())?;
        let invoker: IUIAutomationInvokePattern = pattern.cast().map_err(|e| e.to_string())?;
        unsafe { invoker.Invoke() }.map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[cfg(not(windows))]
mod imp_tabs {
    pub fn list() -> Option<Vec<String>> {
        None
    }
    pub fn close(_title: &str) -> Result<bool, String> {
        Err("Closing tabs is Windows-only for now.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::host_of;

    /// Which browsers are open, and how many tabs each one really has.
    ///
    /// Ignored because it needs real browsers, which a CI runner has none of.
    /// The check this exists for: open two or three browsers, then
    ///
    ///     cargo test -- --ignored --nocapture every_browser_not_just_the_front_one
    ///
    /// and confirm that each one is listed with a plausible count. A single
    /// browser in the output, or a zero beside one that plainly has tabs, is the
    /// bug this was written to catch coming back.
    #[test]
    #[ignore]
    fn every_browser_not_just_the_front_one() {
        let candidates: Vec<String> = [
            "chrome.exe",
            "msedge.exe",
            "firefox.exe",
            "brave.exe",
            "vivaldi.exe",
            "opera.exe",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();

        let open = super::running(&candidates);
        println!("running browsers: {open:?}");
        assert!(
            !open.is_empty(),
            "no browser found running — open one and try again"
        );

        let mut total = 0u32;
        for exe in &open {
            match super::probe(exe) {
                crate::browser::ProbeOutcome::Reading { domain, tab_count } => {
                    println!("  {exe}: {tab_count} tabs, domain {domain:?}");
                    total += tab_count;
                }
                other => println!("  {exe}: {other:?}"),
            }
        }
        println!("total across every browser: {total}");
    }

    /// What tabs are open in whatever is in front right now.
    ///
    /// Ignored: it depends on a browser being the foreground window, which a
    /// CI runner does not have. Bring a browser to the front, then:
    ///
    ///     cargo test -- --ignored --nocapture what_tabs_are_open
    #[test]
    #[ignore]
    fn what_tabs_are_open() {
        let tabs = super::list_tabs();
        println!("{} tabs in the front window", tabs.len());
        for t in tabs.iter().take(15) {
            println!("  - {t}");
        }
    }

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
        assert_eq!(
            host_of("https://www.example.com/").as_deref(),
            Some("example.com")
        );
    }
}
