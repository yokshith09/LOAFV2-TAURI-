//! macOS platform adapter.
//!
//! Deliberately shells out to `osascript` / `ioreg` in a **killable subprocess**
//! rather than linking Objective-C and calling NSAppleScript in-process.
//!
//! That is not laziness — it is the lesson the Swift reference records in
//! HANDOFF.md: an in-process AppleScript call against a hung application takes
//! the whole UI down with it. A subprocess we can time out and kill cannot. It
//! also keeps the dependency surface at zero extra crates for this platform,
//! which matters for a product whose pitch is auditability.

use super::normalize::display_name;
use super::{ForegroundApp, PlatformProbe, ProbeError};

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Anything slower than this is a hung app, not a slow one.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Default)]
pub struct MacProbe;

/// Run a command, killing it if it outstays `PROBE_TIMEOUT`.
///
/// Returns `Ok(None)` on timeout rather than an error: a hung frontmost app is
/// a normal condition on a busy Mac, and the correct response is to record
/// nothing for this tick, not to surface a failure to the user.
fn run_with_timeout(program: &str, args: &[&str]) -> Result<Option<String>, ProbeError> {
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ProbeError::Platform(format!("spawn {program}: {e}")))?;

    // `wait_with_output` consumes the child, so hand it to a worker thread and
    // keep only the ability to time out here.
    let id = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let out = child.wait_with_output();
        // A send failure just means we already timed out and stopped listening.
        let _ = tx.send(out);
    });

    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(Ok(out)) => {
            if !out.status.success() {
                // Most often: the user declined the Automation prompt.
                return Err(ProbeError::PermissionDenied);
            }
            Ok(Some(
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            ))
        }
        Ok(Err(e)) => Err(ProbeError::Platform(format!("{program}: {e}"))),
        Err(_) => {
            // Timed out. Make sure we do not leave the process behind.
            let _ = Command::new("kill").arg("-9").arg(id.to_string()).status();
            Ok(None)
        }
    }
}

impl PlatformProbe for MacProbe {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ProbeError> {
        // Ask for the name only. We do not ask for windows, titles, or
        // documents — the tracker has no business knowing what you have open,
        // only which app it is.
        // Name and unix id in ONE script. Still no windows, titles or documents
        // — the tracker has no business knowing what you have open, only which
        // app it is. The pid is asked for here rather than in a second script
        // because `osascript` costs a subprocess, and the CPU probe needs a pid
        // it can sample twice without paying that twice.
        // `linefeed` rather than an escape sequence: AppleScript has no `\n`,
        // and a string literal cannot span lines there any more than it can in
        // Rust. Both mistakes were in this line at once, and neither could be
        // caught on Windows — this file is `cfg(target_os = "macos")`, so it is
        // not compiled here and only `cargo fmt` noticed it would not parse.
        const SCRIPT: &str = r#"tell application "System Events" to tell (first application process whose frontmost is true) to return name & linefeed & (unix id as text)"#;

        let Some(out) = run_with_timeout("/usr/bin/osascript", &["-e", SCRIPT])? else {
            return Ok(None);
        };
        let mut lines = out.splitn(2, '\n');
        let name = lines.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            return Ok(None);
        }
        let pid: u32 = lines.next().unwrap_or("").trim().parse().unwrap_or(0);

        // Remembered for the CPU probe, which runs on its own schedule and must
        // not spawn a second osascript to ask the same question.
        super::cpu::note_frontmost(pid);

        Ok(Some(ForegroundApp {
            name: display_name(&name),
            raw: name,
            // Zero still means "not collected", not "process 0" — the parse
            // above falls back to it rather than guessing.
            pid,
        }))
    }

    fn idle_seconds(&self) -> Result<Option<f64>, ProbeError> {
        // HIDIdleTime is in nanoseconds and needs no special permission.
        let Some(out) = run_with_timeout(
            "/bin/sh",
            &[
                "-c",
                "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'",
            ],
        )?
        else {
            return Ok(None);
        };

        parse_hid_idle_nanos(&out).map(Some).ok_or_else(|| {
            ProbeError::Platform(format!("could not parse HIDIdleTime from {out:?}"))
        })
    }

    fn platform_name(&self) -> &'static str {
        "macos"
    }
}

/// Nanoseconds -> seconds, tolerating the surrounding noise `ioreg` emits.
/// Split out so it can be tested on any platform.
pub fn parse_hid_idle_nanos(raw: &str) -> Option<f64> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits
        .parse::<u64>()
        .ok()
        .map(|n| n as f64 / 1_000_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_its_platform() {
        assert_eq!(MacProbe.platform_name(), "macos");
    }

    #[test]
    fn parses_plain_nanoseconds() {
        let secs = parse_hid_idle_nanos("5000000000").unwrap();
        assert!((secs - 5.0).abs() < 1e-9);
    }

    #[test]
    fn parses_ioreg_noise_around_the_number() {
        let secs = parse_hid_idle_nanos("  \"HIDIdleTime\" = 2500000000\n").unwrap();
        assert!((secs - 2.5).abs() < 1e-6);
    }

    #[test]
    fn rejects_empty_and_non_numeric() {
        assert!(parse_hid_idle_nanos("").is_none());
        assert!(parse_hid_idle_nanos("no digits here").is_none());
    }

    #[test]
    fn zero_idle_is_valid_not_none() {
        assert_eq!(parse_hid_idle_nanos("0"), Some(0.0));
    }

    #[test]
    fn foreground_app_never_panics() {
        let r = MacProbe.foreground_app();
        // On a CI runner without Automation consent this is PermissionDenied,
        // which is a legitimate outcome — it just must not panic or hang.
        assert!(r.is_ok() || matches!(r, Err(ProbeError::PermissionDenied)));
    }
}
