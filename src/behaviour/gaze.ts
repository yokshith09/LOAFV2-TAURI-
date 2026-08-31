/**
 * Where the character is looking.
 *
 * The pupils drift toward the pointer when it is near, so a still character
 * still reads as awake. This is the cheapest possible "alive" signal: no
 * animation budget, no new art, one vector.
 *
 * WHAT THIS IS NOT. It is not input monitoring. The platform is asked one
 * question — "where is the cursor right now" — which is the same question any
 * window asks to draw a hover state, needs no permission on either OS, and says
 * nothing about what is being clicked, typed or looked at. Nothing is stored;
 * the answer is used for one frame and replaced by the next one. See
 * `scroll.rs` for the same argument made about the wheel.
 */

import type { Point } from "../core/types";

/** How far from the character the pointer can be and still be worth following. */
export const GAZE_RANGE_PX = 420;

/**
 * How far the pupil travels inside the socket, as a fraction of its radius.
 *
 * Small on purpose. Eyes that swing the full width of the socket look
 * possessed rather than attentive, and the reference's own faces move very
 * little — the effect reads at a glance because it is a change from perfectly
 * still, not because it is large.
 */
export const GAZE_TRAVEL = 0.42;

/** A look direction, each component in -1..1. `{x:0,y:0}` is straight ahead. */
export interface Gaze {
  readonly x: number;
  readonly y: number;
}

export const LOOKING_AHEAD: Gaze = { x: 0, y: 0 };

/**
 * Turn a cursor position into a look direction.
 *
 * Both points are in the same screen space; the caller decides whether that is
 * physical or logical pixels, as long as it does not mix them.
 *
 * Falls off with distance rather than snapping to full deflection: a pointer
 * crossing the far side of the screen should not yank the eyes to their
 * corners, and a pointer that has wandered off entirely should return them
 * gently to centre rather than leaving them staring at the last place it was.
 */
export function gazeToward(
  cursor: Point | null,
  faceCentre: Point,
  range = GAZE_RANGE_PX,
): Gaze {
  if (cursor === null || range <= 0) return LOOKING_AHEAD;

  const dx = cursor.x - faceCentre.x;
  const dy = cursor.y - faceCentre.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return LOOKING_AHEAD;

  // Direction is a unit vector; strength is how much of it to apply.
  const strength = Math.max(0, 1 - distance / range);
  if (strength === 0) return LOOKING_AHEAD;

  return { x: (dx / distance) * strength, y: (dy / distance) * strength };
}

/**
 * Ease the eyes toward a new direction instead of teleporting them.
 *
 * A pointer moves in jumps of tens of pixels between frames, and pupils that
 * tracked it exactly would jitter. This is the same shape as the scroll
 * energy's rise and decay, for the same reason.
 *
 * @param dt seconds since the last call.
 * @param rate how much of the remaining distance to close per second.
 */
export function easeGaze(from: Gaze, to: Gaze, dt: number, rate = 8): Gaze {
  if (dt <= 0) return from;
  const t = Math.min(1, dt * rate);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}
