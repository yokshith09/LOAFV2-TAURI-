/**
 * What Loaf sounds like. Ported from `SoundKit.swift`.
 *
 * THE REFERENCE SHIPS NO AUDIO EITHER — "not one byte", in its own words. Its
 * per-species voices are stock macOS system sounds standing in for recordings
 * that do not exist, every one marked PLACEHOLDER. There is no equivalent stock
 * set on Windows, so the stand-ins here are synthesised instead: four short
 * shapes built from oscillators, chosen to be roughly right rather than
 * convincing, and replaced the day anyone hands us a real `meow.wav`.
 *
 * The rule the reference opens with is the one that survives intact: the
 * companion is allowed to make a noise, and the user is allowed to decide what
 * that noise is. Everything here is machinery for getting out of their way.
 */

/**
 * The moments that can make a noise.
 *
 * The string doubles as the filename in the user's Sounds folder, so a new case
 * is all it takes to make `<token>.wav` work — nothing else parses these.
 */
export const OCCASIONS = ["finish", "tantrum", "praise", "greeting"] as const;
export type Occasion = (typeof OCCASIONS)[number];

export function isOccasion(v: unknown): v is Occasion {
  return typeof v === "string" && (OCCASIONS as readonly string[]).includes(v);
}

/** One line of the folder's README, kept beside the case so the two cannot drift. */
export const OCCASION_NOTES: Readonly<Record<Occasion, string>> = {
  finish: "a focus session ended",
  tantrum: "too many tabs, and I start sulking",
  praise: "you closed enough of them",
  greeting: "you clicked me",
};

/**
 * A second request for the same occasion inside this window is dropped.
 *
 * A double-click delivers two clicks, and two greetings a millisecond apart is
 * a glitch rather than a feature.
 */
export const RETRIGGER_FLOOR_MS = 250;

/** One note of a synthesised placeholder. */
export interface Note {
  /** Hz at the start of the note. */
  readonly from: number;
  /** Hz at the end. Equal to `from` for a flat tone. */
  readonly to: number;
  /** Seconds from the start of the sound. */
  readonly at: number;
  readonly seconds: number;
  readonly gain: number;
  readonly wave: OscillatorType;
}

/**
 * The four placeholders.
 *
 * PLACEHOLDERS, in the reference's exact sense: shaped to read as the right
 * *kind* of noise, not to be the real thing. Kept as data rather than code so
 * they can be inspected and tested without an audio context anywhere.
 *
 * `finish` is a rising two-note chime because that is what a timer ending has
 * always sounded like in this app, and quietly changing that while adding a
 * feature would be a change nobody asked for.
 */
export const VOICES: Readonly<Record<Occasion, readonly Note[]>> = {
  finish: [
    { from: 660, to: 660, at: 0, seconds: 0.13, gain: 0.16, wave: "sine" },
    { from: 990, to: 990, at: 0.12, seconds: 0.3, gain: 0.16, wave: "sine" },
  ],
  // Downward, and a little sour: this one is a complaint.
  tantrum: [
    { from: 300, to: 170, at: 0, seconds: 0.26, gain: 0.13, wave: "triangle" },
    { from: 220, to: 140, at: 0.16, seconds: 0.26, gain: 0.1, wave: "triangle" },
  ],
  // Upward and brief. Praise that outstays its welcome stops being praise.
  praise: [
    { from: 520, to: 780, at: 0, seconds: 0.18, gain: 0.14, wave: "sine" },
  ],
  // A single soft blip — this fires on every click, so it has to be ignorable.
  greeting: [{ from: 440, to: 560, at: 0, seconds: 0.09, gain: 0.09, wave: "sine" }],
};

/** How long a sound runs, in seconds. Used to size the offline render in tests. */
export function durationOf(occasion: Occasion): number {
  return VOICES[occasion].reduce((end, n) => Math.max(end, n.at + n.seconds), 0);
}

export interface SoundSettings {
  /** Global mute. Off by default; the companion is allowed one noise per event. */
  muted: boolean;
  /**
   * The focus chime's own switch.
   *
   * Separate from mute rather than folded into it, as in the reference: two
   * controls that both believe they own the chime is how a preference ends up
   * fighting itself. Mute is a second gate on top, not a replacement.
   */
  focusChime: boolean;
}

export function defaultSoundSettings(): SoundSettings {
  return { muted: false, focusChime: true };
}

/**
 * Whether this occasion would be heard at all.
 *
 * Deliberately separate from choosing *which* sound to play: that question has
 * no opinion about whether it plays.
 */
export function isAudible(settings: SoundSettings, occasion: Occasion): boolean {
  if (settings.muted) return false;
  if (occasion === "finish") return settings.focusChime;
  return true;
}
