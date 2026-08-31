/**
 * The water reminder.
 *
 * Separate from the fifteen-minute break nudge on purpose, even though one of
 * that rotation's four lines already mentions water. A break nudge is about the
 * last fifteen minutes; this is about the whole day, it keeps a count, and it
 * runs on its own much longer clock. Folding them together would mean either
 * nagging about water every fifteen minutes or reminding you to stretch once an
 * hour, and both are worse than two timers.
 *
 * Deliberately NOT a health claim. It does not know your weight, the weather,
 * or whether you just drank something it could not see — so it counts what you
 * tell it and says nothing about what you should have drunk. The count is a
 * tally you keep, not a target it sets, [[loaf-no-invented-data]] applied to a
 * number about your body.
 */

/**
 * How long between reminders.
 *
 * Forty-five minutes rather than the hour you might expect: an hourly reminder
 * lands at most eight times in a working day and reads as an alarm, while this
 * lands often enough to feel like a companion noticing and rarely enough that
 * it is not the thing you remember about the app.
 */
export const WATER_INTERVAL_SECONDS = 45 * 60;

/** Rotated, never random — see `PromptRotation` for why. */
export const WATER_PROMPTS: readonly string[] = [
  "Water break? 💧",
  "Time for a glass. 🥛",
  "Hydration check. 💧 Even a few sips count.",
  "Still here. Still thirsty on your behalf. 💧",
];

export interface WaterState {
  /** Glasses the user has confirmed today. */
  readonly glasses: number;
  /** Seconds until the next reminder, or null when it is suppressed. */
  readonly nextInSeconds: number | null;
}

/**
 * Tracks when to ask, and what the user has told us.
 *
 * A wall-clock deadline rather than a decrementing counter, for the reason the
 * focus timer uses one: a machine that sleeps for an hour has not had an hour
 * of ticks, and a countdown would come back an hour behind.
 */
export class WaterGuide {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private due: number;
  private glassesValue = 0;
  /** The day the count belongs to, so it resets over midnight. */
  private dayKey: string;

  constructor(opts: { now?: () => number; intervalSeconds?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.intervalMs = (opts.intervalSeconds ?? WATER_INTERVAL_SECONDS) * 1000;
    this.due = this.now() + this.intervalMs;
    this.dayKey = this.today();
  }

  private today(): string {
    return new Date(this.now()).toDateString();
  }

  /** Rolls the count over at midnight so yesterday's glasses are not today's. */
  private rollDay(): void {
    const key = this.today();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.glassesValue = 0;
    }
  }

  get glasses(): number {
    this.rollDay();
    return this.glassesValue;
  }

  get state(): WaterState {
    return {
      glasses: this.glasses,
      nextInSeconds: Math.max(0, Math.round((this.due - this.now()) / 1000)),
    };
  }

  /**
   * Whether it is time to ask.
   *
   * Asking resets the clock whether or not the user answers. A reminder that
   * stayed due would fire again on the very next tick, which is how a companion
   * becomes something you quit.
   *
   * @param suppressed true while something more important is happening — a
   *   focus session, or a nudge already on screen. The clock still resets, so a
   *   suppressed reminder is skipped rather than queued up to arrive in a burst
   *   the moment the session ends.
   */
  askNow(suppressed: boolean): boolean {
    this.rollDay();
    if (this.now() < this.due) return false;
    this.due = this.now() + this.intervalMs;
    return !suppressed;
  }

  /** The user says they drank something. */
  noteGlass(): void {
    this.rollDay();
    this.glassesValue += 1;
    // Drinking restarts the clock: being asked again four minutes after you
    // filled a glass is the behaviour that gets a reminder switched off.
    this.due = this.now() + this.intervalMs;
  }

  /** Forget the tally, for the same reason the tracker can forget a day. */
  reset(): void {
    this.glassesValue = 0;
    this.dayKey = this.today();
  }
}
