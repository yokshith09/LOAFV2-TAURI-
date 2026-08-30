import type { Mood } from "../core/types";

/**
 * Which face to wear. Ported from `CompanionView.mood`.
 *
 * A function of its inputs and nothing else, so the precedence can be tested
 * rather than inferred by reading four scattered `if`s in the render loop —
 * which is where it lived until it turned out that two of the rungs had never
 * been connected to anything.
 *
 * The reference's order, with the rungs whose features are not ported marked
 * rather than quietly dropped:
 *
 *   1. hovering  -> happy      petting calms even a tantrum
 *   2. tabAlert  -> tantrum    too many tabs open, per the privacy radar
 *   3. proud                   you closed enough tabs to end a tantrum
 *   4. override                the break nudge, and whatever speaks next
 *   5. scrolling               the wheel has been moving
 *   6. sleeping                away from the keyboard past the idle threshold
 *   7. idle
 */
export interface MoodInputs {
  /** The cursor is over the companion. */
  readonly hovering: boolean;
  /** The radar is reporting more tabs than the threshold allows. */
  readonly tabAlert: boolean;
  /**
   * Briefly, after closing enough tabs to end a tantrum.
   *
   * Above the spoken line so the praise and the face agree — it would be odd to
   * be told "thank you, genuinely" by something looking worried.
   */
  readonly proud: boolean;
  /** Forced while something is being said. */
  readonly override: Mood | null;
  /** Enough recent wheel movement to strike the pose. See behaviour/scroll.ts. */
  readonly scrolling: boolean;
  /** The tracker reported an idle tick. */
  readonly sleeping: boolean;
  /** The alt-click development cycle. Below every real signal. */
  readonly debug: Mood | null;
}

export function resolveMood(inputs: MoodInputs): Mood {
  if (inputs.hovering) return "happy";
  if (inputs.tabAlert) return "tantrum";
  if (inputs.proud) return "proud";
  if (inputs.override !== null) return inputs.override;
  if (inputs.scrolling) return "scrolling";
  if (inputs.sleeping) return "sleeping";
  return inputs.debug ?? "idle";
}
