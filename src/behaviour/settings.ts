/**
 * Knobs for the ambient layer. Ported from `BehaviourSettings` in
 * `CompanionBehaviour.swift`.
 *
 * Plain values on purpose: the app owns the menu and the preferences file, this
 * module owns the behaviour. Nothing here reads or writes storage.
 */

/** An inclusive range of seconds, matching the Swift's `ClosedRange<Double>`. */
import { DEFAULT_LISTEN_MODE, type ListenMode } from "../voice/mode";
import { DEFAULT_ENGINE, type EngineId } from "../voice/engine";

export interface SecondsRange {
  readonly min: number;
  readonly max: number;
}

export interface BehaviourSettings {
  /** Curling up into a loaf. On — it is, after all, the name of the app. */
  loafing: boolean;
  /** The fur ball. */
  playing: boolean;
  /**
   * Walking the window to a different spot on the screen.
   *
   * **Off, deliberately.** The user put the window where it is. A pet that
   * starts crossing a screen someone is working on, unasked, is a bug report —
   * so this is the one behaviour they have to switch on themselves.
   */
  wandering: boolean;

  /** Seconds of uninterrupted idling between loaves, and how long one lasts. */
  loafEvery: SecondsRange;
  loafFor: SecondsRange;
  /**
   * Seconds between games. Rarer than loafing, because it moves and movement
   * costs attention.
   */
  playEvery: SecondsRange;
  /** Seconds between walks. */
  wanderEvery: SecondsRange;
  /** How far from the spot the user actually put him he may ever get. */
  wanderLeash: number;
  /**
   * Points per second. Ambient, not a screensaver: about four seconds to cross
   * one window-width, with an ease in and out on top.
   */
  wanderSpeed: number;

  /**
   * Ghosts drift. **On by default**, unlike wandering — this is not a
   * permission the user grants a walker, it is what the character is, and
   * someone who picks a ghost and gets a stationary one has been sold the wrong
   * thing. Still switchable, for anyone who wants the ghost without the motion.
   */
  drifting: boolean;
  /**
   * Fade until the cursor is on him.
   *
   * An always-on-top companion sits over whatever is underneath, and on a busy
   * desktop that is usually something you were reading. Faded, the text and
   * icons behind him stay legible; hovering brings him back to solid.
   */
  fading: boolean;
  /** Whether hovering shows today's card, or only wakes him up. */
  preview: boolean;
  /**
   * Whether Loaf speaks its bubbles aloud.
   *
   * OFF by default, unlike every other habit here. The rest change how a
   * small character moves in the corner of a screen; this one makes noise
   * in a room, and a pet that started talking on first launch would be
   * uninstalled before it finished the sentence.
   */
  talking: boolean;
  /**
   * When the microphone may be opened at all.
   *
   * A mode rather than a switch, because "whether" is not the interesting
   * question and "when" is. See voice/mode.ts. This must never gain a
   * default other than off: it is the one setting that contradicts the
   * whole pitch, and it is only defensible while deliberately chosen.
   */
  listenMode: ListenMode;
  /**
   * A wake word of the user's own, or null for the built-in ones.
   *
   * Stored raw as typed; `normaliseWakeWord` decides whether it is usable
   * and the grammar is built from the result, so an unusable one falls back
   * to the defaults rather than leaving Loaf deaf.
   */
  wakeWord: string | null;
  /**
   * How long the cursor must rest on Loaf before the microphone opens.
   *
   * Much longer than the preview card's dwell, and settable, because this is
   * the difference between a deliberate hold and walking the cursor past him
   * on the way to something else.
   */
  hoverListenMs: number;
  /** Which recogniser turns speech into text. See voice/engine.ts. */
  engine: EngineId;
  /**
   * How many days transcripts are kept, or 0 for "until you delete them".
   *
   * Governs the WORDS, not the audio — recordings are deleted the moment they
   * have been transcribed. See meetings.ts.
   */
  transcriptRetentionDays: number;
  /** Path to a whisper.cpp executable. Empty until the user sets it. */
  whisperBinary: string;
  /** Path to a ggml model file. Empty until the user sets it. */
  whisperModel: string;
  /**
   * Barely a pause: drift is meant to look continuous, so one leg starts about
   * as soon as the last ends.
   */
  driftEvery: SecondsRange;
  /**
   * A longer rope than a walker gets. It is untethered by nature, and a ghost
   * that only ever haunts one corner of the screen is not haunting anything.
   */
  driftLeash: number;
  /** Slower than walking. Points per second. */
  driftSpeed: number;
}

export function defaultBehaviourSettings(): BehaviourSettings {
  return {
    loafing: true,
    playing: true,
    wandering: false,
    loafEvery: { min: 70, max: 210 },
    loafFor: { min: 16, max: 48 },
    playEvery: { min: 170, max: 430 },
    wanderEvery: { min: 110, max: 260 },
    wanderLeash: 170,
    wanderSpeed: 32,
    drifting: true,
    /**
     * Fade to a ghost of himself until you look at him.
     *
     * ON by default, and that is the whole point of the feature: an always-on
     * companion sits over whatever is underneath it, and on a busy desktop the
     * thing underneath is usually something you were reading. Faded, the text
     * and icons behind him stay legible; hovering brings him back to solid.
     */
    fading: true,
    /** Whether hovering shows today's card, or just wakes him up. */
    preview: true,
    talking: false,
    listenMode: DEFAULT_LISTEN_MODE,
    wakeWord: null,
    hoverListenMs: 5000,
    engine: DEFAULT_ENGINE,
    // Forever by default: deleting someone's notes on a schedule they did not
    // ask for is the worse of the two failures.
    transcriptRetentionDays: 0,
    whisperBinary: "",
    whisperModel: "",
    driftEvery: { min: 0.3, max: 2.0 },
    driftLeash: 330,
    driftSpeed: 17,
  };
}
