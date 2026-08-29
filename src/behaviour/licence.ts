import type { Mood } from "../core/types";

/**
 * What the ambient layer is allowed to do at this instant.
 *
 * Ported from `BehaviourLicence` in `CompanionBehaviour.swift`. This is the one
 * place the precedence is written down, and it deliberately resolves in the
 * same order the mood system does — that is the order a person watching the
 * window perceives, so if the two ever disagree the character reads as
 * glitching rather than as busy. Change one, change the other.
 *
 * Highest precedence first:
 *
 * 1. **Tantrum.** Too many tabs. Nothing ambient runs and everything in flight
 *    winds up: no loafing through a tantrum, no ball, and above all no moving
 *    the window while he is shouting at you.
 * 2. **Being touched.** A drag is the user placing the window; never animate it
 *    out from under them, and never start anything mid-gesture. A curl survives
 *    a pet.
 * 3. **The app is talking.** A break nudge, praise for closing tabs, a speech
 *    bubble or any other window. He gets up and listens — an ambient pose on
 *    top of a message reads as him ignoring it.
 * 4. **Scrolling.** He is holding the scroll in both paws; the loaf would draw
 *    straight through it.
 * 5. **A focus session about to land.** The last half-minute belongs to it.
 * 6. **Asleep.** You are away. He may stay curled — and fall asleep like that,
 *    which is the correct end of a loaf — but starting a game of fetch for an
 *    empty chair is silly.
 * 7. **Idle.** Anything goes, except that a *running* focus session still rules
 *    out the two loud ones: the ball would roll over the floor ring, and a
 *    window that walks off while you are deliberately not looking at it is the
 *    worst thing this module could do.
 */
export interface BehaviourLicence {
  /** A loaf may begin, or a loaf in progress may continue. */
  readonly mayCurl: boolean;
  /** The ball may roll in, or a game already going may continue. */
  readonly mayPlay: boolean;
  /** The window may move. */
  readonly mayWander: boolean;
  /**
   * Something *new* may start. Separate from the three above so a behaviour can
   * be allowed to finish gracefully without being allowed to begin again.
   */
  readonly mayBegin: boolean;
}

/**
 * The subset of a running focus session the precedence rules care about.
 *
 * Declared here rather than imported so the licence can be reasoned about — and
 * tested — before the focus timer exists. The timer will satisfy this shape.
 */
export interface FocusDisplay {
  /** Seconds left on the clock. */
  readonly remaining: number;
  readonly paused: boolean;
}

export interface LicenceInputs {
  readonly mood: Mood;
  readonly hovering: boolean;
  readonly dragging: boolean;
  /** null when no session is running. */
  readonly focus: FocusDisplay | null;
  /** A speech bubble or anything else that is currently talking to the user. */
  readonly held: boolean;
  /**
   * Deliberately narrow: it stops the *window* moving while the dashboard, the
   * closet or anything else of ours is up, and nothing else. It is detected
   * rather than declared, so it errs toward true — and an over-eager true only
   * ever costs the opt-in behaviour, never the loaf.
   */
  readonly otherWindows: boolean;
}

const NOTHING: BehaviourLicence = {
  mayCurl: false,
  mayPlay: false,
  mayWander: false,
  mayBegin: false,
};

const CURL_ONLY: BehaviourLicence = {
  mayCurl: true,
  mayPlay: false,
  mayWander: false,
  mayBegin: false,
};

/** Pure, so the precedence can be reasoned about (and tested) on its own. */
export function resolveLicence(input: LicenceInputs): BehaviourLicence {
  const { mood, hovering, dragging, focus, held, otherWindows } = input;

  if (mood === "tantrum") return NOTHING;
  if (dragging) return CURL_ONLY;
  if (held || mood === "worried" || mood === "proud") return NOTHING;
  if (mood === "scrolling") return NOTHING;
  if (focus && !focus.paused && focus.remaining <= 30) return CURL_ONLY;
  if (mood === "sleeping") return CURL_ONLY;
  if (hovering) {
    return { mayCurl: true, mayPlay: true, mayWander: false, mayBegin: false };
  }

  const focusing = focus !== null;
  return {
    mayCurl: true,
    mayPlay: !focusing,
    mayWander: !focusing && !otherWindows,
    mayBegin: true,
  };
}

/** Convenience for callers that only need to vary a field or two. */
export function licenceInputs(over: Partial<LicenceInputs> = {}): LicenceInputs {
  return {
    mood: "idle",
    hovering: false,
    dragging: false,
    focus: null,
    held: false,
    otherWindows: false,
    ...over,
  };
}
