//! Windows platform adapter.
//!
//! Foreground window via `GetForegroundWindow`, owning process via
//! `GetWindowThreadProcessId`, executable path via `QueryFullProcessImageNameW`,
//! idle via `GetLastInputInfo`. None of these require elevation, and none of
//! them require the Accessibility-style consent macOS asks for — which is why
//! this half of the tracker is cheap on Windows.
//!
//! What is NOT here, deliberately: reading browser tab URLs. That needs UI
//! Automation and carries a real privacy consequence (the full URL enters our
//! process before we truncate it, unlike the macOS AppleScript path where
//! truncation happens before the value crosses over). It is scoped as its own
//! piece of work with its own consent copy — see the direction document.

use super::normalize::{display_name, idle_seconds_from_ticks};
use super::{ForegroundApp, PlatformProbe, ProbeError};

use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

#[derive(Default)]
pub struct WindowsProbe;

impl PlatformProbe for WindowsProbe {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ProbeError> {
        // SAFETY: all calls below are simple FFI into documented Win32 APIs.
        // Every handle we open is closed on every path, including errors.
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                // Genuinely nothing focused — the lock screen, or a transition.
                // Not an error, and emphatically not something to guess about.
                return Ok(None);
            }

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return Ok(None);
            }

            let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => h,
                // A protected or elevated process we may not inspect. Report the
                // pid with no name rather than inventing one.
                Err(_) => {
                    return Ok(Some(ForegroundApp {
                        name: String::new(),
                        raw: String::new(),
                        pid,
                    }))
                }
            };

            let mut buf = [0u16; MAX_PATH as usize];
            let mut len = buf.len() as u32;
            let query = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            );

            // Close before branching on the result so no path can leak it.
            let _ = CloseHandle(handle);

            if query.is_err() || len == 0 {
                return Ok(Some(ForegroundApp {
                    name: String::new(),
                    raw: String::new(),
                    pid,
                }));
            }

            let raw = String::from_utf16_lossy(&buf[..len as usize]);
            Ok(Some(ForegroundApp {
                name: display_name(&raw),
                raw,
                pid,
            }))
        }
    }

    fn idle_seconds(&self) -> Result<Option<f64>, ProbeError> {
        unsafe {
            let mut info = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if GetLastInputInfo(&mut info).as_bool() {
                let now = windows::Win32::System::SystemInformation::GetTickCount();
                Ok(Some(idle_seconds_from_ticks(now, info.dwTime)))
            } else {
                Err(ProbeError::Platform("GetLastInputInfo failed".into()))
            }
        }
    }

    fn platform_name(&self) -> &'static str {
        "windows"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_its_platform() {
        assert_eq!(WindowsProbe.platform_name(), "windows");
    }

    #[test]
    fn foreground_app_never_panics() {
        // Whatever is focused on the CI runner, this must return, not explode.
        let r = WindowsProbe.foreground_app();
        assert!(r.is_ok(), "probe returned {r:?}");
    }

    #[test]
    fn idle_seconds_is_non_negative_when_available() {
        if let Ok(Some(secs)) = WindowsProbe.idle_seconds() {
            assert!(secs >= 0.0, "negative idle: {secs}");
            // A machine idle for more than a year means the tick maths is wrong.
            assert!(secs < 60.0 * 60.0 * 24.0 * 365.0, "absurd idle: {secs}");
        }
    }
}
