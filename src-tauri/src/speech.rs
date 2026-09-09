//! Turning one held-down moment of speech into a string, on this machine only.
//!
//! WHAT THIS IS AND IS NOT. It listens ONCE, when you ask it to, and returns
//! what it heard. There is no wake word, no continuous listening, and no way
//! for this module to run without a deliberate call — which is the difference
//! between a push-to-talk button and a microphone that is simply on. Nothing is
//! recorded and nothing is written to disk.
//!
//! THE PART THAT MATTERS. Windows offers two recognisers behind one API and
//! only one of them is local:
//!
//!  - `CompileConstraintsAsync` with NO constraints added compiles the built-in
//!    dictation grammar. That understands free speech, requires the user to
//!    switch on "Online speech recognition" in Windows privacy settings, and
//!    sends audio to Microsoft's servers. Free-form and cloud are the same
//!    choice; there is no setting that separates them.
//!
//!  - A `SpeechRecognitionListConstraint` understands only the phrases it is
//!    given and runs entirely on the machine.
//!
//! This module uses the second and REFUSES to run without a phrase list, rather
//! than falling back to the first. That refusal is the whole safety property:
//! an empty list is the one input that would otherwise turn a local feature
//! into a network one silently. The phrases come from `voice/phrases.ts`, where
//! they are tested against the parser that has to act on them.
//!
//! `RecognizeAsync` rather than `RecognizeWithUIAsync`: the latter shows
//! Microsoft's own listening dialog, which would sit over the top of a desktop
//! pet whose whole point is being unobtrusive.
//!
//! EVERYWHERE ELSE, WHISPER TAKES THE TURN, and the reason this file used to
//! say otherwise is worth keeping. It argued that macOS was a deliberate stop:
//! `SFSpeechRecognizer` sends audio to Apple unless `requiresOnDeviceRecognition`
//! is set, it needs Objective-C FFI that cannot be compiled or tested from the
//! Windows machine this was written on, and writing unverifiable native code to
//! decide whether audio leaves the machine is not a risk worth taking blind.
//!
//! ALL OF THAT IS STILL TRUE ABOUT `SFSpeechRecognizer`, AND NONE OF IT IS A
//! REASON TO HAVE NO RECOGNISER. Whisper is compiled into this binary on both
//! platforms and `wake.rs` has already been using it on macOS to hear the wake
//! word. So the shape of the bug was: a Mac heard "hey loaf", answered "Mm?",
//! and then told the person that speaking to Loaf is Windows-only. The wake
//! word worked and led nowhere. This module now finishes the sentence it
//! started, with the engine that was already there.
//!
//! THE TWO PATHS ARE NOT THE SAME BARGAIN AND THAT IS SAID OUT LOUD. Windows
//! uses a closed grammar because free-form Windows recognition IS the online
//! one — the phrase list is the only thing keeping it local. Whisper has no
//! such coupling: it is a local model, so free speech costs nothing in privacy
//! and the phrase list is not load-bearing there. It is still required, so that
//! one caller cannot accidentally get a different guarantee on a different
//! machine, and so the refusal above stays a single rule rather than a pair.
//!
//! What is worse on this path is latency and accuracy, not privacy: Whisper is
//! a batch transcriber, so it answers when the sentence is over rather than as
//! it goes. `voice/engine.ts` argued from that that Whisper should never be a
//! command engine. That argument holds where there is an OS recogniser to
//! prefer, and collapses where there is none — a reply half a second late is
//! not worse than no reply at all.

/// What came back from one attempt to listen.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Heard {
    /// Words, and how sure the recogniser was.
    Text { text: String, confidence: String },
    /// It listened and heard nothing worth reporting.
    Nothing,
    /// It cannot listen at all here, with a reason fit to show someone.
    Unavailable { why: String },
}

/// Shown when the caller passes no phrases. See the module note: this is a
/// refusal, not a fallback.
const NO_PHRASES: &str = "Loaf had no list of phrases to listen for, so it did not listen. \
     Listening without one would mean using Windows' online recogniser.";

/// Take one turn.
///
/// `setup` is where the local Whisper model lives. Windows has an OS recogniser
/// and ignores it; everywhere else it IS the recogniser, so a caller that
/// cannot supply one gets an honest refusal rather than silence.
pub fn listen_once(setup: &crate::transcribe::WhisperSetup, phrases: Vec<String>) -> Heard {
    if phrases.is_empty() {
        return Heard::Unavailable {
            why: NO_PHRASES.into(),
        };
    }
    imp::listen_once(setup, phrases)
}

/// Whether a microphone button is worth showing at all.
pub fn available(setup: &crate::transcribe::WhisperSetup) -> bool {
    imp::available(setup)
}

#[cfg(windows)]
mod imp {
    use super::Heard;
    use windows::core::HSTRING;
    use windows::Foundation::Collections::IIterable;
    use windows::Media::SpeechRecognition::{
        SpeechRecognitionConfidence, SpeechRecognitionListConstraint,
        SpeechRecognitionResultStatus, SpeechRecognizer,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    /// Entered per call, exactly as `browser_windows.rs` does and for the same
    /// reason: these commands run on Tauri's thread pool, which has no COM
    /// apartment. WinRT needs one, so without this `SpeechRecognizer::new`
    /// fails with CO_E_NOTINITIALIZED every single time and the microphone
    /// button would look broken rather than absent.
    ///
    /// RPC_E_CHANGED_MODE means the thread is already in an apartment of
    /// another kind, which is fine — we simply must not uninitialise it.
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

    /// Build a recogniser that can only hear `phrases`.
    ///
    /// The constraint is added BEFORE compiling. Compiling with none added is
    /// the dictation path, so the order of these two lines is the difference
    /// between local and remote recognition rather than a matter of style.
    fn local_recognizer(phrases: &[String]) -> windows::core::Result<SpeechRecognizer> {
        let recognizer = SpeechRecognizer::new()?;
        let words: Vec<HSTRING> = phrases.iter().map(HSTRING::from).collect();
        let iterable = IIterable::<HSTRING>::try_from(words)?;
        let constraint = SpeechRecognitionListConstraint::Create(&iterable)?;
        recognizer.Constraints()?.Append(&constraint)?;

        let compiled = recognizer.CompileConstraintsAsync()?.get()?;
        let status = compiled.Status()?;
        if status != SpeechRecognitionResultStatus::Success {
            // A failed compile leaves a recogniser that would listen and never
            // match anything, so it is an error here rather than a silence
            // later that looks like the microphone not working.
            return Err(windows::core::Error::new(
                windows::Win32::Foundation::E_FAIL,
                format!("constraint compilation returned {status:?}"),
            ));
        }
        Ok(recognizer)
    }

    /// The setup is unused here: Windows has its own recogniser and never
    /// reaches for the model. It is in the signature so both platforms answer
    /// the same question through the same call.
    pub fn available(_setup: &crate::transcribe::WhisperSetup) -> bool {
        let _apartment = Apartment::enter();
        // Compiling a real constraint, not merely constructing a recogniser.
        // Construction succeeds on machines where the offline recogniser then
        // fails, and a button that always fails is worse than no button. The
        // phrase is arbitrary; what is being tested is that a LIST constraint
        // compiles, which is the path the real call takes.
        local_recognizer(&["wake up".to_string()]).is_ok()
    }

    fn confidence_name(c: SpeechRecognitionConfidence) -> &'static str {
        match c {
            SpeechRecognitionConfidence::High => "high",
            SpeechRecognitionConfidence::Medium => "medium",
            SpeechRecognitionConfidence::Low => "low",
            _ => "rejected",
        }
    }

    pub fn listen_once(_setup: &crate::transcribe::WhisperSetup, phrases: Vec<String>) -> Heard {
        let _apartment = Apartment::enter();
        let recognizer = match local_recognizer(&phrases) {
            Ok(r) => r,
            Err(e) => {
                return Heard::Unavailable {
                    // The usual cause is a missing speech language pack, and
                    // saying so is more use than the HRESULT.
                    why: format!(
                        "Windows speech is unavailable. A speech language pack may not be installed. ({e})"
                    ),
                };
            }
        };

        // RecognizeAsync, not RecognizeWithUIAsync: no system dialog over the
        // pet. This blocks until the recogniser decides the user has stopped
        // talking, which is why the command that calls it is async.
        let result = match recognizer.RecognizeAsync().and_then(|op| op.get()) {
            Ok(r) => r,
            Err(e) => {
                return Heard::Unavailable {
                    why: format!("I could not listen just then. ({e})"),
                }
            }
        };

        let text = result.Text().map(|t| t.to_string()).unwrap_or_default();
        if text.trim().is_empty() {
            return Heard::Nothing;
        }
        let confidence = result
            .Confidence()
            .map(confidence_name)
            .unwrap_or("rejected");

        // A rejected result is the recogniser saying it does not believe its own
        // transcription. Passing it on as text would hand the parser a sentence
        // nobody said, and the parser would sometimes match it.
        if confidence == "rejected" {
            return Heard::Nothing;
        }

        Heard::Text {
            text,
            confidence: confidence.to_string(),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Heard;
    use crate::transcribe::WhisperSetup;
    use crate::turn::{Outcome, Turn};
    use crate::vad::FRAME;

    /// How long to sleep between reads of the capture buffer.
    ///
    /// One frame's worth. Shorter spins the CPU for nothing; longer makes the
    /// reply late by exactly the amount it saves.
    const POLL_MS: u64 = 20;

    /// The longest one turn may take in wall-clock time, whatever the frames say.
    ///
    /// Comfortably longer than the lead-in plus the longest answer `Turn` will
    /// keep, so it never cuts anybody off; it exists only for a capture that
    /// has stopped producing audio without saying so.
    const MAX_TURN: std::time::Duration = std::time::Duration::from_secs(45);

    /// A microphone is only worth offering if something can listen to it.
    ///
    /// Both halves are checked, because the two failures need different
    /// sentences: no model is "download it in the Voice tab", no input device
    /// is "plug something in", and a button that fails either way is the thing
    /// this is meant to avoid.
    pub fn available(setup: &WhisperSetup) -> bool {
        crate::transcribe::missing(setup).is_none() && crate::audio::has_input()
    }

    /// `phrases` is deliberately unused. See the module note: on Windows the
    /// list is what keeps the recogniser off the network, and here there is no
    /// network to keep it off — Whisper is a file on this disk. It stays in the
    /// signature so that the refusal of an empty list is one rule for both
    /// platforms rather than a Windows quirk a future caller could route around
    /// by testing on a Mac.
    pub fn listen_once(setup: &WhisperSetup, _phrases: Vec<String>) -> Heard {
        // BEFORE THE MICROPHONE OPENS, never after. Refusing afterwards means
        // having recorded somebody for a transcription that was never going to
        // run — the same rule `dictate_once` and `wake.rs` follow.
        if let Some(what) = crate::transcribe::missing(setup) {
            return Heard::Unavailable {
                why: crate::transcribe::missing_reason(&what),
            };
        }

        let mut recording = match crate::audio::start() {
            Ok(r) => r,
            Err(why) => return Heard::Unavailable { why },
        };

        let mut turn = Turn::default();
        let mut read_from = 0usize;
        let mut pending: Vec<i16> = Vec::new();
        let mut outcome = Outcome::Nothing;
        let began = std::time::Instant::now();

        'listening: loop {
            // A CLOCK AS WELL AS THE FRAME COUNT, because `Turn` only ends when
            // it is fed. A capture that stops delivering samples — the device
            // unplugged, the stream dropped by the OS on a sleep — feeds it
            // nothing, and without this the loop would hold that microphone and
            // one thread of Tauri's pool open forever, with the indicator
            // saying Loaf was listening. The turn's own limits are the normal
            // way out; this is the one for when the audio stops arriving.
            if began.elapsed() > MAX_TURN {
                break 'listening;
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            let (fresh, next) = recording.samples_since(read_from);
            read_from = next;
            pending.extend_from_slice(&fresh);

            while pending.len() >= FRAME {
                let frame: Vec<i16> = pending.drain(..FRAME).collect();
                if let Some(done) = turn.push(&frame) {
                    outcome = done;
                    break 'listening;
                }
            }
        }

        // The audio goes before anything else happens to it, on every path.
        // Loaf keeps words, not voices.
        crate::audio::discard(recording);

        let Outcome::Heard(samples) = outcome else {
            return Heard::Nothing;
        };

        let audio: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
        let text = match crate::transcribe::transcribe_samples(setup, &audio) {
            Ok(t) => crate::transcribe::clean(&t),
            Err(why) => return Heard::Unavailable { why },
        };
        if text.trim().is_empty() {
            return Heard::Nothing;
        }

        Heard::Text {
            text,
            // NEVER "high", and this is load-bearing rather than modest. The
            // Windows path's confidence comes from a recogniser scoring itself
            // against a closed grammar; there is no equivalent number here, and
            // inventing a high one would let a free-text transcription through
            // a caller that only trusts a graded result. `wake.rs` reports its
            // own Whisper matches the same way and for the same reason.
            confidence: "weak".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether the OFFLINE recogniser actually works on this machine.
    ///
    /// Ignored by default because it needs a speech language pack and a real
    /// audio stack, neither of which a CI runner has — a failure there would
    /// mean nothing. Run it by hand on a machine you are about to speak into:
    ///
    ///     cargo test -- --ignored --nocapture local_recogniser
    ///
    /// This exists because the previous version of this file claimed to be
    /// local and was not, and a claim like that should be executable.
    #[test]
    #[ignore]
    fn local_recogniser_compiles_here() {
        let ok = available(&nowhere());
        println!("offline speech available on this machine: {ok}");
        assert!(ok, "the offline list-constraint recogniser did not compile");
    }

    /// A model path that is definitely not a model.
    ///
    /// The refusal below happens before any engine is touched, on either
    /// platform, so the setup only has to exist. Pointing it at a real model
    /// would make the test pass for a second reason and hide the first.
    fn nowhere() -> crate::transcribe::WhisperSetup {
        crate::transcribe::WhisperSetup {
            model: "no-such-model.bin".into(),
        }
    }

    /// The one rule in this file that can be checked on any platform: no
    /// phrases means no listening. The alternative implementation — listening
    /// anyway — is the Windows dictation grammar, which is the cloud.
    #[test]
    fn refuses_to_listen_without_a_phrase_list() {
        match listen_once(&nowhere(), Vec::new()) {
            Heard::Unavailable { why } => {
                assert!(why.contains("online"), "the reason should say why: {why}")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}
