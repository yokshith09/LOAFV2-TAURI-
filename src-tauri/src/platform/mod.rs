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
pub fn native() -> NativeProbe {
    NativeProbe::default()
}
