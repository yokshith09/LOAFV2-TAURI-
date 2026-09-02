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

/// Shown when the caller passes no phrases. See the module note: this is a
/// refusal, not a fallback.
const NO_PHRASES: &str = "Loaf had no list of phrases to listen for, so it did not listen. \
     Listening without one would mean using Windows' online recogniser.";

pub fn listen_once(phrases: Vec<String>) -> Heard {
    if phrases.is_empty() {
        return Heard::Unavailable {
            why: NO_PHRASES.into(),
        };
    }
    imp::listen_once(phrases)
}

/// Whether a microphone button is worth showing at all.
pub fn available() -> bool {
    imp::available()
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

    pub fn available() -> bool {
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

    pub fn listen_once(phrases: Vec<String>) -> Heard {
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

    pub fn available() -> bool {
        false
    }

    pub fn listen_once(_phrases: Vec<String>) -> Heard {
        Heard::Unavailable {
            why: "Speaking to Loaf is Windows-only for now. The command box works everywhere."
                .into(),
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
        let ok = available();
        println!("offline speech available on this machine: {ok}");
        assert!(ok, "the offline list-constraint recogniser did not compile");
    }

    /// The one rule in this file that can be checked on any platform: no
    /// phrases means no listening. The alternative implementation — listening
    /// anyway — is the Windows dictation grammar, which is the cloud.
    #[test]
    fn refuses_to_listen_without_a_phrase_list() {
        match listen_once(Vec::new()) {
            Heard::Unavailable { why } => {
                assert!(why.contains("online"), "the reason should say why: {why}")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}
