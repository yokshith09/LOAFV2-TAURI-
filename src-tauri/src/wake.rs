//! Listening all the time, for the two words that mean you are talking to Loaf.
//!
//! THIS IS THE ONE FEATURE THAT CONTRADICTS THE PITCH, SO IT IS BUILT TO ARGUE
//! ITS OWN CASE. Loaf's claim is that it does not watch you. A wake word means
//! a microphone that is on whenever the app is, which is the most intrusive
//! thing this app could possibly do. Three things make it defensible, and all
//! three are load-bearing rather than decorative:
//!
//!  1. IT IS OFF UNTIL SOMEONE TURNS IT ON. There is no default, no "try it and
//!     see", and no first-run prompt that gets clicked through.
//!  2. IT STAYS ON THE MACHINE. The same `SpeechRecognitionListConstraint` as
//!     `speech.rs`, for the same reason: a continuous session with no
//!     constraints would be continuous DICTATION, streaming everything said in
//!     the room to Microsoft. This module refuses an empty phrase list exactly
//!     as `speech.rs` does, and that refusal is the whole safety property.
//!  3. IT CAN ONLY HEAR ITS OWN GRAMMAR. A closed vocabulary physically cannot
//!     transcribe a conversation. Someone talking near a listening Loaf
//!     produces "no match", not a transcript. This is the strongest privacy
//!     property here and it is a consequence of the design rather than a
//!     promise anyone has to trust.
//!
//! WHAT IS NOT DECIDED HERE. Whether a phrase followed the wake word, and
//! whether it came soon enough to count, is `src/voice/wake.ts` — pure, tested,
//! and easy to change. This file starts a session, forwards what it heard, and
//! stops. Putting the timing rules in Rust would have made the one part with
//! real edge cases the one part that cannot be tested.
//!
//! THE BUG THIS FILE USED TO HAVE, RECORDED SO IT IS NOT REINTRODUCED. WinRT's
//! `SpeechContinuousRecognitionSession` stops ITSELF after a period of
//! silence, by default. That is not an edge case for an always-on wake word —
//! it is the normal state, since most of the time nobody is talking to Loaf.
//! The first version of this file never set `AutoStopSilenceTimeout` and never
//! listened for the session's own `Completed` event, so once the OS silently
//! stopped the session, `LISTENING` stayed `true`, the closet still said
//! "Always", and nothing was actually listening — forever, with no error and
//! no way for the user to know short of trying the wake word and getting
//! nothing back. Fixed two ways: the silence timeout is set to effectively
//! never, and `Completed` is handled by restarting the same session rather
//! than leaving it dead.

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether a session is running. Read by the frontend to render the indicator.
static LISTENING: AtomicBool = AtomicBool::new(false);

/// Emitted for every phrase the continuous session matches.
pub const HEARD_EVENT: &str = "loaf://voice/heard";
/// Emitted when the session stops on its own, so the UI cannot show a
/// microphone that is not actually open.
pub const STOPPED_EVENT: &str = "loaf://voice/stopped";
/// Emitted when the recogniser heard something and REJECTED it.
///
/// MEASURED, NOT GUESSED: on the machine this was written on, saying the wake
/// word produced exactly one result — empty text, confidence `Rejected` — and
/// the handler below dropped it, correctly, because acting on a rejected
/// result means acting on a sentence nobody said. The consequence was that
/// "Loaf is not listening" and "Loaf heard you and was not sure" were the same
/// silence, and no amount of trying again could tell them apart.
///
/// This carries NO text, deliberately. It exists so the UI can say "I heard
/// something" and nothing more; a rejected transcription is not evidence of
/// what was said and must never reach the command parser.
pub const REJECTED_EVENT: &str = "loaf://voice/rejected";

#[derive(Debug, Clone, serde::Serialize)]
pub struct HeardPhrase {
    pub text: String,
    pub confidence: String,
}

pub fn is_listening() -> bool {
    LISTENING.load(Ordering::SeqCst)
}

/// Refused rather than run: an empty grammar means continuous dictation, and
/// continuous dictation means a hot microphone streaming to a server.
pub const NO_PHRASES: &str = "Loaf had no phrases to listen for, so it did not start listening. \
     Listening without them would mean Windows' online recogniser.";

#[cfg(windows)]
pub use imp::{start, stop};

#[cfg(not(windows))]
pub fn start<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    _phrases: Vec<String>,
) -> Result<(), String> {
    Err("Always-on listening is Windows-only for now.".into())
}

#[cfg(not(windows))]
pub fn stop() {}

#[cfg(windows)]
mod imp {
    use super::{HeardPhrase, HEARD_EVENT, LISTENING, NO_PHRASES, REJECTED_EVENT, STOPPED_EVENT};
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;
    use windows::core::HSTRING;
    use windows::Foundation::Collections::IIterable;
    use windows::Foundation::TimeSpan;
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs,
        SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
        SpeechRecognitionConfidence, SpeechRecognitionListConstraint, SpeechRecognitionResult,
        SpeechRecognitionResultStatus, SpeechRecognizer,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    /// WinRT's own silence auto-stop, set as close to "never" as the type
    /// allows: 24 hours, in the 100-nanosecond ticks `TimeSpan` counts in.
    /// Always-on listening is meant to run for as long as the setting is on,
    /// not for as long as someone happens to keep talking.
    fn effectively_never() -> TimeSpan {
        TimeSpan {
            Duration: 24 * 60 * 60 * 10_000_000,
        }
    }

    /// Set to ask the listening thread to wind the session up.
    static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

    fn confidence_name(c: SpeechRecognitionConfidence) -> &'static str {
        match c {
            SpeechRecognitionConfidence::High => "high",
            SpeechRecognitionConfidence::Medium => "medium",
            SpeechRecognitionConfidence::Low => "low",
            _ => "rejected",
        }
    }

    /// The best real phrase behind a rejected result, if there is one.
    ///
    /// Rejected results carry their candidates, and on this machine the wake
    /// word was reliably among them while the primary text was empty. Only
    /// phrases from the compiled grammar can appear here — see the note at the
    /// call site for why that is what makes reading them safe.
    fn best_alternate(result: &SpeechRecognitionResult) -> Option<String> {
        let alternates = result.GetAlternates(5).ok()?;
        for i in 0..alternates.Size().ok()? {
            let Ok(alt) = alternates.GetAt(i) else {
                continue;
            };
            let text = alt.Text().map(|t| t.to_string()).unwrap_or_default();
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
        None
    }

    pub fn start<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        phrases: Vec<String>,
    ) -> Result<(), String> {
        if phrases.is_empty() {
            return Err(NO_PHRASES.into());
        }
        if LISTENING.swap(true, Ordering::SeqCst) {
            // Already on. Starting twice would leave a session nothing can stop.
            return Ok(());
        }
        STOP.store(false, Ordering::SeqCst);

        // A dedicated thread, because the recogniser and its session are COM
        // objects that must live and die on one apartment. Handing them across
        // threads is how this would become an intermittent crash rather than a
        // feature.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::spawn(move || {
            let _apartment = Apartment::enter();
            match run(&app, phrases, &ready_tx) {
                Ok(()) => {}
                Err(e) => {
                    // If it failed before reporting, the caller is still
                    // waiting; if after, the UI needs to stop showing a
                    // microphone that is not open.
                    let _ = ready_tx.send(Err(e.clone()));
                    let _ = app.emit(STOPPED_EVENT, e);
                }
            }
            LISTENING.store(false, Ordering::SeqCst);
            let _ = app.emit(STOPPED_EVENT, String::new());
        });

        match ready_rx.recv_timeout(std::time::Duration::from_secs(20)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                LISTENING.store(false, Ordering::SeqCst);
                Err(e)
            }
            Err(_) => {
                LISTENING.store(false, Ordering::SeqCst);
                STOP.store(true, Ordering::SeqCst);
                Err("Speech did not start in time.".into())
            }
        }
    }

    fn run<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        phrases: Vec<String>,
        ready: &std::sync::mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let recognizer = SpeechRecognizer::new().map_err(|e| {
            format!(
                "Windows speech is unavailable. A speech language pack may not be installed. ({e})"
            )
        })?;

        let words: Vec<HSTRING> = phrases.iter().map(HSTRING::from).collect();
        let iterable = IIterable::<HSTRING>::try_from(words).map_err(|e| e.to_string())?;
        let constraint =
            SpeechRecognitionListConstraint::Create(&iterable).map_err(|e| e.to_string())?;
        recognizer
            .Constraints()
            .map_err(|e| e.to_string())?
            .Append(&constraint)
            .map_err(|e| e.to_string())?;

        let compiled = recognizer
            .CompileConstraintsAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;
        let status = compiled.Status().map_err(|e| e.to_string())?;
        if status != SpeechRecognitionResultStatus::Success {
            return Err(format!("Speech could not start ({status:?})."));
        }

        let session: SpeechContinuousRecognitionSession = recognizer
            .ContinuousRecognitionSession()
            .map_err(|e| e.to_string())?;
        // See the module doc comment: without this, ordinary silence — the
        // normal state of an always-on wake word — stops the session on its
        // own.
        session
            .SetAutoStopSilenceTimeout(effectively_never())
            .map_err(|e| e.to_string())?;

        let sink = app.clone();
        session
            .ResultGenerated(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionResultGeneratedEventArgs,
            >::new(move |_, args| {
                let Some(args) = args.as_ref() else {
                    return Ok(());
                };
                if let Ok(result) = args.Result() {
                    let text = result.Text().map(|t| t.to_string()).unwrap_or_default();
                    let confidence = result
                        .Confidence()
                        .map(confidence_name)
                        .unwrap_or("rejected");
                    if !text.trim().is_empty() && confidence != "rejected" {
                        let _ = sink.emit(
                            HEARD_EVENT,
                            HeardPhrase {
                                text,
                                confidence: confidence.to_string(),
                            },
                        );
                    } else if let Some(alt) = best_alternate(&result) {
                        // THE BUG THIS FIXES, MEASURED ON A REAL MACHINE.
                        // Saying the wake word produced a top result of EMPTY
                        // TEXT with confidence `Rejected` — and the wake word
                        // sitting right there in the alternates:
                        //
                        //   [0] ""          raw 0.000  Rejected
                        //   [1] "loaf"      raw 0.0056 Low
                        //   [2] "hey loaf"  raw 0.0056 Low
                        //
                        // This handler only ever read `Text()`, so it read the
                        // empty string and threw the match away. Every "I said
                        // hey loaf and nothing happened" was this.
                        //
                        // WHY READING ALTERNATES IS STILL SAFE, which is the
                        // only question that matters here: the alternates come
                        // from the SAME compiled list constraint as the primary
                        // result. Every one of them is a phrase this app put in
                        // the grammar itself. There is no path by which reading
                        // them can produce a sentence that was not already in
                        // the vocabulary, so the closed-grammar property this
                        // whole module rests on is untouched.
                        //
                        // It is marked `weak` rather than passed off as a
                        // normal result, because the frontend must NOT act on
                        // one of these as a command. `voice/wake.ts` accepts a
                        // weak match only as the wake word, where being wrong
                        // costs a bubble saying "Mm?" and nothing else.
                        let _ = sink.emit(
                            HEARD_EVENT,
                            HeardPhrase {
                                text: alt,
                                confidence: "weak".to_string(),
                            },
                        );
                    } else {
                        let _ = sink.emit(REJECTED_EVENT, ());
                    }
                }
                Ok(())
            }))
            .map_err(|e| e.to_string())?;

        // `Completed` fires whenever the session stops running — deliberately
        // (StopAsync, below) or not (silence, an audio device change, another
        // app taking the microphone). Recording that it fired, and why, is
        // what turns "silently dead forever" into "restarted" or, after
        // repeated failures, an actual reported reason instead of a mystery.
        let died = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let last_status: Arc<Mutex<Option<SpeechRecognitionResultStatus>>> =
            Arc::new(Mutex::new(None));
        let died_for_handler = Arc::clone(&died);
        let status_for_handler = Arc::clone(&last_status);
        session
            .Completed(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionCompletedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    if let Ok(status) = args.Status() {
                        *status_for_handler.lock().unwrap() = Some(status);
                    }
                }
                died_for_handler.store(true, Ordering::SeqCst);
                Ok(())
            }))
            .map_err(|e| e.to_string())?;

        session
            .StartAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;

        let _ = ready.send(Ok(()));

        // A restart budget rather than an unconditional retry loop: five
        // restarts within a rolling minute is almost certainly a transient
        // hiccup (another app briefly took the microphone); more than that is
        // more likely something actually wrong — no microphone, a driver
        // problem — and restarting forever would hide that behind a mode
        // that LOOKS on but never hears anything, the exact failure this
        // rewrite exists to fix.
        let mut restarts_in_window = 0u32;
        let mut window_started = std::time::Instant::now();

        while !STOP.load(Ordering::SeqCst) {
            if died.swap(false, Ordering::SeqCst) {
                if window_started.elapsed() > std::time::Duration::from_secs(60) {
                    restarts_in_window = 0;
                    window_started = std::time::Instant::now();
                }
                restarts_in_window += 1;
                if restarts_in_window > 5 {
                    let status = last_status.lock().ok().and_then(|mut s| s.take());
                    return Err(format!(
                        "Speech kept stopping on its own ({status:?} last time) even after \
                         several restarts, so Loaf gave up rather than loop forever."
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
                // The SAME session object, not a new one: `ResultGenerated` and
                // `Completed` are attached to the session for its whole
                // lifetime, so calling `StartAsync` again resumes it without
                // re-registering either handler.
                if let Err(e) = session.StartAsync().and_then(|op| op.get()) {
                    return Err(format!("Could not restart listening: {e}"));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }

        // Best effort. A session that has already ended returns an error here
        // and that is not worth reporting to anyone.
        let _ = session.StopAsync().map(|op| op.get());
        Ok(())
    }

    pub fn stop() {
        STOP.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule that can be checked anywhere: nothing starts without a
    /// vocabulary, because the alternative is continuous dictation.
    #[test]
    fn the_refusal_says_why() {
        assert!(NO_PHRASES.contains("online"));
    }

    #[test]
    fn starts_switched_off() {
        assert!(!is_listening());
    }
}
