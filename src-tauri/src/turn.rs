//! One spoken turn: wait for someone to start, keep what they say, stop at the pause.
//!
//! WHY THIS EXISTS SEPARATELY FROM `vad`. The detector answers one question per
//! frame — is somebody talking right now. Taking a *turn* is a different job
//! with its own edges: how long to hold the microphone open for someone who
//! never speaks, how much of one answer to keep, and what to do with the
//! fraction of a second before the detector was sure. Those decisions were
//! about to be written inline inside a loop that only runs with a real
//! microphone attached, which on this project means they would never have been
//! tested at all. Here they are pure: frames in, an outcome out, no audio
//! device and no model.
//!
//! THE PRE-ROLL IS THE PART THAT IS NOT OBVIOUS. A detector cannot declare
//! speech on the first loud frame — one frame is a keyboard click — so by the
//! time it is sure, the first syllable has already gone past. Handing the
//! transcriber audio that starts mid-word is how "open notepad" comes back as
//! "pen notepad". So the last fifth of a second is always kept, and when speech
//! is declared it is put back on the front. It costs 6 kB of memory and it is
//! the difference between a command that works and one that half works.

use crate::vad::{Event, Vad, FRAME};
use std::collections::VecDeque;

/// 20 ms of audio at 16 kHz, which is one [`FRAME`].
pub const MS_PER_FRAME: u32 = 20;

/// The three numbers that decide how patient one turn is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnConfig {
    /// How long to wait for somebody to start before giving up.
    ///
    /// This is a microphone held open at somebody, so it is short. It is also
    /// the answer to "I said the wake word and then changed my mind": the
    /// microphone closes on its own rather than waiting for the next sentence
    /// in the room to be aimed at it.
    pub lead_in_frames: u32,
    /// The longest single answer kept, after which it is cut and transcribed.
    ///
    /// Whoever is talking has stopped talking *to Loaf* by then. The VAD has a
    /// cap of its own at thirty seconds for a room mistaken for a person; this
    /// one is about a command, and a command is a sentence.
    pub max_speech_frames: u32,
    /// How much of the audio from before speech was declared to keep.
    pub preroll_frames: u32,
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self {
            // 6 seconds. Long enough to think after "Mm?", short enough that a
            // microphone nobody spoke to is closed while they still remember
            // opening it.
            lead_in_frames: 300,
            // 10 seconds. Longer than any command in `voice/phrases.ts` by a
            // wide margin, and short enough to transcribe quickly.
            max_speech_frames: 500,
            // 200 ms. Comfortably more than the 60 ms the detector spends
            // making up its mind.
            preroll_frames: 10,
        }
    }
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Somebody spoke, and this is what they said, as samples.
    Heard(Vec<i16>),
    /// Nobody spoke before the lead-in ran out.
    Nothing,
}

/// One turn in progress. Feed it frames until it answers.
#[derive(Debug, Clone)]
pub struct Turn {
    vad: Vad,
    cfg: TurnConfig,
    waited: u32,
    speech: Vec<i16>,
    recent: VecDeque<i16>,
    done: bool,
}

impl Default for Turn {
    fn default() -> Self {
        Self::new(Vad::default(), TurnConfig::default())
    }
}

impl Turn {
    pub fn new(vad: Vad, cfg: TurnConfig) -> Self {
        Self {
            vad,
            cfg,
            waited: 0,
            speech: Vec::new(),
            recent: VecDeque::new(),
            done: false,
        }
    }

    /// Whether speech has begun, for an indicator that says "go on then".
    pub fn started(&self) -> bool {
        !self.speech.is_empty()
    }

    /// How long this turn has been waiting for somebody to speak.
    pub fn waited_ms(&self) -> u32 {
        self.waited * MS_PER_FRAME
    }

    /// Feed one frame of [`FRAME`] samples. `Some` means the turn is over.
    ///
    /// Calling again after it has answered is a caller bug rather than an
    /// interesting case, so it answers `Nothing` instead of panicking — this
    /// runs on the audio thread, and taking the process down because a loop
    /// checked its condition in the wrong order would be a worse failure than
    /// the one being guarded against.
    pub fn push(&mut self, frame: &[i16]) -> Option<Outcome> {
        if self.done {
            return Some(Outcome::Nothing);
        }
        let cap = self.cfg.max_speech_frames as usize * FRAME;

        match self.vad.push(frame) {
            Event::Started => {
                // The pre-roll, put back on the front. See the module note.
                self.speech = self.recent.iter().copied().collect();
                self.speech.extend_from_slice(frame);
                self.recent.clear();
                None
            }
            Event::Speaking => {
                self.speech.extend_from_slice(frame);
                if self.speech.len() >= cap {
                    self.done = true;
                    Some(Outcome::Heard(std::mem::take(&mut self.speech)))
                } else {
                    None
                }
            }
            Event::Ended => {
                self.done = true;
                if self.speech.is_empty() {
                    Some(Outcome::Nothing)
                } else {
                    Some(Outcome::Heard(std::mem::take(&mut self.speech)))
                }
            }
            Event::Quiet => {
                self.remember(frame);
                self.waited += 1;
                if self.waited >= self.cfg.lead_in_frames {
                    self.done = true;
                    return Some(Outcome::Nothing);
                }
                None
            }
        }
    }

    /// Keep the most recent `preroll_frames` frames and no more.
    fn remember(&mut self, frame: &[i16]) {
        let keep = self.cfg.preroll_frames as usize * FRAME;
        if keep == 0 {
            return;
        }
        self.recent.extend(frame.iter().copied());
        while self.recent.len() > keep {
            self.recent.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vad::VadConfig;

    /// A frame of room tone. Not digital silence: a real microphone never
    /// produces that, and a floor learned from zeros makes every breath a shout.
    fn quiet() -> Vec<i16> {
        (0..FRAME)
            .map(|i| if i % 2 == 0 { 12 } else { -12 })
            .collect()
    }

    /// A frame loud enough to be speech against `quiet`.
    fn loud() -> Vec<i16> {
        (0..FRAME)
            .map(|i| if i % 2 == 0 { 4_000 } else { -4_000 })
            .collect()
    }

    fn turn() -> Turn {
        Turn::new(Vad::new(VadConfig::default()), TurnConfig::default())
    }

    fn feed(t: &mut Turn, frame: &[i16], times: usize) -> Option<Outcome> {
        for _ in 0..times {
            if let Some(out) = t.push(frame) {
                return Some(out);
            }
        }
        None
    }

    #[test]
    fn silence_gives_up_after_the_lead_in() {
        let mut t = turn();
        let cfg = TurnConfig::default();
        // One frame short of the lead-in, it is still waiting.
        assert_eq!(
            feed(&mut t, &quiet(), cfg.lead_in_frames as usize - 1),
            None
        );
        assert_eq!(t.push(&quiet()), Some(Outcome::Nothing));
    }

    #[test]
    fn the_lead_in_is_seconds_not_minutes() {
        // A microphone held open at somebody who is not talking is the thing
        // this number exists to bound, so it is worth asserting rather than
        // leaving to whoever edits the struct next.
        let ms = TurnConfig::default().lead_in_frames * MS_PER_FRAME;
        assert!((2_000..=10_000).contains(&ms), "lead-in was {ms} ms");
    }

    #[test]
    fn speech_then_a_pause_is_one_utterance() {
        let mut t = turn();
        assert_eq!(feed(&mut t, &quiet(), 60), None);
        assert_eq!(feed(&mut t, &loud(), 40), None);
        let out = feed(&mut t, &quiet(), 60).expect("the pause should end it");
        match out {
            Outcome::Heard(samples) => assert!(!samples.is_empty()),
            Outcome::Nothing => panic!("it heard speech and reported nothing"),
        }
    }

    #[test]
    fn what_it_keeps_is_the_speech_and_not_the_wait() {
        let mut t = turn();
        // Two seconds of room before anybody says anything.
        feed(&mut t, &quiet(), 100);
        feed(&mut t, &loud(), 40);
        let Some(Outcome::Heard(samples)) = feed(&mut t, &quiet(), 60) else {
            panic!("expected speech");
        };
        // 40 loud frames plus the pre-roll and the hangover — nothing like the
        // 100 frames of waiting that came first.
        let frames = samples.len() / FRAME;
        assert!(frames >= 40, "kept only {frames} frames of 40 spoken");
        assert!(
            frames < 100,
            "kept {frames} frames, which is most of the wait"
        );
    }

    // The bug this stops: audio handed over starting mid-word, so "open
    // notepad" is transcribed from "pen notepad".
    #[test]
    fn the_moment_before_speech_was_declared_is_kept() {
        let mut t = turn();
        feed(&mut t, &quiet(), 60);
        let with_preroll = {
            feed(&mut t, &loud(), 40);
            let Some(Outcome::Heard(s)) = feed(&mut t, &quiet(), 60) else {
                panic!("expected speech");
            };
            s.len()
        };

        let mut bare = Turn::new(
            Vad::new(VadConfig::default()),
            TurnConfig {
                preroll_frames: 0,
                ..TurnConfig::default()
            },
        );
        feed(&mut bare, &quiet(), 60);
        feed(&mut bare, &loud(), 40);
        let Some(Outcome::Heard(s)) = feed(&mut bare, &quiet(), 60) else {
            panic!("expected speech");
        };
        assert!(
            with_preroll > s.len(),
            "pre-roll kept {with_preroll} samples, no pre-roll kept {} — it is not being kept",
            s.len()
        );
    }

    #[test]
    fn the_pre_roll_is_bounded() {
        let mut t = turn();
        // Ten minutes of room tone must not grow anything.
        feed(&mut t, &quiet(), 200);
        assert!(
            t.recent.len() <= TurnConfig::default().preroll_frames as usize * FRAME,
            "the pre-roll grew to {} samples",
            t.recent.len()
        );
    }

    #[test]
    fn a_speaker_who_never_stops_is_cut_and_kept() {
        let cfg = TurnConfig {
            max_speech_frames: 20,
            ..TurnConfig::default()
        };
        let mut t = Turn::new(Vad::new(VadConfig::default()), cfg);
        feed(&mut t, &quiet(), 60);
        let out = feed(&mut t, &loud(), 400).expect("the cap should end it");
        match out {
            // Cut, not thrown away: most of a command is worth transcribing.
            Outcome::Heard(samples) => {
                assert!(samples.len() >= cfg.max_speech_frames as usize * FRAME);
            }
            Outcome::Nothing => panic!("the cap threw away everything that was said"),
        }
    }

    #[test]
    fn started_says_whether_anybody_is_talking() {
        let mut t = turn();
        feed(&mut t, &quiet(), 60);
        assert!(!t.started());
        feed(&mut t, &loud(), 10);
        assert!(t.started());
    }

    #[test]
    fn waiting_is_reported_in_milliseconds() {
        let mut t = turn();
        feed(&mut t, &quiet(), 50);
        assert_eq!(t.waited_ms(), 50 * MS_PER_FRAME);
    }

    // Time spent waiting must not count against the answer. Someone who pauses
    // for four seconds and then speaks should be heard, not cut off.
    #[test]
    fn a_long_pause_before_speaking_still_gets_heard() {
        let mut t = turn();
        let cfg = TurnConfig::default();
        assert_eq!(
            feed(&mut t, &quiet(), cfg.lead_in_frames as usize - 20),
            None
        );
        feed(&mut t, &loud(), 40);
        let Some(Outcome::Heard(s)) = feed(&mut t, &quiet(), 60) else {
            panic!("speech after a long wait was lost");
        };
        assert!(!s.is_empty());
    }

    #[test]
    fn it_answers_rather_than_panicking_when_pushed_after_it_is_done() {
        let mut t = turn();
        feed(
            &mut t,
            &quiet(),
            TurnConfig::default().lead_in_frames as usize,
        );
        assert_eq!(t.push(&quiet()), Some(Outcome::Nothing));
        assert_eq!(t.push(&loud()), Some(Outcome::Nothing));
    }

    // A turn that answers `Heard` with nothing in it would send an empty clip
    // to the transcriber, which returns a hallucination rather than an error.
    #[test]
    fn heard_is_never_empty() {
        for spoken in [1usize, 3, 5, 40] {
            let mut t = turn();
            feed(&mut t, &quiet(), 60);
            feed(&mut t, &loud(), spoken);
            if let Some(Outcome::Heard(s)) = feed(&mut t, &quiet(), 60) {
                assert!(!s.is_empty(), "empty Heard after {spoken} loud frames");
            }
        }
    }
}
