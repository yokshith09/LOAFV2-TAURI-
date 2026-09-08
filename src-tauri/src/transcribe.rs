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

/// Where Loaf looks for a model.
///
/// THERE IS NO `binary` FIELD ANY MORE, and its absence is the point. Loaf used
/// to download a whisper.cpp release and run `whisper-cli.exe` as a subprocess.
/// That worked on Windows and could never work on a Mac: upstream publishes
/// binaries for Windows and Ubuntu and an xcframework, and no macOS
/// command-line build at all. Meeting transcription — a headline feature — was
/// therefore quietly Windows-only, and the feature table said otherwise.
///
/// whisper.cpp is now compiled into Loaf. The engine cannot be missing, cannot
/// be a version we did not test against, and cannot be half-unzipped. Only the
/// model is still a download, because a 190 MB file in the installer would be
/// the whole installer.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct WhisperSetup {
    /// A ggml model file, e.g. `ggml-small.en-q5_1.bin`.
    pub model: String,
}

/// What is missing, or `None` when it is ready.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum Missing {
    Model,
}

pub fn missing(setup: &WhisperSetup) -> Option<Missing> {
    let has_model = !setup.model.trim().is_empty() && Path::new(&setup.model).is_file();
    if has_model {
        None
    } else {
        Some(Missing::Model)
    }
}

/// A sentence fit to show someone, saying what to do about it.
///
/// One case now, where there were three. The engine is compiled in, so the only
/// thing that can be absent is the model — and "download the model" is a
/// sentence somebody can act on, unlike "it needs a whisper.cpp build".
pub fn missing_reason(what: &Missing) -> String {
    match what {
        Missing::Model => {
            "Whisper needs its model before it can write anything down.              Download it from Settings."
                .into()
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

/// How many threads to hand Whisper.
///
/// Its own default is four regardless of the machine. Everything this program
/// does while it runs is wait for it, so there is nothing to leave headroom
/// for — one core is held back only so the desktop stays answerable while a
/// long meeting is transcribed.
fn threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(4)
}

/// Read a 16 kHz mono 16-bit WAV into the floats whisper wants.
///
/// `audio.rs` records in exactly that format precisely so nothing here has to
/// resample, and this function refuses anything else rather than quietly
/// producing a transcript of chipmunks. A wrong sample rate does not fail — it
/// transcribes wrong, which is much harder to notice.
fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("cannot read it: {e}"))?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 {
        return Err(format!(
            "That recording is {} channel(s) at {} Hz. Loaf records 1 channel at 16000 Hz.",
            spec.channels, spec.sample_rate
        ));
    }
    reader
        .samples::<i16>()
        .map(|s| s.map(|v| v as f32 / 32768.0).map_err(|e| e.to_string()))
        .collect()
}

/// Transcribe a WAV file. Blocking, and slow — minutes for a long meeting.
///
/// IN PROCESS NOW, not a subprocess. The model is loaded, used and dropped on
/// each call rather than kept: loading `small.en` costs about a second and
/// several hundred megabytes of resident memory, and a desktop pet that holds
/// that all day so a meeting once a fortnight starts a second sooner has its
/// priorities backwards.
pub fn transcribe(setup: &WhisperSetup, wav: &Path) -> Result<String, String> {
    if let Some(what) = missing(setup) {
        return Err(missing_reason(&what));
    }
    if !wav.is_file() {
        return Err("There is no recording to transcribe.".into());
    }
    let audio = read_wav(wav)?;
    transcribe_samples(setup, &audio)
}

/// Transcribe samples already in memory.
///
/// Separate from [`transcribe`] because the wake word and spoken commands have
/// the audio in hand already and writing it to a file so it can be read back is
/// pure latency in the one place latency is the feature.
pub fn transcribe_samples(setup: &WhisperSetup, audio: &[f32]) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    if let Some(what) = missing(setup) {
        return Err(missing_reason(&what));
    }
    // Under about a tenth of a second whisper has nothing to work with and
    // returns its own hallucinations rather than an empty string.
    if audio.len() < 1_600 {
        return Ok(String::new());
    }

    let ctx = WhisperContext::new_with_params(&setup.model, WhisperContextParameters::default())
        .map_err(|e| format!("Whisper could not load the model: {e}"))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Whisper could not start: {e}"))?;

    // Greedy rather than the default beam search. On the clip that was measured
    // this took a transcript from 33 seconds to well under ten with no change
    // to a word of the output. Beam search buys accuracy on hard audio; a
    // transcript nobody waits for buys nothing at all.
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // EVERY CORE BUT ONE, NOT FOUR. whisper defaults to four threads whatever
    // the machine has, which on a sixteen-thread laptop left three quarters of
    // it idle and turned 5.7 seconds of speech into 83 seconds of waiting —
    // measured, not guessed.
    params.set_n_threads(threads() as i32);
    params.set_language(Some("en"));
    params.set_translate(false);
    // Nothing is printed. This is a library call inside a desktop app now, and
    // whisper.cpp writes a banner and a running transcript to stderr by default.
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_timestamps(true);

    state
        .full(params, audio)
        .map_err(|e| format!("Whisper failed: {e}"))?;

    let mut out = String::new();
    for segment in state.as_iter() {
        // Lossy: a model can emit a byte sequence that is not valid text, and
        // losing one character is better than losing the whole meeting.
        if let Ok(text) = segment.to_str_lossy() {
            out.push_str(&text);
        }
    }
    Ok(clean(&out))
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

    fn setup(model: &str) -> WhisperSetup {
        WhisperSetup {
            model: model.into(),
        }
    }

    // ONE THING CAN BE MISSING NOW, where there were three. The engine is
    // compiled in, so it cannot be absent, cannot be the wrong version, and
    // cannot be half-unzipped.
    #[test]
    fn a_missing_model_is_the_only_way_to_be_unready() {
        assert_eq!(missing(&setup("")), Some(Missing::Model));
        assert_eq!(missing(&setup("   ")), Some(Missing::Model));
        assert_eq!(missing(&setup("C:/nope/model.bin")), Some(Missing::Model));
        // A real file — this source file will do — reads as ready.
        assert_eq!(missing(&setup(file!())), None);
    }

    #[test]
    fn the_reason_says_what_to_do_about_it() {
        let reason = missing_reason(&Missing::Model);
        assert!(reason.contains("model"), "{reason}");
        assert!(reason.contains("Download"), "{reason}");
    }

    #[test]
    fn refuses_rather_than_running_when_unset() {
        let err = transcribe(&setup(""), Path::new("nope.wav")).unwrap_err();
        assert!(err.contains("model"), "{err}");
    }

    #[test]
    fn a_missing_recording_is_said_plainly() {
        let err = transcribe(&setup(file!()), Path::new("nope.wav")).unwrap_err();
        assert!(err.contains("no recording"), "{err}");
    }

    // Under a tenth of a second, whisper returns its own hallucinations rather
    // than an empty string — so it is never asked.
    #[test]
    fn a_snippet_too_short_to_hear_returns_nothing() {
        let out = transcribe_samples(&setup(file!()), &[0.0; 100]).unwrap();
        assert_eq!(out, "");
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
