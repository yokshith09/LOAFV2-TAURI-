//! Deciding when somebody started talking, and — the harder half — when they
//! stopped.
//!
//! WHAT THIS REPLACES. Loaf has been deciding both by comparing loudness to a
//! fixed number. That fails in both directions and everybody has felt it: a
//! quiet talker in a quiet room never crosses the line, and a noisy room sits
//! above it forever so nothing ever ends. It is the reason recordings cut people
//! off mid-sentence and the reason the microphone keeps listening to silence.
//!
//! THREE THINGS A FIXED THRESHOLD CANNOT DO, and all three are why this exists:
//!
//!  1. **It does not know how loud the room is.** A laptop fan, an air
//!     conditioner and a café are all different floors, and the only number that
//!     matters is how far above the floor a sound is — not how loud it is. The
//!     floor here is learned continuously from the quiet parts.
//!
//!  2. **It flickers.** One threshold means a sound hovering near it toggles
//!     every frame. Speech is full of such moments: the gap inside "s—top", the
//!     dip between words. Two thresholds — a higher one to start, a lower one to
//!     keep going — mean a voice that has been heard stays heard through its own
//!     quiet parts. That is hysteresis, and it is the difference between one
//!     sentence and eleven fragments.
//!
//!  3. **It stops at the first pause.** People pause mid-sentence to think. A
//!     detector that ends on the first quiet frame ends halfway through what
//!     somebody was saying, which is the single most annoying thing a voice
//!     interface does. Silence has to persist for a while — the hangover — before
//!     it counts as the end.
//!
//! WHY NOT SILERO. The plan named Silero VAD, and Silero is better than this at
//! telling a voice from a door slam. It is also an ONNX model, which means
//! bundling an ONNX runtime for two platforms into an app that prides itself on
//! being small, and a build I cannot verify on the machine this is written on.
//! The step from "fixed number" to "adaptive floor with hysteresis and hangover"
//! is the large one; the step from here to Silero is real but smaller. So this
//! ships now, tested, on both platforms, and `Vad` is an interface a Silero
//! backend can sit behind later without anything above it changing.
//!
//! Pure arithmetic over samples. No audio device, no platform code, no clock —
//! which is what lets every case below be a test rather than a hope.

/// 20 ms at 16 kHz. Short enough to catch the start of a word, long enough that
/// one loud click cannot look like speech.
pub const FRAME: usize = 320;

/// Frames per block of the noise estimate. 100 frames is two seconds.
const BLOCK_FRAMES: u32 = 100;

/// Blocks kept. Eight blocks of two seconds is a sixteen-second window —
/// comfortably longer than the longest unbroken sentence, and short enough that
/// a room which changed is believed before anybody gets annoyed.
const BLOCKS: usize = 8;

/// How the detector behaves. Every number here is a decision, so each is named.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VadConfig {
    /// How many times above the noise floor a frame must be to START speech.
    pub start_ratio: f32,
    /// And to KEEP it. Lower than `start_ratio` — this is the hysteresis.
    pub keep_ratio: f32,
    /// Consecutive loud frames before speech is declared. Rejects clicks.
    pub start_frames: u32,
    /// Consecutive quiet frames before speech is declared over. The hangover.
    pub hangover_frames: u32,
    /// The longest a single utterance may run before it is ended anyway.
    /// Speech that never stops is a room being mistaken for a person.
    pub max_speech_frames: u32,
    /// The floor never goes below this, so a digitally silent input does not
    /// make every faint sound look like a shout.
    pub floor: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            // Speech is typically 10-20x the room floor. Three is generous
            // enough for a quiet talker and still well clear of a fan.
            start_ratio: 3.0,
            // Kept lower so the dips inside a word do not end it.
            keep_ratio: 1.6,
            // 3 frames = 60 ms. A keyboard click is shorter than that.
            start_frames: 3,
            // 25 frames = 500 ms. Long enough for a thinking pause, short
            // enough that the answer does not feel late.
            hangover_frames: 25,
            // 30 seconds. Longer than anybody says in one breath to a pet.
            max_speech_frames: 1500,
            floor: 0.0008,
        }
    }
}

/// What changed on this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// Nothing changed.
    Quiet,
    /// Still going.
    Speaking,
    /// Somebody just started.
    Started,
    /// Somebody just stopped, and this is the moment to act.
    Ended,
}

/// The detector. One per stream; it carries the learned floor.
#[derive(Debug, Clone)]
pub struct Vad {
    cfg: VadConfig,
    noise: f32,
    speaking: bool,
    loud_run: u32,
    quiet_run: u32,
    /// Frames of speech in the current utterance, for `speech_ms`.
    spoken: u32,
    /// The quietest frame seen in the block currently filling.
    block_min: f32,
    block_frames: u32,
    /// The quietest frame of each completed block; the floor is their minimum.
    blocks: [f32; BLOCKS],
    block_at: usize,
}

impl Default for Vad {
    fn default() -> Self {
        Self::new(VadConfig::default())
    }
}

impl Vad {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            noise: cfg.floor,
            cfg,
            speaking: false,
            loud_run: 0,
            quiet_run: 0,
            spoken: 0,
            block_min: f32::MAX,
            block_frames: 0,
            // Starts believing the room is silent. The first block corrects it,
            // which is two seconds, and until then `floor` is the clamp.
            blocks: [f32::MAX; BLOCKS],
            block_at: 0,
        }
    }

    /// Root mean square of a frame, as a fraction of full scale.
    pub fn level(frame: &[i16]) -> f32 {
        if frame.is_empty() {
            return 0.0;
        }
        let sum: f64 = frame
            .iter()
            .map(|s| {
                let v = *s as f64 / 32768.0;
                v * v
            })
            .sum();
        ((sum / frame.len() as f64).sqrt()) as f32
    }

    /// Feed one frame. Call with [`FRAME`] samples at 16 kHz.
    pub fn push(&mut self, frame: &[i16]) -> Event {
        let level = Self::level(frame);
        let ratio = level / self.noise.max(self.cfg.floor);

        let loud = if self.speaking {
            ratio >= self.cfg.keep_ratio
        } else {
            ratio >= self.cfg.start_ratio
        };

        if loud {
            self.loud_run = self.loud_run.saturating_add(1);
            self.quiet_run = 0;
        } else {
            self.quiet_run = self.quiet_run.saturating_add(1);
            self.loud_run = 0;
        }

        self.learn(level);

        if self.speaking {
            self.spoken += 1;
            // A SENTENCE THAT NEVER ENDS IS NOT A SENTENCE. If "speech" has run
            // past any plausible utterance, the thing being heard is the room,
            // not a person — a fan that started after the floor was learned, or
            // a stream that opened mid-noise. Ending it releases whatever was
            // waiting and lets `learn` treat the sound as the room it is.
            if self.quiet_run >= self.cfg.hangover_frames
                || self.spoken >= self.cfg.max_speech_frames
            {
                self.speaking = false;
                self.quiet_run = 0;
                self.spoken = 0;
                return Event::Ended;
            }
            Event::Speaking
        } else {
            if self.loud_run >= self.cfg.start_frames {
                self.speaking = true;
                self.loud_run = 0;
                self.spoken = self.cfg.start_frames;
                return Event::Started;
            }
            Event::Quiet
        }
    }

    /// Keep the noise floor pointed at the room rather than at the voice.
    ///
    /// TWO WRONG VERSIONS CAME BEFORE THIS ONE, and both were found by tests
    /// rather than by reading, which is why they are written down here.
    ///
    /// The first only learned from frames it had already judged quiet. That is
    /// circular: open the microphone in a room that is already noisy, every
    /// frame reads as speech, so no frame is ever quiet, so the floor never
    /// moves and the room stays "speech" forever — the exact failure this file
    /// exists to end, reproduced by the fix for it.
    ///
    /// The second let the floor rise during speech, slowly. "Slowly" was still
    /// fast enough for a ten-second sentence to drag the floor up by a factor
    /// of thirty-eight and very nearly cut the speaker off. The comment on it
    /// claimed the movement was unmeasurable; the test measured it.
    ///
    /// SO IT IS MINIMUM STATISTICS, which is how noise floors are actually
    /// estimated. The quietest frame in each short block is remembered, and the
    /// floor is the quietest of the last several blocks. Nothing is quieter than
    /// the room, so the minimum over a window longer than any sentence IS the
    /// room — no speech decision is involved, so there is nothing to be circular
    /// about, and a voice cannot raise it because a voice is never the minimum.
    ///
    /// The window has to be longer than the longest plausible unbroken speech
    /// and shorter than a person's patience for a room that changed. Sixteen
    /// seconds is comfortably both.
    fn learn(&mut self, level: f32) {
        self.block_min = self.block_min.min(level);
        self.block_frames += 1;
        if self.block_frames >= BLOCK_FRAMES {
            self.blocks[self.block_at] = self.block_min;
            self.block_at = (self.block_at + 1) % BLOCKS;
            self.block_min = f32::MAX;
            self.block_frames = 0;
        }
        let quietest = self
            .blocks
            .iter()
            .copied()
            .fold(f32::MAX, f32::min)
            // The block still filling counts too, so a room that just went quiet
            // is believed within one block rather than after the whole window.
            .min(self.block_min);
        self.noise = quietest.max(self.cfg.floor);
    }

    pub fn speaking(&self) -> bool {
        self.speaking
    }

    /// How long the current utterance has run, in milliseconds.
    pub fn speech_ms(&self) -> u32 {
        self.spoken * 20
    }

    /// The learned room level, for the diagnostics panel.
    pub fn noise_floor(&self) -> f32 {
        self.noise
    }

    /// Forget the utterance but keep what has been learned about the room.
    pub fn reset(&mut self) {
        self.speaking = false;
        self.loud_run = 0;
        self.quiet_run = 0;
        self.spoken = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence() -> Vec<i16> {
        vec![0; FRAME]
    }

    /// A frame of noise at roughly this fraction of full scale.
    fn tone(level: f32) -> Vec<i16> {
        let amp = (level * 32767.0 * std::f32::consts::SQRT_2) as i16;
        (0..FRAME)
            .map(|i| if i % 2 == 0 { amp } else { -amp })
            .collect()
    }

    fn feed(vad: &mut Vad, frame: &[i16], times: usize) -> Vec<Event> {
        (0..times).map(|_| vad.push(frame)).collect()
    }

    /// Speech, shaped like speech: bursts with the gaps between words in them.
    ///
    /// A CONSTANT TONE IS NOT A PROXY FOR A VOICE, and two tests learned that
    /// the hard way. With a minimum-statistics floor, an unbroken sound with
    /// nothing quieter anywhere near it IS the room, by definition, and the
    /// detector is right to say so. Real speech dips to near-silence between
    /// words several times a second, and those dips are what make it
    /// distinguishable from a fan at the same loudness.
    fn speech(vad: &mut Vad, level: f32, words: usize) -> Vec<Event> {
        let loud = tone(level);
        let gap = silence();
        let mut events = Vec::new();
        for _ in 0..words {
            events.extend(feed(vad, &loud, 12));
            events.extend(feed(vad, &gap, 3));
        }
        events
    }

    #[test]
    fn a_silent_room_is_never_speech() {
        let mut vad = Vad::default();
        let events = feed(&mut vad, &silence(), 200);
        assert!(events.iter().all(|e| *e == Event::Quiet));
        assert!(!vad.speaking());
    }

    #[test]
    fn a_voice_starts_speech() {
        let mut vad = Vad::default();
        feed(&mut vad, &silence(), 50);
        let events = speech(&mut vad, 0.05, 2);
        assert!(events.contains(&Event::Started), "{events:?}");
        assert!(vad.speaking());
    }

    // A click is shorter than start_frames, and a detector that fires on one
    // wakes up every time somebody types.
    #[test]
    fn a_single_click_is_not_speech() {
        let mut vad = Vad::default();
        feed(&mut vad, &silence(), 50);
        let mut events = feed(&mut vad, &tone(0.4), 2);
        events.extend(feed(&mut vad, &silence(), 10));
        assert!(!events.contains(&Event::Started), "{events:?}");
    }

    #[test]
    fn speech_ends_after_the_hangover_and_not_before() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        feed(&mut vad, &silence(), 50);
        speech(&mut vad, 0.05, 2);
        // `speech` ends on its between-words gap, and the hangover counts from
        // the last LOUD frame — so a few more loud frames first, or the count
        // below would start three frames in and this would look like an early
        // end when it is the helper's trailing silence.
        feed(&mut vad, &tone(0.05), 3);
        assert!(vad.speaking());

        // One frame short of the hangover: still speaking.
        let during = feed(&mut vad, &silence(), (cfg.hangover_frames - 1) as usize);
        assert!(
            !during.contains(&Event::Ended),
            "ended too early: {during:?}"
        );
        assert!(vad.speaking());

        // The next one ends it.
        assert_eq!(vad.push(&silence()), Event::Ended);
        assert!(!vad.speaking());
    }

    // People pause mid-sentence. A detector that ends on the first quiet frame
    // ends halfway through what somebody was saying.
    #[test]
    fn a_thinking_pause_does_not_end_a_sentence() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        feed(&mut vad, &silence(), 50);
        speech(&mut vad, 0.05, 2);

        // 300 ms of pause, well inside the hangover.
        let pause = feed(&mut vad, &silence(), 15);
        assert!(!pause.contains(&Event::Ended), "{pause:?}");

        // And it picks straight back up.
        let more = feed(&mut vad, &tone(0.05), 5);
        assert!(more.iter().all(|e| *e == Event::Speaking), "{more:?}");
        assert!(vad.speaking());
    }

    // The whole point of an adaptive floor: the same voice in a noisy room.
    #[test]
    fn a_quiet_voice_in_a_noisy_room_is_still_heard() {
        let mut vad = Vad::default();
        // A room that is already noisy when the microphone opens. This is the
        // case the first version of `learn` could never escape.
        feed(&mut vad, &tone(0.02), 4000);
        assert!(
            vad.noise_floor() > 0.005,
            "floor did not rise: {}",
            vad.noise_floor()
        );
        assert!(!vad.speaking(), "the room is still being heard as a person");

        // A voice above that room is speech, even though a fixed threshold set
        // for a quiet room would have been crossed by the room itself.
        let events = feed(&mut vad, &tone(0.12), 10);
        assert!(events.contains(&Event::Started), "{events:?}");
    }

    /// THE BUG TWO TESTS FOUND, kept as a test of its own.
    ///
    /// Open the microphone in a room that is already loud. When the floor only
    /// learned from frames already judged quiet, every frame read as speech, so
    /// no frame was ever quiet, so the floor never moved and the room stayed
    /// "speech" forever — nothing downstream would ever have been released.
    ///
    /// With a minimum-statistics floor it is better than fixed: an unbroken
    /// sound is recognised as the room and never becomes speech at all.
    #[test]
    fn a_room_that_is_loud_from_the_first_frame_is_never_speech() {
        let mut vad = Vad::default();
        let events = feed(&mut vad, &tone(0.03), 4000);
        assert!(
            !events.contains(&Event::Started),
            "the room became a person"
        );
        assert!(!vad.speaking());
        assert!(vad.noise_floor() > 0.005, "{}", vad.noise_floor());
    }

    #[test]
    fn an_utterance_cannot_run_forever() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        feed(&mut vad, &silence(), 100);
        feed(&mut vad, &tone(0.5), 5);
        assert!(vad.speaking());
        let events = feed(&mut vad, &tone(0.5), cfg.max_speech_frames as usize + 10);
        assert!(events.contains(&Event::Ended), "it never stopped");
    }

    #[test]
    fn the_floor_drops_quickly_when_a_room_goes_quiet() {
        let mut vad = Vad::default();
        feed(&mut vad, &tone(0.02), 4000);
        let loud = vad.noise_floor();
        feed(&mut vad, &silence(), 60);
        assert!(
            vad.noise_floor() < loud / 10.0,
            "{} -> {}",
            loud,
            vad.noise_floor()
        );
    }

    // Not "does not move at all" — it must move, or a room that changed under a
    // stuck utterance could never be learned. It must move far too little to
    // matter across one sentence.
    #[test]
    fn one_sentence_cannot_drag_the_floor_up_into_itself() {
        let mut vad = Vad::default();
        feed(&mut vad, &silence(), 200);
        let before = vad.noise_floor();
        feed(&mut vad, &tone(0.05), 5);
        assert!(vad.speaking());
        // Ten seconds of talking, which is a long sentence.
        feed(&mut vad, &tone(0.05), 500);
        let after = vad.noise_floor();
        assert!(
            after < before * 4.0,
            "the floor climbed into the voice: {before} -> {after}"
        );
        assert!(vad.speaking(), "it cut the speaker off");
    }

    #[test]
    fn the_floor_never_falls_below_its_minimum() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        feed(&mut vad, &silence(), 2000);
        assert!(vad.noise_floor() >= cfg.floor);
    }

    // Hysteresis: a sound hovering between the two ratios must not toggle.
    #[test]
    fn a_borderline_level_does_not_flicker() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        feed(&mut vad, &silence(), 100);
        let floor = vad.noise_floor();
        // Start it properly, then drop to between keep_ratio and start_ratio.
        feed(&mut vad, &tone(floor * 6.0), 6);
        assert!(vad.speaking());
        let between = tone(floor * 2.0);
        let events = feed(&mut vad, &between, 100);
        assert!(!events.contains(&Event::Ended), "flickered: {events:?}");
        assert!(vad.speaking());
    }

    #[test]
    fn speech_ms_counts_the_current_utterance_only() {
        let mut vad = Vad::default();
        feed(&mut vad, &silence(), 50);
        speech(&mut vad, 0.05, 2);
        let first = vad.speech_ms();
        assert!(first >= 200, "{first}");
        feed(&mut vad, &silence(), 40);
        assert!(!vad.speaking());
        assert_eq!(vad.speech_ms(), 0);
    }

    #[test]
    fn reset_forgets_the_utterance_and_keeps_the_room() {
        let mut vad = Vad::default();
        feed(&mut vad, &tone(0.02), 4000);
        feed(&mut vad, &tone(0.2), 10);
        assert!(vad.speaking());
        // Measured either side of the reset itself, not across audio: `learn`
        // runs on every frame by design, so comparing across frames would be
        // testing the estimator rather than what reset does.
        let floor = vad.noise_floor();
        vad.reset();
        assert!(!vad.speaking());
        assert_eq!(vad.noise_floor(), floor, "reset threw away the room");
    }

    #[test]
    fn an_empty_frame_is_silence_rather_than_a_panic() {
        assert_eq!(Vad::level(&[]), 0.0);
        let mut vad = Vad::default();
        assert_eq!(vad.push(&[]), Event::Quiet);
    }

    #[test]
    fn level_is_a_fraction_of_full_scale() {
        assert!(Vad::level(&vec![0; FRAME]).abs() < 1e-6);
        let full = Vad::level(&vec![i16::MAX; FRAME]);
        assert!((full - 1.0).abs() < 0.01, "{full}");
    }

    // A stream that opens mid-sentence must still hear the voice. It can,
    // because speech has gaps in it and a fan does not — which is exactly what
    // separates the two when the floor is a minimum rather than an average.
    #[test]
    fn starting_while_somebody_is_already_talking_still_works() {
        let mut vad = Vad::default();
        let events = speech(&mut vad, 0.08, 3);
        assert!(events.contains(&Event::Started), "{events:?}");
    }
}
