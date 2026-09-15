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
 *   1. hovering  -> happy      petting calms even a tantrum, even a sleeping one
 *   2. sleeping                asleep is ONE face, full stop — see below
 *   3. tabAlert  -> tantrum    too many tabs open, per the privacy radar
 *   4. proud                   you closed enough tabs to end a tantrum
 *   5. override                the break nudge, and whatever speaks next
 *   6. scrolling               the wheel has been moving
 *   7. idle
 *
 * SLEEPING RANKS SECOND, RIGHT UNDER PETTING, and that used to be a bug in the
 * other direction: it sat second from the BOTTOM, so an MCP call or a tantrum
 * would visibly wake the face — the mood flipped to `thinking` or `tantrum`
 * with no bubble to explain why, since `say()` already silences the bubble
 * during sleep. A character that reacts to things you cannot see it react to
 * is not "quietly staying in the corner." Waking now has to be a real wake:
 * the user taps him, or turns sleep off. See `toldToSleep` in main.ts.
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
  /** Keys have gone down recently. Timing only — see scroll.rs. */
  readonly typing: boolean;
  /**
   * An assistant is asking Loaf something right now.
   *
   * ABOVE typing and scrolling, unlike `working` below it, and that ordering is
   * the whole reason this is a separate input. The two co-occur almost by
   * definition: you are typing TO the assistant while it reads your day, so
   * ranked with `working` this face never once appeared — the bubble showed and
   * the character carried on with its keyboard out.
   */
  readonly claudeThinking: boolean;
  /** The foreground application is working hard. See behaviour/working.ts. */
  readonly working: boolean;
  /** The tracker reported an idle tick. */
  readonly sleeping: boolean;
  /**
   * The alt-click development cycle.
   *
   * Below the signals worth seeing for real even while previewing art —
   * hovering, asleep, a tantrum, having just earned "proud", a spoken line —
   * but ABOVE the merely ambient ones: an assistant reading your day,
   * scrolling, typing, the machine working. It used to sit under every real
   * signal without exception, and `typing` alone made it nearly impossible
   * to use for its actual job: describing out loud what mood you are looking
   * at is typing, which used to win outright, so the cycle never visibly
   * advanced past whatever the room around it happened to be doing.
   * Hovering stays above it deliberately — "petting calms even a tantrum"
   * has to keep meaning a REAL hand on the character, not an artifact of the
   * click that started the preview — so to actually see a cycled mood, move
   * the pointer off the character after clicking.
   */
  readonly debug: Mood | null;
}

export function resolveMood(inputs: MoodInputs): Mood {
  if (inputs.hovering) return "happy";
  // Second, not seventh. Every rung below this one is an ACTIVITY — the
  // machine is busy, an assistant is reading, tabs piled up, you closed
  // enough of them — and none of that is what "asleep" means to look at.
  if (inputs.sleeping) return "sleeping";
  if (inputs.tabAlert) return "tantrum";
  if (inputs.proud) return "proud";
  if (inputs.override !== null) return inputs.override;
  // Above every ambient signal below — see the note on `debug` above for why
  // an explicit developer action has to win here or it cannot be previewed
  // at all while doing anything else, typing included.
  if (inputs.debug !== null) return inputs.debug;
  // Above both of the absorbed poses. Someone else reading your history is a
  // fact about the world; you scrolling is a fact about you, and the first one
  // is the one you cannot otherwise see.
  if (inputs.claudeThinking) return "thinking";
  if (inputs.scrolling) return "scrolling";
  // Typing outranks working: if you are at the keys, the interesting fact is
  // that YOU are busy, not that the machine is. They co-occur constantly —
  // every keystroke in an editor costs CPU — and this is which one wins.
  if (inputs.typing) return "typing";
  if (inputs.working) return "working";
  return "idle";
}
