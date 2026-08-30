import {
  VOICES,
  RETRIGGER_FLOOR_MS,
  isAudible,
  defaultSoundSettings,
  type Occasion,
  type SoundSettings,
} from "./voice";
import type { SettingsStore } from "../closet/settings";

/**
 * Making the noise. The half of `SoundKit.swift` that touches the speakers.
 *
 * Split from `voice.ts` so everything about *what* a sound is and *whether* it
 * is allowed stays testable in Node, and only the few lines that need a
 * `AudioContext` live here.
 */

/**
 * The narrow slice of Web Audio this needs, so it can be stubbed in a test.
 *
 * Derived from `AudioContext` with `Pick` rather than written out by hand. The
 * hand-written version declared a `now()` method, which Web Audio does not have
 * — it has a `currentTime` property — and because the test stub implemented the
 * interface rather than the real API, eighteen tests passed against something
 * that threw on the first note in a real browser. Deriving it means a name that
 * does not exist is a compile error.
 */
export type AudioHost = Pick<
  AudioContext,
  "currentTime" | "createOscillator" | "createGain" | "destination" | "resume" | "state"
>;

const K_MUTED = "sound.muted";
const K_CHIME = "sound.focusChime";

export function loadSoundSettings(store: SettingsStore): SoundSettings {
  const settings = defaultSoundSettings();
  settings.muted = store.getItem(K_MUTED) === "1";
  // Absent means on. A chime that switched itself off because a key was missing
  // would look like the timer had stopped working.
  settings.focusChime = store.getItem(K_CHIME) !== "0";
  return settings;
}

export function saveSoundSettings(store: SettingsStore, s: SoundSettings): void {
  store.setItem(K_MUTED, s.muted ? "1" : "0");
  store.setItem(K_CHIME, s.focusChime ? "1" : "0");
}

export class SoundKit {
  settings: SoundSettings;
  private lastPlayed = new Map<Occasion, number>();
  private context: AudioHost | null = null;
  private readonly now: () => number;
  private readonly makeContext: (() => AudioHost) | null;

  /**
   * User-supplied sounds, by occasion, as playable URLs.
   *
   * Theirs win over ours — the whole point of the folder. Loaded by the caller,
   * because reading a directory is the platform's business and this class only
   * knows how to make a noise.
   */
  userSounds = new Map<Occasion, string>();

  constructor(
    opts: {
      now?: () => number;
      context?: () => AudioHost;
      settings?: SoundSettings;
    } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.makeContext = opts.context ?? null;
    this.settings = opts.settings ?? defaultSoundSettings();
  }

  /**
   * Whether this request should make a noise at all.
   *
   * Separate from `play` so the throttle can be tested without an audio stack,
   * and so the decision is one function rather than a chain of early returns
   * scattered through the playing code.
   */
  claim(occasion: Occasion): boolean {
    if (!isAudible(this.settings, occasion)) return false;
    const last = this.lastPlayed.get(occasion);
    const now = this.now();
    if (last !== undefined && now - last < RETRIGGER_FLOOR_MS) return false;
    this.lastPlayed.set(occasion, now);
    return true;
  }

  play(occasion: Occasion): void {
    if (!this.claim(occasion)) return;

    const custom = this.userSounds.get(occasion);
    if (custom !== undefined) {
      // Theirs, not ours. No Web Audio involved — an <audio> element handles
      // every format the webview knows, which is more than this could decode.
      const audio = new Audio(custom);
      audio.volume = 0.7;
      void audio.play().catch(() => {
        // A file that will not decode is the user's to fix, and a broken sound
        // must not take the event that triggered it down with it.
      });
      return;
    }

    this.synthesise(occasion);
  }

  private synthesise(occasion: Occasion): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    // Browsers suspend an audio context created before any user gesture. A pet
    // that went permanently silent because its first noise happened to be a
    // timer rather than a click would be very hard to diagnose.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    const start = ctx.currentTime;
    for (const note of VOICES[occasion]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.wave;
      osc.frequency.setValueAtTime(note.from, start + note.at);
      if (note.to !== note.from) {
        osc.frequency.linearRampToValueAtTime(note.to, start + note.at + note.seconds);
      }
      // An envelope, not a square gate: an oscillator switched on and off at
      // full gain clicks at both ends, and the click is louder than the note.
      gain.gain.setValueAtTime(0, start + note.at);
      gain.gain.linearRampToValueAtTime(note.gain, start + note.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + note.at + note.seconds,
      );
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start + note.at);
      osc.stop(start + note.at + note.seconds + 0.02);
    }
  }

  private ensureContext(): AudioHost | null {
    if (this.context) return this.context;
    try {
      // No audio device, or a webview without Web Audio. Silence is the correct
      // failure here; nothing above this should have to care, and a pet that
      // threw out of a click handler because the machine has no speakers would
      // take the click with it.
      // No cast: `AudioHost` is a subset of `AudioContext`, so this only
      // compiles while the two genuinely agree.
      this.context = this.makeContext ? this.makeContext() : new AudioContext();
      return this.context;
    } catch {
      return null;
    }
  }
}
