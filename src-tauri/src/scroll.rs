//! How long since the last scroll, for the scrolling pose.
//!
//! WHAT THIS IS NOT. It is not a hook, it does not intercept anything, and it
//! cannot see what you scrolled. Both platforms answer exactly one question —
//! "how many seconds since the wheel last moved" — and nothing else about the
//! event is read, kept, or reachable. That distinction is the whole reason the
//! feature is acceptable in an app whose pitch is that it does not watch you.
//!
//! macOS asks the window server, through the same permission-free call the
//! tracker already uses for idle time; the reference calls this exact API for
//! this exact purpose and notes that it needs no permission.
//!
//! Windows has no equivalent, so it listens for Raw Input on a message-only
//! window. Raw Input RECEIVES copies of events; a `WH_MOUSE_LL` hook would sit
//! in the delivery path of every mouse event on the machine, which is both
//! slower and the thing antivirus software objects to. Only the wheel flag is
//! looked at — the movement deltas that arrive in the same struct are ignored.

/// Seconds since the wheel last moved, or `None` where that cannot be known.
pub fn seconds_since_scroll() -> Option<f64> {
    imp::seconds_since_scroll()
}

/// Seconds since a key was last pressed, or `None` where that cannot be known.
///
/// THE SAME PROMISE AS ABOVE, and it matters more here. This reports only HOW
/// LONG AGO a key went down. Not which key, not how many, not what was typed —
/// none of that is read, kept, or reachable. On macOS the call is literally
/// incapable of returning a key code; on Windows the raw input struct that
/// carries one is never looked at.
pub fn seconds_since_typing() -> Option<f64> {
    imp::seconds_since_typing()
}

/// Start whatever needs to be running. A no-op on macOS, which polls.
pub fn start() {
    imp::start();
}

#[cfg(target_os = "macos")]
mod imp {
    /// `kCGEventSourceStateCombinedSessionState`.
    const COMBINED_SESSION_STATE: u32 = 0;
    /// `kCGEventScrollWheel`.
    const SCROLL_WHEEL: u32 = 22;
    /// `kCGEventKeyDown`. Timing only — this API cannot report WHICH key.
    const KEY_DOWN: u32 = 10;

    // Declared directly rather than pulling in a Core Graphics crate: this is
    // one function, and a dependency added for one function is a dependency
    // that has to be kept current for one function.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: u32, event_type: u32) -> f64;
    }

    pub fn start() {}

    pub fn seconds_since_typing() -> Option<f64> {
        let seconds =
            unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, KEY_DOWN) };
        if seconds.is_finite() && seconds >= 0.0 {
            Some(seconds)
        } else {
            None
        }
    }

    pub fn seconds_since_scroll() -> Option<f64> {
        let seconds =
            unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, SCROLL_WHEEL) };
        // A machine that has never scrolled reports something enormous rather
        // than an error, which is the same as "not recently" for our purposes.
        if seconds.is_finite() && seconds >= 0.0 {
            Some(seconds)
        } else {
            None
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Once;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Input::{
        GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
        RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, HMENU, HWND_MESSAGE, MSG, RI_MOUSE_WHEEL, WINDOW_EX_STYLE, WINDOW_STYLE,
        WM_INPUT, WM_KEYDOWN, WM_SYSKEYDOWN, WNDCLASSW,
    };

    /// Tick count at the last wheel movement. 0 means "never seen one".
    static LAST_SCROLL_TICKS: AtomicU64 = AtomicU64::new(0);
    /// Tick count at the last key press. 0 means "never seen one".
    static LAST_KEY_TICKS: AtomicU64 = AtomicU64::new(0);
    static START: Once = Once::new();

    pub fn start() {
        START.call_once(|| {
            // Its own thread with its own message loop, rather than hooking
            // Tauri's window procedure. Nothing here can slow down or interfere
            // with the app's own event handling.
            std::thread::Builder::new()
                .name("loaf-scroll".into())
                .spawn(|| unsafe { listen() })
                .ok();
        });
    }

    pub fn seconds_since_scroll() -> Option<f64> {
        since(&LAST_SCROLL_TICKS)
    }

    pub fn seconds_since_typing() -> Option<f64> {
        since(&LAST_KEY_TICKS)
    }

    fn since(clock: &AtomicU64) -> Option<f64> {
        let last = clock.load(Ordering::Relaxed);
        if last == 0 {
            return None;
        }
        let now = unsafe { GetTickCount64() };
        Some((now.saturating_sub(last)) as f64 / 1000.0)
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_INPUT {
            let mut raw = RAWINPUT::default();
            let mut size = std::mem::size_of::<RAWINPUT>() as u32;
            let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
            let read = GetRawInputData(
                HRAWINPUT(lparam.0 as *mut core::ffi::c_void),
                RID_INPUT,
                Some(&mut raw as *mut _ as *mut core::ffi::c_void),
                &mut size,
                header,
            );
            if read != u32::MAX {
                match raw.header.dwType {
                    // ONLY the wheel flag. The same struct carries movement
                    // deltas and button state; neither is read, and neither is
                    // anybody's business here.
                    t if t == RIM_TYPEMOUSE.0 => {
                        let flags = raw.data.mouse.Anonymous.Anonymous.usButtonFlags as u32;
                        if flags & RI_MOUSE_WHEEL != 0 {
                            LAST_SCROLL_TICKS.store(GetTickCount64(), Ordering::Relaxed);
                        }
                    }
                    // ONLY that a key went down, and WHEN. `raw.data.keyboard`
                    // carries VKey, MakeCode and Message right here, one field
                    // away — none of them is read. That restraint is the entire
                    // difference between a pose and a keylogger, so it is worth
                    // stating where the temptation actually is.
                    t if t == RIM_TYPEKEYBOARD.0 => {
                        let message = raw.data.keyboard.Message;
                        if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                            LAST_KEY_TICKS.store(GetTickCount64(), Ordering::Relaxed);
                        }
                    }
                    _ => {}
                }
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe fn listen() {
        let Ok(instance) = GetModuleHandleW(PCWSTR::null()) else {
            return;
        };
        let class_name = w!("LoafScrollWatcher");
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return;
        }

        // HWND_MESSAGE: a message-only window. It is never shown, never appears
        // in the taskbar, and exists purely to receive WM_INPUT.
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            HMENU::default(),
            instance,
            None,
        ) else {
            return;
        };

        // Usage page 1, usage 2 is the generic desktop mouse. INPUTSINK is what
        // lets this see the wheel while another application is in front —
        // without it the pose would only work while you were scrolling Loaf.
        // Usage 2 is the mouse, usage 6 the keyboard. INPUTSINK is what lets
        // these be seen while another application is in front — without it the
        // poses would only work while you were typing at Loaf itself.
        let devices = [
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x02,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            },
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x06,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            },
        ];
        if RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32).is_err()
        {
            return;
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn start() {}
    pub fn seconds_since_scroll() -> Option<f64> {
        None
    }
    pub fn seconds_since_typing() -> Option<f64> {
        None
    }
}
