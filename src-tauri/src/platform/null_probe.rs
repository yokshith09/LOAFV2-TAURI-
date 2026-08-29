//! Fallback probe for platforms we do not target.
//!
//! Exists so the crate still compiles on Linux, where CI runs `cargo test` and
//! `cargo clippy` for the OS-independent half of the codebase. It reports
//! nothing rather than pretending — the same rule the real probes follow.

use super::{ForegroundApp, PlatformProbe, ProbeError};

#[derive(Default)]
pub struct NullProbe;

impl PlatformProbe for NullProbe {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ProbeError> {
        Err(ProbeError::Unsupported)
    }

    fn idle_seconds(&self) -> Result<Option<f64>, ProbeError> {
        Err(ProbeError::Unsupported)
    }

    fn platform_name(&self) -> &'static str {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_honest_about_being_unsupported() {
        assert!(matches!(
            NullProbe.foreground_app(),
            Err(ProbeError::Unsupported)
        ));
        assert!(matches!(
            NullProbe.idle_seconds(),
            Err(ProbeError::Unsupported)
        ));
        assert_eq!(NullProbe.platform_name(), "unsupported");
    }
}
