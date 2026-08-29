/**
 * Knobs for the ambient layer. Ported from `BehaviourSettings` in
 * `CompanionBehaviour.swift`.
 *
 * Plain values on purpose: the app owns the menu and the preferences file, this
 * module owns the behaviour. Nothing here reads or writes storage.
 */

/** An inclusive range of seconds, matching the Swift's `ClosedRange<Double>`. */
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
    driftEvery: { min: 0.3, max: 2.0 },
    driftLeash: 330,
    driftSpeed: 17,
  };
}
