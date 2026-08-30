/**
 * The focus timer. Ported from `PomodoroTimer.swift`.
 *
 * Counts down to a **wall-clock deadline** rather than by decrementing a
 * counter on each tick. A repeating timer is only a redraw signal here — it
 * drifts, it coalesces when the machine is busy, and it stops entirely while
 * the machine sleeps, so a tick-decremented clock quietly runs slow and a
 * 45-minute session ends at 52. Deriving `remaining` from the deadline makes
 * the display correct after a lid close, a slow moment, or a missed tick.
 *
 * The clock and the store are injected. Both bugs the reference documents here
 * are timing bugs, and neither is testable against the ambient clock.
 */

export type TimerState = "idle" | "running" | "paused" | "finished";

/** Session lengths offered as one-tap presets, in minutes. */
export const PRESETS = [5, 15, 30, 45, 60, 90] as const;
/** Increments the +/- buttons move by, in minutes. */
export const STEPS = [1, 5] as const;

export const MIN_DURATION = 60; // one minute
export const MAX_DURATION = 4 * 60 * 60; // four hours; past this it isn't a pomodoro

/**
 * How late an expired session may be and still ring on relaunch. Beyond this
 * the alarm is stale: an alert for a session that ended over lunch is noise,
 * not a reminder, so it is dropped silently.
 */
export const STALE_AFTER_SECONDS = 120;

/** Somewhere to survive a quit. `localStorage` satisfies this. */
export interface TimerStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** An in-memory store, for tests and for running without persistence. */
export class MemoryStore implements TimerStore {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const K_STATE = "pomodoro.state";
const K_DURATION = "pomodoro.duration";
const K_END = "pomodoro.endDate";
const K_PAUSED = "pomodoro.pausedRemaining";

function clampDuration(seconds: number): number {
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(seconds)));
}

/**
 * Move what is left by `delta`, keeping the WHOLE session inside the cap: four
 * hours is a limit on the session, and time already spent counts against it.
 * Clamping only the remainder let a stretched session run past the cap.
 */
export function stretch(remaining: number, delta: number, spent: number): number {
  const headroom = Math.max(0, MAX_DURATION - spent);
  return Math.max(0, Math.min(headroom, remaining + delta));
}

/** "24:31", or "1:04:12" once there is an hour on the clock. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A short human phrase for bubbles — "45 minutes", "1 hour 30". */
export function spell(seconds: number): string {
  // Floored at zero like formatClock: these phrases go straight into a bubble,
  // and "-3 minutes done" is not a thing to congratulate anyone on.
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return rem === 0 ? hours : `${hours} ${rem}`;
}

export class FocusTimer {
  private stateValue: TimerState = "idle";
  /**
   * The chosen session length in seconds. Adjusting while running extends the
   * deadline instead.
   */
  private durationValue: number;
  /** Milliseconds since epoch, or null. */
  private endAt: number | null = null;
  /**
   * Sub-second precision ON PURPOSE. `remaining` rounds UP so a fresh 5:00
   * session reads "5:00" rather than "4:59" — but storing that rounded value on
   * pause hands the fraction back every time. Pausing and resuming on a quick
   * rhythm then walks the clock backwards faster than it runs forwards, and the
   * session never ends. Keeping the exact interval costs nothing and makes
   * pause/resume lossless.
   */
  private pausedRemaining = 0;

  onTick: ((t: FocusTimer) => void) | null = null;
  onFinish: ((plannedDuration: number) => void) | null = null;

  private readonly now: () => number;
  private readonly store: TimerStore;

  constructor(opts: { now?: () => number; store?: TimerStore } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.store = opts.store ?? new MemoryStore();

    const saved = Number(this.store.getItem(K_DURATION));
    this.durationValue = clampDuration(
      Number.isFinite(saved) && saved > 0 ? saved : 30 * 60,
    );
    this.restore();
  }

  // --- Reading ---

  get state(): TimerState {
    return this.stateValue;
  }
  get duration(): number {
    return this.durationValue;
  }

  /** Seconds left, derived from the deadline rather than accumulated. */
  get remaining(): number {
    switch (this.stateValue) {
      case "idle":
        return this.durationValue;
      case "running":
        return Math.max(
          0,
          Math.ceil(((this.endAt ?? this.now()) - this.now()) / 1000),
        );
      case "paused":
        return Math.max(0, Math.ceil(this.pausedRemaining));
      case "finished":
        return 0;
    }
  }

  /** 0..1 elapsed. Used for the ring drawn at the companion's feet. */
  get progress(): number {
    if (this.durationValue <= 0) return 0;
    return Math.min(
      1,
      Math.max(0, (this.durationValue - this.remaining) / this.durationValue),
    );
  }

  get isActive(): boolean {
    return this.stateValue === "running" || this.stateValue === "paused";
  }

  /**
   * Everything another window needs to show this timer without owning it.
   *
   * The deadline goes across as an absolute time, not a countdown: a countdown
   * is stale the instant it crosses the bus and drifts further every second the
   * other window stays open. With the deadline, that window derives the clock
   * itself and stays exact without anyone sending it a tick.
   */
  get snapshot(): {
    state: TimerState;
    duration: number;
    endsAt: number | null;
    pausedRemaining: number | null;
  } {
    return {
      state: this.stateValue,
      duration: this.durationValue,
      endsAt: this.stateValue === "running" ? this.endAt : null,
      pausedRemaining: this.stateValue === "paused" ? this.pausedRemaining : null,
    };
  }

  /** The shape the behaviour licence consumes. */
  get display(): { remaining: number; paused: boolean } | null {
    if (!this.isActive) return null;
    return { remaining: this.remaining, paused: this.stateValue === "paused" };
  }

  // --- Setting up ---

  setDurationMinutes(minutes: number): void {
    this.setDurationSeconds(minutes * 60);
  }

  setDurationSeconds(seconds: number): void {
    this.durationValue = clampDuration(seconds);
    switch (this.stateValue) {
      case "idle":
      case "finished":
        this.stateValue = "idle";
        break;
      case "paused":
        this.pausedRemaining = this.durationValue;
        break;
      case "running":
        // Re-aim the deadline at the new length from now, which is what someone
        // picking a different preset mid-session means.
        this.endAt = this.now() + this.durationValue * 1000;
        break;
    }
    this.persist();
    this.onTick?.(this);
  }

  /**
   * The +1 / +5 (and negative) buttons. While running this moves the deadline,
   * so "+5" adds five minutes to what is left rather than restarting anything.
   */
  adjust(minutes: number): void {
    const delta = minutes * 60;
    switch (this.stateValue) {
      case "idle":
      case "finished":
        this.setDurationSeconds(this.durationValue + delta);
        return;
      case "paused": {
        // Snapping to a whole second here is deliberate: adjusting is an
        // explicit press, and "+1" should land on a round minute, not 1:00.37.
        const left = this.remaining;
        const spent = this.durationValue - left;
        const stretched = stretch(left, delta, spent);
        this.pausedRemaining = stretched;
        this.durationValue = clampDuration(spent + stretched);
        this.persist();
        this.onTick?.(this);
        // Zero is the end of the session however you arrive at it. Without
        // this, "-5" on a paused session with under five minutes left parks it
        // in paused/0:00, where start() has nothing to count and the play
        // button is dead for good.
        if (this.pausedRemaining === 0) this.finish();
        return;
      }
      case "running": {
        // Read the deadline ONCE: `remaining` moves on its own, and two reads
        // either side of a second boundary would lose or invent a second.
        const left = this.remaining;
        // Holding `spent` fixed across an adjust is what keeps the ring honest:
        // "+5" then "-5" has to land exactly where it started. Taking the max()
        // of the old and new lengths let duration grow but never come back
        // down, so every pair of presses recorded minutes that never elapsed.
        const spent = this.durationValue - left;
        const newRemaining = stretch(left, delta, spent);
        this.durationValue = clampDuration(spent + newRemaining);
        this.endAt = this.now() + newRemaining * 1000;
        this.persist();
        this.onTick?.(this);
        if (newRemaining === 0) this.finish();
        return;
      }
    }
  }

  // --- Running ---

  start(): void {
    // Starting an already-running session would re-aim the deadline at the full
    // length, i.e. a double-press would silently rewind the clock. Resuming is
    // toggle()'s job; this one only ever begins.
    if (this.stateValue === "running") return;
    // Falling back to the full length when a paused session has nothing left
    // means a paused-at-0:00 record cannot brick this button.
    const seconds =
      this.stateValue === "paused" && this.pausedRemaining > 0
        ? this.pausedRemaining
        : this.durationValue;
    if (seconds <= 0) return;
    this.endAt = this.now() + seconds * 1000;
    this.stateValue = "running";
    this.persist();
    this.onTick?.(this);
  }

  pause(): void {
    if (this.stateValue !== "running") return;
    // Pressing pause in the same instant the deadline passes is a finish, not a
    // pause; parking at 0:00 would be a state with nowhere to go.
    if (this.remaining <= 0) {
      this.finish();
      return;
    }
    // The exact interval, not `remaining` — see the note on pausedRemaining.
    this.pausedRemaining = Math.max(0, ((this.endAt ?? 0) - this.now()) / 1000);
    this.stateValue = "paused";
    this.persist();
    this.onTick?.(this);
  }

  toggle(): void {
    if (this.stateValue === "running") this.pause();
    else this.start();
  }

  /** Back to the top of the chosen length, not running. */
  reset(): void {
    this.stateValue = "idle";
    this.endAt = null;
    this.pausedRemaining = 0;
    this.persist();
    this.onTick?.(this);
  }

  /** Clears the finished state after the completion has been shown. */
  acknowledge(): void {
    if (this.stateValue !== "finished") return;
    this.reset();
  }

  /**
   * Drive the clock. Called from the render loop rather than owning a timer of
   * its own, so the countdown cannot drift from the animation and so tests can
   * step it explicitly.
   */
  poll(): void {
    if (this.stateValue === "running" && this.remaining <= 0) {
      this.finish();
    } else if (this.stateValue === "running") {
      this.onTick?.(this);
    }
  }

  private finish(): void {
    // Every route here arrives with nothing left, and duration is kept at spent
    // + left, so this is the time the session actually took — whether it ran
    // out on its own or was cut short by "-5". The completion bubble quotes
    // this number, so it has to be one the user would recognise.
    const planned = this.durationValue;
    this.stateValue = "finished";
    this.endAt = null;
    this.persist();
    this.onTick?.(this);
    this.onFinish?.(planned);
  }

  // --- Surviving a quit ---

  private persist(): void {
    this.store.setItem(K_STATE, this.stateValue);
    this.store.setItem(K_DURATION, String(this.durationValue));
    this.store.setItem(K_END, String(this.endAt ?? 0));
    this.store.setItem(K_PAUSED, String(this.pausedRemaining));
  }

  private restore(): void {
    const raw = this.store.getItem(K_STATE);
    if (raw !== "running" && raw !== "paused" && raw !== "idle" && raw !== "finished") {
      return;
    }

    if (raw === "running") {
      const stamp = Number(this.store.getItem(K_END));
      if (!Number.isFinite(stamp) || stamp <= 0) return;
      const untilMs = stamp - this.now();
      if (untilMs > 0) {
        // A deadline further out than the session length means the record
        // disagrees with itself — a duration clamped on the way in, a clock
        // corrected backwards, a hand-edited store. Believe the LENGTH, which
        // has already been clamped, over the deadline: the alternative is
        // remaining > duration, which pins the ring at 0% and leaves the menu
        // quoting more time left than the session is long.
        this.endAt = Math.min(stamp, this.now() + this.durationValue * 1000);
        this.stateValue = "running";
      } else if (-untilMs / 1000 <= STALE_AFTER_SECONDS) {
        // Ended moments ago — while the app was restarting, most likely.
        this.stateValue = "finished";
      } else {
        this.stateValue = "idle";
        this.persist();
      }
      return;
    }

    if (raw === "paused") {
      const left = Number(this.store.getItem(K_PAUSED));
      if (Number.isFinite(left) && left > 0) {
        // Same invariant as the running case: what is left cannot exceed the
        // length it is left of.
        this.pausedRemaining = Math.min(left, this.durationValue);
        this.stateValue = "paused";
      }
      return;
    }

    this.stateValue = "idle";
  }
}
