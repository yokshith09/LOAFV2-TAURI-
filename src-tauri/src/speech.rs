//! Turning one held-down moment of speech into a string.
//!
//! WHAT THIS IS AND IS NOT. It listens ONCE, when you ask it to, and returns
//! what it heard. There is no wake word, no continuous listening, and no way
//! for this module to run without a deliberate call — which is the difference
//! between a push-to-talk button and a microphone that is simply on. Nothing is
//! recorded, nothing is written to disk, and the audio never leaves the
//! recogniser.
//!
//! The string it returns goes to `voice/commands.ts`, which is where the
//! interesting decisions live and where they are tested. This file is the part
//! that cannot be unit-tested, so it is deliberately as small as possible: get
//! a recogniser, ask it once, hand back text or a reason there is none.
//!
//! WINDOWS uses `Windows.Media.SpeechRecognition`, which runs on the machine.
//! `RecognizeAsync` rather than `RecognizeWithUIAsync`: the latter shows
//! Microsoft's own listening dialog, which would sit over the top of a desktop
//! pet whose whole point is being unobtrusive.
//!
//! macOS is NOT implemented, and that is a deliberate stop rather than an
//! oversight. `SFSpeechRecognizer` sends audio to Apple's servers unless
//! `requiresOnDeviceRecognition` is set, it needs Objective-C FFI that cannot
//! be compiled or tested from the Windows machine this was written on, and this
//! codebase has already shipped one syntax error into macOS-only code that no
//! local check could see. Writing a second, larger piece of unverifiable native
//! code that decides whether audio leaves the machine is not a risk worth
//! taking blind. It reports "not supported here", which the caller already
//! handles, so a Mac gets the command box and no microphone button.

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

pub fn listen_once() -> Heard {
    imp::listen_once()
}

/// Whether a microphone button is worth showing at all.
pub fn available() -> bool {
    imp::available()
}

#[cfg(windows)]
mod imp {
    use super::Heard;
    use windows::Media::SpeechRecognition::{SpeechRecognitionConfidence, SpeechRecognizer};
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

    pub fn available() -> bool {
        let _apartment = Apartment::enter();
        // Constructing one is the only honest test. A machine with no speech
        // language pack installed fails here rather than at the first attempt
        // to listen, and it is better to hide the button than to offer one that
        // always fails.
        SpeechRecognizer::new().is_ok()
    }

    fn confidence_name(c: SpeechRecognitionConfidence) -> &'static str {
        match c {
            SpeechRecognitionConfidence::High => "high",
            SpeechRecognitionConfidence::Medium => "medium",
            SpeechRecognitionConfidence::Low => "low",
            _ => "rejected",
        }
    }

    pub fn listen_once() -> Heard {
        let _apartment = Apartment::enter();
        let recognizer = match SpeechRecognizer::new() {
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

        // Constraints have to be compiled before the recogniser will listen.
        // With none added, this compiles the built-in dictation grammar, which
        // is what we want: Loaf's own grammar lives in TypeScript and is far
        // easier to change there than as a WinRT constraint set.
        if let Err(e) = recognizer.CompileConstraintsAsync().and_then(|op| op.get()) {
            return Heard::Unavailable {
                why: format!("Speech could not start. ({e})"),
            };
        }

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

    pub fn available() -> bool {
        false
    }

    pub fn listen_once() -> Heard {
        Heard::Unavailable {
            why: "Speaking to Loaf is Windows-only for now. The command box works everywhere."
                .into(),
        }
    }
}
