//! Turning a recording into text, on this machine.
//!
//! HOW, AND WHY THIS WAY. Whisper runs as a separate program that Loaf hands a
//! WAV file to. The alternative — linking whisper.cpp into Loaf — was tried
//! first and rejected for two reasons, both worth writing down so nobody
//! rediscovers them:
//!
//!  1. `whisper-rs` needs libclang at BUILD time to generate bindings. That is
//!     a large toolchain install for every contributor, and it could not be
//!     built or tested on the machine this was written on.
//!  2. It would put a speech model inside Loaf's installer. A desktop pet that
//!     downloads hundreds of megabytes to be installed has stopped being one.
//!
//! Running it as a program keeps Loaf the same size it was, makes the model an
//! optional download rather than a bundled one, and means the user can point it
//! at whichever build and model they like.
//!
//! THE COST, SAID PLAINLY: it does not work until the user has fetched a
//! whisper.cpp build and a model. `availability` reports exactly which of those
//! is missing, so the answer is a reason rather than a silence — the same rule
//! the engine list follows everywhere else.
//!
//! NOTHING LEAVES THE MACHINE. The program is a local executable given a local
//! file. That is the whole difference between this and the hosted engine, and
//! it is why this one can be offered without changing what Loaf claims.

use std::path::{Path, PathBuf};

/// Where Loaf looks for a whisper build and a model.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct WhisperSetup {
    /// The whisper.cpp executable, e.g. `whisper-cli.exe`.
    pub binary: String,
    /// A ggml model file, e.g. `ggml-small.en-q5_1.bin`.
    pub model: String,
}

/// What is missing, or `None` when it is ready.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum Missing {
    Binary,
    Model,
    Both,
}

pub fn missing(setup: &WhisperSetup) -> Option<Missing> {
    let has_binary = !setup.binary.trim().is_empty() && Path::new(&setup.binary).is_file();
    let has_model = !setup.model.trim().is_empty() && Path::new(&setup.model).is_file();
    match (has_binary, has_model) {
        (true, true) => None,
        (false, true) => Some(Missing::Binary),
        (true, false) => Some(Missing::Model),
        (false, false) => Some(Missing::Both),
    }
}

/// A sentence fit to show someone, saying what to do about it.
pub fn missing_reason(what: &Missing) -> String {
    match what {
        Missing::Binary => "Whisper is not set up: the program is missing.".into(),
        Missing::Model => "Whisper is not set up: the model file is missing.".into(),
        Missing::Both => {
            "Whisper is not set up yet. It needs a whisper.cpp build and a model file.".into()
        }
    }
}

/// Strip whisper.cpp's decorations from a transcript.
///
/// The CLI prints timestamps like `[00:00:00.000 --> 00:00:04.000]` even with
/// most flags, plus blank lines and bracketed non-speech markers such as
/// `[BLANK_AUDIO]` and `(silence)`. None of that belongs in a note the user is
/// going to read, and `[BLANK_AUDIO]` in particular reads as if Loaf mistook
/// silence for words.
pub fn clean(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.lines() {
        let mut text = line.trim().to_string();
        // Drop a leading timestamp span if there is one.
        if let Some(end) = text.find(']') {
            if text.starts_with('[') && text[..end].contains("-->") {
                text = text[end + 1..].trim().to_string();
            }
        }
        if text.is_empty() {
            continue;
        }
        // Whole-line non-speech markers, in either bracket style.
        let lower = text.to_lowercase();
        let bracketed = (text.starts_with('[') && text.ends_with(']'))
            || (text.starts_with('(') && text.ends_with(')'));
        if bracketed
            && (lower.contains("blank")
                || lower.contains("silence")
                || lower.contains("inaudible")
                || lower.contains("music"))
        {
            continue;
        }
        lines.push(text);
    }
    lines
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Transcribe a WAV file. Blocking, and slow — minutes for a long meeting.
pub fn transcribe(setup: &WhisperSetup, wav: &Path) -> Result<String, String> {
    if let Some(what) = missing(setup) {
        return Err(missing_reason(&what));
    }
    if !wav.is_file() {
        return Err("There is no recording to transcribe.".into());
    }

    let output = std::process::Command::new(&setup.binary)
        .arg("-m")
        .arg(&setup.model)
        .arg("-f")
        .arg(wav)
        // No timestamps, and print to stdout rather than writing files beside
        // the recording. `clean` strips them anyway if a build ignores this.
        .arg("-nt")
        .output()
        .map_err(|e| format!("Whisper would not run: {e}"))?;

    if !output.status.success() {
        let why = String::from_utf8_lossy(&output.stderr);
        // The last line is usually the actual complaint; the rest is a banner.
        let last = why.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("Whisper failed. {last}"));
    }
    Ok(clean(&String::from_utf8_lossy(&output.stdout)))
}

/// Where a recording is kept while it is being transcribed.
///
/// The temp directory rather than beside the history: an unfinished recording
/// is working state, and a crash mid-meeting should not leave audio sitting in
/// the folder the user thinks holds only statistics.
pub fn scratch_wav() -> PathBuf {
    std::env::temp_dir().join(format!(
        "loaf-recording-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(binary: &str, model: &str) -> WhisperSetup {
        WhisperSetup {
            binary: binary.into(),
            model: model.into(),
        }
    }

    #[test]
    fn says_which_half_is_missing() {
        assert_eq!(missing(&setup("", "")), Some(Missing::Both));
        assert_eq!(
            missing(&setup("C:/nope/whisper.exe", "C:/nope/model.bin")),
            Some(Missing::Both)
        );
        // A real file for one half, nonsense for the other.
        let real = file!();
        assert_eq!(missing(&setup(real, "C:/nope")), Some(Missing::Model));
        assert_eq!(missing(&setup("C:/nope", real)), Some(Missing::Binary));
        assert_eq!(missing(&setup(real, real)), None);
    }

    #[test]
    fn every_reason_says_what_to_do() {
        for what in [Missing::Binary, Missing::Model, Missing::Both] {
            let reason = missing_reason(&what);
            assert!(reason.contains("Whisper"), "{reason}");
            assert!(reason.len() > 20, "{reason}");
        }
    }

    #[test]
    fn refuses_rather_than_running_when_unset() {
        let err = transcribe(&setup("", ""), Path::new("nope.wav")).unwrap_err();
        assert!(err.contains("not set up"), "{err}");
    }

    #[test]
    fn strips_timestamps() {
        let raw = "[00:00:00.000 --> 00:00:04.000]   Hello there.\n\
                   [00:00:04.000 --> 00:00:08.000]   This is a test.";
        assert_eq!(clean(raw), "Hello there. This is a test.");
    }

    // "[BLANK_AUDIO]" in a note reads as if Loaf mistook silence for words.
    #[test]
    fn drops_the_non_speech_markers() {
        assert_eq!(clean("[BLANK_AUDIO]"), "");
        assert_eq!(clean("(silence)"), "");
        assert_eq!(clean("[ Inaudible ]"), "");
        assert_eq!(clean("[MUSIC PLAYING]"), "");
        assert_eq!(
            clean("[BLANK_AUDIO]\nReal words.\n(silence)"),
            "Real words."
        );
    }

    #[test]
    fn keeps_ordinary_brackets_inside_a_sentence() {
        assert_eq!(
            clean("We agreed (mostly) to ship it."),
            "We agreed (mostly) to ship it."
        );
    }

    #[test]
    fn collapses_whitespace_and_blank_lines() {
        assert_eq!(clean("  one   two  \n\n\n  three "), "one two three");
        assert_eq!(clean(""), "");
        assert_eq!(clean("\n\n"), "");
    }

    #[test]
    fn keeps_recordings_out_of_the_history_folder() {
        let path = scratch_wav();
        assert!(path.starts_with(std::env::temp_dir()));
        assert!(path.extension().is_some_and(|e| e == "wav"));
    }
}
