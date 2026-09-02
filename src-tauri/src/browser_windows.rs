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
use windows::core::VARIANT;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_TabItemControlTypeId, UIA_ValuePatternId,
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
    use windows::core::{Interface, BSTR, VARIANT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        TreeScope_Children, TreeScope_Descendants, UIA_ButtonControlTypeId,
        UIA_ControlTypePropertyId, UIA_InvokePatternId, UIA_NamePropertyId,
        UIA_TabItemControlTypeId,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    struct Apartment(bool);

    impl Apartment {
        fn enter() -> Self {
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

    /// Executables whose windows have a tab strip worth listing.
    const BROWSERS: &[&str] = &[
        "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc", "chromium",
    ];

    /// Find a BROWSER window, not the foreground one.
    ///
    /// The foreground window is the wrong target here and it took running it to
    /// see why: the dashboard asking "what tabs are open" IS the foreground
    /// window at that moment, so it would list its own. The browser is found by
    /// executable instead, which also means the list still works while the user
    /// is reading it rather than only while they are in the browser.
    fn browser_window(automation: &IUIAutomation) -> Option<IUIAutomationElement> {
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
        };

        struct Hunt {
            found: Option<HWND>,
        }

        unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let hunt = unsafe { &mut *(lparam.0 as *mut Hunt) };
            if hunt.found.is_some() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
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
            let exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
            let stem = exe
                .rsplit('\\')
                .next()
                .unwrap_or(&exe)
                .trim_end_matches(".exe")
                .to_string();
            if BROWSERS.contains(&stem.as_str()) {
                hunt.found = Some(hwnd);
            }
            true.into()
        }

        let mut hunt = Hunt { found: None };
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut hunt as *mut Hunt as isize));
        }
        // Falls back to the foreground window, so this still does something
        // sensible on a machine whose browser is not on the list above.
        let hwnd = hunt
            .found
            .unwrap_or_else(|| unsafe { GetForegroundWindow() });
        if hwnd.0.is_null() {
            return None;
        }
        unsafe { automation.ElementFromHandle(hwnd).ok() }
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

    fn tabs(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Option<Vec<IUIAutomationElement>> {
        let condition = unsafe {
            automation
                .CreatePropertyCondition(
                    UIA_ControlTypePropertyId,
                    &VARIANT::from(UIA_TabItemControlTypeId.0),
                )
                .ok()?
        };
        let found = unsafe { root.FindAll(TreeScope_Descendants, &condition) }.ok()?;
        let length = unsafe { found.Length() }.ok()?;
        let mut out = Vec::new();
        for i in 0..length {
            if let Ok(element) = unsafe { found.GetElement(i) } {
                out.push(element);
            }
        }
        Some(out)
    }

    /// A browser tab has a close button; a tab-shaped control inside a web page
    /// does not.
    ///
    /// Without this, WhatsApp Web's own "All / Unread / Groups" filters came
    /// back as browser tabs, because they are TabItems too. Listing something
    /// Loaf cannot close is worse than not listing it — the button would be
    /// there and do nothing.
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

    pub fn list() -> Option<Vec<String>> {
        let _apartment = Apartment::enter();
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
        let root = browser_window(&automation)?;
        Some(
            tabs(&automation, &root)?
                .iter()
                .filter(|t| close_button(&automation, t).is_some())
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
        let Some(all) = tabs(&automation, &root) else {
            return Ok(false);
        };
        let Some(tab) = all
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
