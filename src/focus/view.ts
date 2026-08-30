import { formatClock, spell, PRESETS, STEPS, type TimerState } from "./timer";

/**
 * What the focus window says and shows. Ported from `PomodoroWindow.swift`.
 *
 * THE REFERENCE PUSHES A FRAME FOUR TIMES A SECOND. It builds the page once and
 * calls `loafTick(json)` through `evaluateJavaScript` on every tick, because a
 * reload at that rate would flicker and reset the chime checkbox mid-session.
 *
 * This port does not need the tick at all. The timer already counts to a
 * wall-clock deadline, so a snapshot of that deadline is enough for the window
 * to derive the clock itself, locally, at whatever rate it likes. The companion
 * broadcasts only when something actually changes — a preset, a pause, the
 * session ending — which turns four IPC messages a second into a handful an
 * hour.
 *
 * The derivation lives here rather than in the page so both windows compute the
 * clock the same way, from the same function, instead of two implementations
 * that agree until one of them is edited.
 */

/**
 * Everything the window needs to reconstruct the timer without owning it.
 *
 * `endsAt` is an absolute epoch time, not a duration: a duration would be stale
 * the moment it crossed the bus, and would drift further every second the
 * window stayed open.
 */
export interface FocusSnapshot {
  readonly state: TimerState;
  readonly duration: number;
  /** Epoch ms the session ends. Only meaningful while running. */
  readonly endsAt: number | null;
  /** Seconds left at the moment it was paused. Only meaningful while paused. */
  readonly pausedRemaining: number | null;
}

/** Seconds left, recomputed from the snapshot. Mirrors `FocusTimer.remaining`. */
export function remainingFrom(snap: FocusSnapshot, nowMs: number): number {
  switch (snap.state) {
    case "idle":
      return snap.duration;
    case "running":
      return Math.max(0, Math.ceil(((snap.endsAt ?? nowMs) - nowMs) / 1000));
    case "paused":
      return Math.max(0, Math.ceil(snap.pausedRemaining ?? 0));
    case "finished":
      return 0;
  }
}

export function progressFrom(snap: FocusSnapshot, nowMs: number): number {
  if (snap.duration <= 0) return 0;
  const left = remainingFrom(snap, nowMs);
  return Math.min(1, Math.max(0, (snap.duration - left) / snap.duration));
}

/**
 * Everything that differs between the four states, in one place.
 *
 * Idle, running, paused and finished saying the same sentence would make the
 * window useless at a glance, which is the only way anyone reads a timer.
 */
export interface Words {
  /** The state badge. */
  readonly pill: string;
  /** One short declarative. */
  readonly title: string;
  /** The opinion. */
  readonly note: string;
  /** What the primary button will *do*, not what it is. */
  readonly action: string;
  /** The line under the clock. */
  readonly sub: string;
}

export function wordsFor(state: TimerState, duration: number): Words {
  const planned = spell(duration);
  switch (state) {
    case "idle":
      return {
        pill: "Ready",
        title: "Nothing is running.",
        note: "Pick a length. He keeps time; you do the hard part.",
        action: "Start",
        sub: planned,
      };
    case "running":
      return {
        pill: "Running",
        title: "He's counting.",
        note: "Go be useful. He'll say something when it runs out.",
        action: "Pause",
        sub: `of ${planned}`,
      };
    case "paused":
      return {
        pill: "Paused",
        title: "Held where you left it.",
        note: "The clock isn't going anywhere. Neither is he.",
        action: "Resume",
        sub: `of ${planned}`,
      };
    case "finished":
      return {
        pill: "Done",
        title: "That's the session.",
        note: `${planned}, spent on purpose. Stand up. Look at something far away.`,
        action: "Start again",
        sub: planned,
      };
  }
}

/**
 * Ring geometry, kept here rather than in the CSS so the SVG and the dash maths
 * cannot drift apart when someone resizes the dial.
 */
export const RING = { box: 216, radius: 94 } as const;
export const CIRCUMFERENCE = 2 * Math.PI * RING.radius;

export interface FocusFrame {
  readonly clock: string;
  /** `stroke-dashoffset` for the arc. */
  readonly dash: number;
  readonly state: TimerState;
  readonly minutes: number;
  /** True once an hour is on the clock and the string outgrows the dial. */
  readonly long: boolean;
  readonly words: Words;
}

export function frameFor(snap: FocusSnapshot, nowMs: number): FocusFrame {
  const clock = formatClock(remainingFrom(snap, nowMs));
  return {
    clock,
    dash: CIRCUMFERENCE * (1 - progressFrom(snap, nowMs)),
    state: snap.state,
    // Which preset chip is lit. The duration moves without a state change — a
    // preset tap, or +/-5 while idle — so this is re-derived every frame.
    minutes: Math.round(snap.duration / 60),
    long: clock.length > 5,
    words: wordsFor(snap.state, snap.duration),
  };
}

/** The step buttons, largest outermost: -5 -1 +1 +5. */
export function stepMinutes(): number[] {
  const down = [...STEPS].sort((a, b) => b - a).map((m) => -m);
  const up = [...STEPS].sort((a, b) => a - b);
  return [...down, ...up];
}

export { PRESETS };
