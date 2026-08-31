//! Platform adapters.
//!
//! THE CONTRACT: everything OS-specific terminates in this module. The rest of
//! the app talks to [`PlatformProbe`] and never learns which operating system it
//! is running on — the same discipline the Swift reference applies to its
//! `Companion` protocol, applied here to system access instead of drawing.
//!
//! This is the layer that cannot be made cross-platform by any framework.
//! Tauri gives us one UI and one build pipeline; it does not give us one way to
//! ask "what app is in front?", so we implement that twice and hide the seam.

use serde::{Deserialize, Serialize};

pub mod normalize;

#[cfg(windows)]
mod windows_probe;
#[cfg(windows)]
pub use windows_probe::WindowsProbe as NativeProbe;

#[cfg(target_os = "macos")]
mod macos_probe;
#[cfg(target_os = "macos")]
pub use macos_probe::MacProbe as NativeProbe;

// Anything that is neither Windows nor macOS still has to compile — tests and
// CI linters run on Linux — so it gets a probe that honestly reports nothing.
#[cfg(not(any(windows, target_os = "macos")))]
mod null_probe;
#[cfg(not(any(windows, target_os = "macos")))]
pub use null_probe::NullProbe as NativeProbe;

/// The app currently in the foreground.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForegroundApp {
    /// Display name, already normalised (see [`normalize`]).
    pub name: String,
    /// Raw executable or bundle identifier, kept for debugging and for future
    /// per-app rules. Never shown to the user as-is.
    pub raw: String,
    pub pid: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("no foreground window")]
    NoForegroundWindow,
    #[error("permission denied by the OS")]
    PermissionDenied,
    #[error("platform call failed: {0}")]
    Platform(String),
    #[error("not supported on this platform")]
    Unsupported,
}

/// What Loaf needs from the operating system.
///
/// Deliberately small. Every method returns `Result<Option<_>>` rather than a
/// bare value: "the OS refused" and "there is genuinely nothing in front right
/// now" are different states, and the tracker must not record a guess for
/// either. That mirrors the reference's "Not attributed" discipline — a guessed
/// value reads as data, and this is the one product that must not do that.
pub trait PlatformProbe: Send + Sync {
    /// The frontmost application, if one can be determined.
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ProbeError>;

    /// Seconds since the last user input, if the OS will tell us.
    ///
    /// Uses input timing only — never keystroke content. On both platforms this
    /// needs no Accessibility permission, which is why the reference could
    /// afford to notice idleness at all.
    fn idle_seconds(&self) -> Result<Option<f64>, ProbeError>;

    /// Short identifier for logs and the diagnostics panel.
    fn platform_name(&self) -> &'static str;
}

/// Construct the probe for whatever we were compiled for.
///
/// Written as the literal rather than `default()`: every probe is a unit struct
/// with nothing to initialise, and going through `Default` for one only reads
/// as though there were state here.
pub fn native() -> NativeProbe {
    NativeProbe
}

/// How hard the foreground process is working, as a percentage of one core.
///
/// Sampled twice around a short sleep, because the OS reports CPU TIME — a
/// counter — and what we want is a rate. Deliberately not normalised by core
/// count: a single-threaded build pinning one core of sixteen is "busy" in
/// every sense a person means it, and dividing by sixteen would report 6% and
/// call it idle.
///
/// `None` where it cannot be known, which the caller must treat as "no idea"
/// rather than "not busy" — the same discipline the rest of `platform` uses.
pub fn foreground_cpu() -> Option<f64> {
    cpu::foreground_cpu()
}

#[cfg(windows)]
mod cpu {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    /// 100-nanosecond units to seconds.
    fn seconds(t: FILETIME) -> f64 {
        let ticks = ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
        ticks as f64 / 10_000_000.0
    }

    /// Kernel + user time burned by a process so far.
    unsafe fn busy_seconds(pid: u32) -> Option<f64> {
        // QUERY_LIMITED_INFORMATION rather than QUERY_INFORMATION: it is the
        // least this needs, and it works against processes at a higher
        // integrity level, which QUERY_INFORMATION does not.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        Some(seconds(kernel) + seconds(user))
    }

    pub fn foreground_cpu() -> Option<f64> {
        unsafe {
            let hwnd = GetForegroundWindow();
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let first = busy_seconds(pid)?;
            let window = std::time::Duration::from_millis(240);
            std::thread::sleep(window);
            let second = busy_seconds(pid)?;
            // A process that exited between samples reports less time than it
            // had, not more. Report nothing rather than a negative percentage.
            if second < first {
                return None;
            }
            Some((second - first) / window.as_secs_f64() * 100.0)
        }
    }
}

#[cfg(target_os = "macos")]
mod cpu {
    /// Not built yet. Reports "no idea", which the caller already handles, so
    /// the Mac simply never shows the waiting pose rather than showing a wrong
    /// one. Wiring it up means `proc_pid_rusage` and a second sample, the same
    /// shape as the Windows side.
    pub fn foreground_cpu() -> Option<f64> {
        None
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod cpu {
    pub fn foreground_cpu() -> Option<f64> {
        None
    }
}
