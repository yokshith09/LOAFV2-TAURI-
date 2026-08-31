/**
 * The week, as one shareable picture.
 *
 * The only growth loop available to a product with no network code: Loaf draws
 * an image, saves it to a file, and the user posts it themselves if they feel
 * like it. Nothing is uploaded and nothing is posted on anyone's behalf.
 *
 * EVERY NUMBER HERE IS MEASURED. There is no "you were more focused than 80% of
 * users" — Loaf has no other users to compare against and no way to know. There
 * is no productivity score, because a score is an opinion wearing a number's
 * clothes. A card that overstates is worse than no card, because this is the
 * one artefact of Loaf that other people see.
 *
 * Notably absent: "tantrums survived". It would be a good line and the data does
 * not exist — tantrums are held in memory and never written down. Inventing a
 * plausible count for a picture people will post is exactly the thing the whole
 * product refuses to do.
 */

import type { HistoryEntry } from "../tracker/tracker";
import type { BakedLoaf } from "../bakery/bakery";

/** Days in a week's recap. */
export const WEEK_DAYS = 7;

/**
 * Days of real data needed before a recap is worth making.
 *
 * Four, not one. A recap of a day and a half is the feature failing in public,
 * on the user's own timeline, which is the worst place for it to fail.
 */
export const ENOUGH_DAYS_FOR_A_RECAP = 4;

export interface WrappedStats {
  /** Day keys covered, oldest first. */
  readonly from: string;
  readonly to: string;
  /** Total tracked seconds across the week. */
  readonly totalSeconds: number;
  /** Days in the window that have real data. */
  readonly daysTracked: number;
  /** Longest run of consecutive tracked days, ending anywhere in the window. */
  readonly longestStreak: number;
  /** Focus sessions completed — which is what a loaf is. */
  readonly sessions: number;
  /** Minutes spent inside completed focus sessions. */
  readonly focusMinutes: number;
  /** The best day's loaf count, and which day. */
  readonly bestDay: { readonly day: string; readonly loaves: number } | null;
  /** The most tabs seen in one day this week, or null when never measured. */
  readonly worstTabDay: number | null;
  /** The app with the most time, or null when nothing was tracked. */
  readonly topApp: { readonly name: string; readonly seconds: number } | null;
}

export interface WrappedInputs {
  /** The last `WEEK_DAYS` days, oldest first, including today. */
  readonly history: readonly HistoryEntry[];
  /** Everything on the shelf. Filtered to the window here. */
  readonly loaves: readonly BakedLoaf[];
  /** Seconds per app across the window. */
  readonly appTotals: Readonly<Record<string, number>>;
  /** Peak tab count per day key, for whichever days have one. */
  readonly peakTabsByDay: Readonly<Record<string, number>>;
  /** Day keys in the window, oldest first — the calendar the rest is read against. */
  readonly dayKeys: readonly string[];
}

/**
 * The longest run of consecutive tracked days.
 *
 * Days SEEN, not days worked well. Loaf does not know whether any of them were
 * good, and a number that implied it did would be the first dishonest thing on
 * a card people put on the internet.
 */
export function longestStreak(history: readonly HistoryEntry[]): number {
  let best = 0;
  let run = 0;
  for (const day of history) {
    if (day.hasData) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

/** Whether there is enough of a week to be worth showing anybody. */
export function worthMaking(history: readonly HistoryEntry[]): boolean {
  return history.filter((d) => d.hasData).length >= ENOUGH_DAYS_FOR_A_RECAP;
}

export function collectWrapped(inputs: WrappedInputs): WrappedStats | null {
  if (!worthMaking(inputs.history)) return null;

  const days = new Set(inputs.dayKeys);
  const loaves = inputs.loaves.filter((l) => days.has(l.day));

  const perDay = new Map<string, number>();
  for (const loaf of loaves) {
    perDay.set(loaf.day, (perDay.get(loaf.day) ?? 0) + 1);
  }
  let bestDay: WrappedStats["bestDay"] = null;
  for (const [day, count] of perDay) {
    if (bestDay === null || count > bestDay.loaves) bestDay = { day, loaves: count };
  }

  const tabCounts = inputs.dayKeys
    .map((d) => inputs.peakTabsByDay[d] ?? 0)
    .filter((n) => n > 0);

  const apps = Object.entries(inputs.appTotals).sort((a, b) => b[1] - a[1]);

  return {
    from: inputs.dayKeys[0] ?? "",
    to: inputs.dayKeys[inputs.dayKeys.length - 1] ?? "",
    totalSeconds: inputs.history.reduce((sum, d) => sum + (d.hasData ? d.total : 0), 0),
    daysTracked: inputs.history.filter((d) => d.hasData).length,
    longestStreak: longestStreak(inputs.history),
    sessions: loaves.length,
    focusMinutes: loaves.reduce((sum, l) => sum + l.minutes, 0),
    bestDay,
    worstTabDay: tabCounts.length > 0 ? Math.max(...tabCounts) : null,
    topApp: apps.length > 0 ? { name: apps[0]![0], seconds: apps[0]![1] } : null,
  };
}

/** `2h 15m`, or `45m`. Shared with the card so both round the same way. */
export function formatSpan(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The lines the card prints, already worded.
 *
 * Built here rather than in the drawing code so the wording is testable without
 * a canvas, and so a line with nothing behind it is simply absent rather than
 * printed as a zero. "0 focus sessions" on a card someone might post is a
 * sentence nobody needs to read about themselves.
 */
export function wrappedLines(stats: WrappedStats): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];

  out.push({ value: formatSpan(stats.totalSeconds), label: "at the keyboard" });

  if (stats.sessions > 0) {
    out.push({
      value: String(stats.sessions),
      label: stats.sessions === 1 ? "loaf baked" : "loaves baked",
    });
  }
  if (stats.focusMinutes > 0) {
    out.push({ value: formatSpan(stats.focusMinutes * 60), label: "spent focused" });
  }
  if (stats.longestStreak >= 2) {
    out.push({ value: `${stats.longestStreak} days`, label: "in a row" });
  }
  if (stats.worstTabDay !== null && stats.worstTabDay > 0) {
    out.push({ value: String(stats.worstTabDay), label: "tabs, at the worst" });
  }
  if (stats.topApp !== null) {
    out.push({ value: stats.topApp.name, label: "took the most time" });
  }
  return out;
}
