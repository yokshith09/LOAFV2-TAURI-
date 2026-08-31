/**
 * What Loaf has noticed, said out loud.
 *
 * This is "Phase A" — the useful half of what people mean by adding AI, built
 * from data the tracker already holds and without a single network call. Loaf
 * has been measuring per-app time, hourly patterns and history since the
 * beginning and saying almost none of it; this is the part that speaks.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. Every note states something MEASURED.
 * Nothing predicts, nothing advises, and nothing is said about a day Loaf was
 * not running. A note that guesses reads exactly like a note that knows, which
 * is why the sample bars were taken out of the charts and why the tracker has a
 * "Not attributed" row rather than a plausible split. The same discipline
 * applies to sentences.
 *
 * The second rule is that silence is a valid answer. A note nobody needed is
 * worse than no note, so every generator here returns null far more often than
 * it returns a string.
 */

import type { HistoryEntry } from "../tracker/tracker";

/** A single observation, ready to be shown. */
export interface Note {
  /** What is said. One sentence, no more. */
  readonly text: string;
  /**
   * Which observation this is, so the caller can avoid repeating one and can
   * decide what deserves the space. Not shown to the user.
   */
  readonly kind: NoteKind;
}

export type NoteKind =
  | "quiet-hour"
  | "busiest-app"
  | "compared-to-usual"
  | "first-day"
  | "streak"
  | "tabs";

/** Below this, a day has too little in it to say anything about. */
export const ENOUGH_FOR_A_DAY = 20 * 60;

/**
 * Days of history needed before "usual" means anything.
 *
 * Three, not two: two days makes every comparison a comparison with yesterday,
 * and one unusual Tuesday would then redefine normal for the rest of the week.
 */
export const ENOUGH_DAYS_FOR_USUAL = 3;

/** How far from the median counts as worth mentioning. */
export const NOTABLE_SHIFT = 0.3;

export interface NoteInputs {
  /** Seconds per app today. */
  readonly today: Readonly<Record<string, number>>;
  /** Total seconds today. */
  readonly totalToday: number;
  /** 24 buckets of seconds, index 0 = midnight. */
  readonly hours: readonly number[];
  /** Recent days, oldest first, including today. */
  readonly history: readonly HistoryEntry[];
  /** Tabs open in the frontmost browser right now, or null when unknown. */
  readonly tabsNow?: number | null;
  /** The most tabs seen on each past day, oldest first. */
  readonly pastPeakTabs?: readonly number[];
}

/** Fewer than this and a tab count is not worth a sentence. */
export const ENOUGH_TABS_TO_MENTION = 12;

function formatHours(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** 14 -> "2pm". Whole hours only, because that is the resolution we have. */
function hourLabel(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "midday";
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${suffix}`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Days with real data, today excluded — what "usual" is measured against. */
function pastDays(history: readonly HistoryEntry[]): HistoryEntry[] {
  return history.filter((d) => d.hasData && !d.isToday);
}

/**
 * The clearest hour INSIDE the span you were working.
 *
 * Not the clearest hour of the clock. Naming 4am, or the hour before you sat
 * down, is true and useless — an hour you were not there for is trivially
 * empty, and saying so makes the whole feature look like it is counting rather
 * than noticing. The interesting hour is a gap you left in the middle of your
 * own day.
 */
export function quietHourNote(inputs: NoteInputs): Note | null {
  if (inputs.totalToday < ENOUGH_FOR_A_DAY) return null;
  if (inputs.hours.length < 24) return null;

  // Bounded by YOUR day, not by the clock.
  //
  // Searching a fixed 7am–9pm window names the hour before you started, every
  // time, because an hour you were not there for is trivially clear. The
  // interesting hour is one INSIDE the span you were working — a gap you left,
  // rather than the edge of the day. So the search runs between your first and
  // last active hour, and a day without a middle has no such gap to find.
  let firstActive = -1;
  let lastActive = -1;
  for (let h = 0; h < 24; h++) {
    if ((inputs.hours[h] ?? 0) > 0) {
      if (firstActive < 0) firstActive = h;
      lastActive = h;
    }
  }
  // Needs at least three hours to have a middle at all.
  if (firstActive < 0 || lastActive - firstActive < 2) return null;

  let quietest = -1;
  let quietestSeconds = Infinity;
  for (let h = firstActive + 1; h < lastActive; h++) {
    const seconds = inputs.hours[h] ?? 0;
    if (seconds < quietestSeconds) {
      quietestSeconds = seconds;
      quietest = h;
    }
  }
  if (quietest < 0) return null;
  // If the quietest hour still had real use in it, there is nothing quiet
  // about it and saying so would be a stretch.
  if (quietestSeconds > 5 * 60) return null;

  return {
    kind: "quiet-hour",
    text: `${hourLabel(quietest)} stayed clear today.`,
  };
}

/** Where most of the day went. States the share, never a judgement about it. */
export function busiestAppNote(inputs: NoteInputs): Note | null {
  if (inputs.totalToday < ENOUGH_FOR_A_DAY) return null;

  const entries = Object.entries(inputs.today);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [name, seconds] = entries[0]!;
  const share = seconds / inputs.totalToday;
  // Under half is not a story. "Chrome, 38%" is a table, not an observation.
  if (share < 0.5) return null;

  return {
    kind: "busiest-app",
    text: `${formatHours(seconds)} in ${name} — ${Math.round(share * 100)}% of today.`,
  };
}

/**
 * Today against the median of the days before it.
 *
 * Median rather than mean, because one 11-hour day would drag an average up far
 * enough to make every ordinary day afterwards look restful.
 */
export function comparedToUsualNote(inputs: NoteInputs): Note | null {
  if (inputs.totalToday < ENOUGH_FOR_A_DAY) return null;

  const past = pastDays(inputs.history);
  if (past.length < ENOUGH_DAYS_FOR_USUAL) return null;

  const usual = median(past.map((d) => d.total));
  if (usual <= 0) return null;

  const change = (inputs.totalToday - usual) / usual;
  if (Math.abs(change) < NOTABLE_SHIFT) {
    return {
      kind: "compared-to-usual",
      text: `${formatHours(inputs.totalToday)} today — about usual.`,
    };
  }
  const percent = Math.round(Math.abs(change) * 100);
  const direction = change > 0 ? "more" : "less";
  return {
    kind: "compared-to-usual",
    text: `${formatHours(inputs.totalToday)} today — ${percent}% ${direction} than usual.`,
  };
}

/**
 * Consecutive days with data, ending today.
 *
 * A streak of days SEEN, not of days worked well. Loaf does not know whether
 * any of them were good, and a number that implied it did would be the first
 * dishonest thing in the product.
 */
export function streakNote(inputs: NoteInputs): Note | null {
  const days = [...inputs.history].reverse();
  let streak = 0;
  for (const day of days) {
    if (!day.hasData) break;
    streak++;
  }
  // Two days is not a streak, it is a Tuesday and a Wednesday.
  if (streak < 3) return null;
  return { kind: "streak", text: `${streak} days together now.` };
}

/**
 * How many tabs are open, against how many you usually keep.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not list them, and it cannot: the
 * count comes from counting `TabItem` elements, and naming them would mean
 * reading each tab's title — "Re: redundancies — Gmail" — which is page content
 * by another name and the exact thing the product promises not to look at. UI
 * Automation also exposes no per-tab timing, so "untouched for three hours" is
 * not available at any privacy price.
 *
 * What is left is honest and, it turns out, the useful part: you already know
 * which tabs you do not need. What you have lost track of is how far past your
 * own normal you have drifted. That is a number Loaf genuinely has.
 */
export function tabsNote(inputs: NoteInputs): Note | null {
  const now = inputs.tabsNow ?? null;
  if (now === null || now < ENOUGH_TABS_TO_MENTION) return null;

  const past = (inputs.pastPeakTabs ?? []).filter((n) => n > 0);
  if (past.length < ENOUGH_DAYS_FOR_USUAL) {
    return { kind: "tabs", text: `${now} tabs open.` };
  }

  const usual = Math.round(median(past));
  if (usual <= 0) return { kind: "tabs", text: `${now} tabs open.` };
  // Only worth saying when it is genuinely off your own normal. "23 vs 21" is
  // a measurement, not an observation.
  if (now <= usual * (1 + NOTABLE_SHIFT)) return null;

  return {
    kind: "tabs",
    text: `${now} tabs open — you usually work with about ${usual}.`,
  };
}

/** The honest thing to say when there is not yet anything to compare. */
export function firstDayNote(inputs: NoteInputs): Note | null {
  const past = pastDays(inputs.history);
  if (past.length > 0) return null;
  if (inputs.totalToday < ENOUGH_FOR_A_DAY) return null;
  return {
    kind: "first-day",
    text: `${formatHours(inputs.totalToday)} so far. I'll have more to say once I've seen a few days.`,
  };
}

/**
 * Everything worth saying right now, best first.
 *
 * Ordered by how much it took to know: a comparison against your own history
 * beats a fact about today, which beats a count of days. The caller takes as
 * many as it has room for and no more.
 */
export function notesFor(inputs: NoteInputs): Note[] {
  const generators = [
    firstDayNote,
    comparedToUsualNote,
    busiestAppNote,
    tabsNote,
    quietHourNote,
    streakNote,
  ];
  const out: Note[] = [];
  for (const generate of generators) {
    const note = generate(inputs);
    if (note !== null) out.push(note);
  }
  return out;
}
