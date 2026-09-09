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
    // An override, so the number can be MEASURED rather than argued about.
    // The comment this replaced asserted "every core but one" was right
    // because a four-thread default had once been wrong, which is not the same
    // as fifteen being right.
    if let Ok(n) = std::env::var("LOAF_WHISPER_THREADS") {
        if let Ok(n) = n.parse::<usize>() {
            if n >= 1 {
                return n;
            }
        }
    }
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(4)
}

/// How much of whisper's thirty-second window this many samples actually need.
///
/// 1500 encoder frames cover thirty seconds, so a second costs 50. Anything
/// longer than the window gets the whole thing; anything shorter gets its own
/// length plus two seconds of headroom, because a word ending exactly on the
/// boundary is a word whisper does not finish.
///
/// The floor is deliberate. Below about four seconds of context the model
/// starts inventing, and the saving between a 200-frame context and a
/// 400-frame one is not worth finding that out in a user's transcript.
fn audio_ctx(samples: usize) -> i32 {
    const FULL: i32 = 1500;
    const FRAMES_PER_SECOND: i32 = 50;
    const HEADROOM_SECONDS: i32 = 2;
    const FLOOR: i32 = 400;

    // Counted in usize and clamped BEFORE the cast. `samples as i32` truncates,
    // and a truncated large number can come out negative and land on the floor
    // — the smallest possible window for the longest possible recording, which
    // is the exact opposite of what this function is for. No real recording is
    // anywhere near that big; the test that found it is not.
    let seconds = samples / 16_000;
    let needed = seconds.saturating_add(HEADROOM_SECONDS as usize) * FRAMES_PER_SECOND as usize;
    needed.clamp(FLOOR as usize, FULL as usize) as i32
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
    // ONLY ENCODE AS MUCH AUDIO AS THERE IS.
    //
    // This is the whole reason dictation felt broken. Whisper's encoder always
    // runs over a THIRTY SECOND window: hand it a four second sentence and it
    // pads the other twenty-six with silence and encodes that too, at full
    // price. Measured on this machine, a 4.4 second clip took 45 seconds —
    // and so would a 29 second one.
    //
    // `audio_ctx` shortens the encoder input to match. 1500 frames is the full
    // thirty seconds, so 50 frames buys a second. The headroom matters: cut it
    // exactly to length and the last word lands on the boundary and is dropped.
    //
    // Kept generous rather than minimal. This is a speed knob that can silently
    // cost accuracy, and a transcript that is fast and wrong is worse than one
    // that is slow and right — which is the failure this whole file has already
    // had once, with a fixed loudness threshold.
    params.set_audio_ctx(audio_ctx(audio.len()));
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

#[cfg(test)]
mod window {
    use super::audio_ctx;

    const SECOND: usize = 16_000;

    #[test]
    fn a_short_sentence_does_not_pay_for_thirty_seconds() {
        // The measured case: 4.4s of speech took 45s at the full window and
        // 11.7s at this one, with an identical transcript.
        assert!(audio_ctx(4 * SECOND) < 1500);
    }

    #[test]
    fn a_long_recording_still_gets_the_whole_window() {
        // Meetings must be untouched by this. Anything at or past the window
        // gets all of it, so the only thing that changed is short clips.
        assert_eq!(audio_ctx(30 * SECOND), 1500);
        assert_eq!(audio_ctx(120 * SECOND), 1500);
    }

    #[test]
    fn there_is_headroom_so_the_last_word_is_not_cut_off() {
        // Ten seconds of audio needs 500 frames; it must ask for more.
        assert!(audio_ctx(10 * SECOND) > 10 * 50);
    }

    #[test]
    fn never_below_the_floor_however_short_the_clip() {
        assert_eq!(audio_ctx(0), 400);
        assert_eq!(audio_ctx(SECOND / 2), 400);
    }

    #[test]
    fn never_above_the_window_however_long_the_clip() {
        assert_eq!(audio_ctx(usize::MAX / 2), 1500);
    }

    #[test]
    fn grows_with_the_audio() {
        assert!(audio_ctx(20 * SECOND) > audio_ctx(10 * SECOND));
    }
}

#[cfg(test)]
mod probe {
    //! The end-to-end check that needs no microphone.
    //!
    //! "Dictation is not working" was reported three times and could not be
    //! answered, because every test in this crate stops at the edge of
    //! whisper.cpp: they check that a missing model is refused and that the
    //! output is tidied, and none of them ever transcribes anything. So a
    //! Whisper path that was completely broken would have passed all of them.
    //!
    //! This one runs the real model over real speech. The speech is synthesised
    //! rather than recorded, so it needs nobody to say anything and it produces
    //! the same words every run. It is `#[ignore]`d because it needs the 190 MB
    //! model that CI does not download:
    //!
    //!     cargo test --release -- --ignored --nocapture whisper_hears
    //!
    //! with LOAF_PROBE_WAV and LOAF_PROBE_MODEL set.

    #[test]
    #[ignore = "needs the downloaded model and a wav; see the module note"]
    fn whisper_hears_synthesised_speech() {
        let wav = std::env::var("LOAF_PROBE_WAV").expect("set LOAF_PROBE_WAV");
        let model = std::env::var("LOAF_PROBE_MODEL").expect("set LOAF_PROBE_MODEL");
        let setup = super::WhisperSetup { model };
        assert!(
            super::missing(&setup).is_none(),
            "the model is not where the test was told it is"
        );

        let started = std::time::Instant::now();
        let text = super::transcribe(&setup, std::path::Path::new(&wav))
            .expect("whisper refused to transcribe");
        let took = started.elapsed();

        println!("heard: {text:?}");
        println!("took: {:.1}s", took.as_secs_f32());

        let lower = text.to_lowercase();
        // Not an exact match: a transcriber is allowed to differ on
        // punctuation and casing, and asserting the whole sentence would make
        // this a test of the synthesiser's diction. These are the words that
        // prove it heard the actual audio rather than returning something.
        for word in ["notepad", "meeting", "thursday"] {
            assert!(lower.contains(word), "expected {word:?} in {text:?}");
        }
    }
}
