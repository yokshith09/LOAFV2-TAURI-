/**
 * Things worth noticing about how the last few minutes went.
 *
 * The pattern notes in `notes.ts` describe your DAY, from data already on disk.
 * These describe the last few minutes, from what the tracker is seeing right
 * now, and they are the observations that need Loaf to have been watching
 * rather than to have been counting.
 *
 * The same two rules apply. Everything stated is measured, and silence is the
 * usual answer — these fire rarely by design, because "you've opened nine apps
 * in ten minutes" is a useful thing to hear once and an intolerable thing to
 * hear hourly.
 *
 * THE RULE THAT MATTERS MOST HERE: none of these keeps a score. Nothing counts
 * how often you were distracted, nothing tracks a total, nothing gets worse the
 * more it happens. Each is a remark about now, and then it is forgotten. A
 * companion that accumulated evidence about your bad habits would be a
 * different and much worse product — see the collapsed loaf in `bakery.ts` for
 * the same decision made once already.
 */

/** How far back the switch counter looks. */
export const HOPPING_WINDOW_SECONDS = 10 * 60;

/**
 * Switches in that window before it is worth a word.
 *
 * Nine, which is roughly one every seventy seconds. Normal work switches
 * apps constantly — editor, browser, terminal — so a lower threshold would fire
 * on somebody doing their job perfectly well.
 */
export const HOPPING_THRESHOLD = 9;

/** Unbroken minutes in ONE app before the tunnel is worth mentioning. */
export const TUNNEL_MINUTES = 75;

/** Hours counted as late. Inclusive of the first, exclusive of the second. */
export const LATE_FROM_HOUR = 23;
export const LATE_UNTIL_HOUR = 5;

/** Today above this multiple of your own median counts as a long day. */
export const OVERWORK_MULTIPLE = 1.8;

/**
 * Counts how often the foreground application changed, recently.
 *
 * Keeps timestamps rather than a running total, so the window can slide and
 * nothing accumulates across the day. The list is bounded by the window, not by
 * the session.
 */
export class AppSwitchWatch {
  private switches: number[] = [];
  private current: string | null = null;
  private currentSince = 0;

  constructor(private readonly windowSeconds = HOPPING_WINDOW_SECONDS) {}

  /**
   * @param app the foreground app, or null when the OS would not say.
   * @param nowMs wall clock.
   */
  note(app: string | null, nowMs: number): void {
    // "The OS would not say" is not a switch. Treating it as one would invent
    // app-hopping out of a screen lock.
    if (app === null) return;
    if (this.current === null) {
      this.current = app;
      this.currentSince = nowMs;
      return;
    }
    if (app !== this.current) {
      this.switches.push(nowMs);
      this.current = app;
      this.currentSince = nowMs;
    }
    const cutoff = nowMs - this.windowSeconds * 1000;
    this.switches = this.switches.filter((t) => t >= cutoff);
  }

  /** Switches inside the window. */
  recent(nowMs: number): number {
    const cutoff = nowMs - this.windowSeconds * 1000;
    return this.switches.filter((t) => t >= cutoff).length;
  }

  /** Unbroken seconds in the current app, or 0 when there is none. */
  streakSeconds(nowMs: number): number {
    if (this.current === null) return 0;
    return Math.max(0, (nowMs - this.currentSince) / 1000);
  }

  get app(): string | null {
    return this.current;
  }

  reset(): void {
    this.switches = [];
    this.current = null;
    this.currentSince = 0;
  }
}

/**
 * "You've opened nine apps in ten minutes."
 *
 * States the count and stops. It does not suggest what to do about it, because
 * Loaf does not know whether you were hunting for a file or falling apart, and
 * a companion that assumed the second would be wrong most of the time.
 */
export function hoppingLine(switches: number, windowMinutes = 10): string | null {
  if (switches < HOPPING_THRESHOLD) return null;
  return `That's ${switches} apps in ${windowMinutes} minutes. Looking for something?`;
}

/**
 * A very long unbroken stretch in one application.
 *
 * Distinct from the hyperfocus check-in, which is about total active time. This
 * one is about a single app and is phrased as interest rather than concern —
 * two hours in an editor is a good day, and being asked whether you are all
 * right would be irritating.
 */
export function tunnelLine(app: string, minutes: number): string | null {
  if (minutes < TUNNEL_MINUTES) return null;
  const rounded = Math.floor(minutes / 15) * 15;
  return `${rounded} minutes straight in ${app}. Going well?`;
}

/**
 * Working late, by the clock.
 *
 * Deliberately not "compared to your usual bedtime": Loaf sees when the machine
 * is used, not when you sleep, and a night-shift worker would get this every
 * single night. The offer to go quiet is the point of the line — it is the one
 * behaviour note that comes with something Loaf can actually do about it.
 */
export function lateNightLine(hour: number): string | null {
  const late = hour >= LATE_FROM_HOUR || hour < LATE_UNTIL_HOUR;
  if (!late) return null;
  return "It's getting late. Want me to go quiet?";
}

/**
 * A much longer day than your own normal.
 *
 * Against your own median, never a general figure — there is no correct number
 * of hours and Loaf is in no position to name one. Only fires when there is
 * enough history for "usual" to mean something.
 */
export function overworkLine(
  todaySeconds: number,
  usualSeconds: number,
  formatSpan: (seconds: number) => string,
): string | null {
  if (usualSeconds <= 0) return null;
  if (todaySeconds < usualSeconds * OVERWORK_MULTIPLE) return null;
  return `${formatSpan(todaySeconds)} today. That's a long one by your standards.`;
}

/**
 * Fires at most once per period, per kind.
 *
 * Every line in this file is worth hearing once and unbearable on a loop, and
 * that is the entire difference between a companion and an alarm. Deliberately
 * NOT a count of how often something happened — see the note at the top.
 */
export class OncePer {
  private lastAt = new Map<string, number>();

  constructor(private readonly gapSeconds: number) {}

  /** True if this kind has not fired within the gap. Records the firing. */
  allow(kind: string, nowMs: number): boolean {
    const last = this.lastAt.get(kind);
    if (last !== undefined && nowMs - last < this.gapSeconds * 1000) return false;
    this.lastAt.set(kind, nowMs);
    return true;
  }

  reset(): void {
    this.lastAt.clear();
  }
}
