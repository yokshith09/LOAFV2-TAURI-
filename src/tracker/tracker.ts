/**
 * Active screen time per frontmost app, and — once the privacy radar lands —
 * per domain inside browsers. Ported from `Tracker.swift`.
 *
 * THE ON-DISK FORMAT IS A COMPATIBILITY CONTRACT. Existing users have a
 * stats.json written by the Swift app; reading it must not lose their history,
 * and what this writes must stay readable by that app. Every parsing decision
 * below exists to protect that.
 *
 * The clock is injected and persistence is a plain string in and out, so the
 * whole thing — day rollover included — is testable without touching a disk or
 * waiting for midnight.
 */

/** How much time one tick credits. */
export const TICK_INTERVAL = 5;
/** Seconds of no input before we stop crediting anything. */
export const IDLE_THRESHOLD = 180;
/** Nudge after this much continuous activity. */
export const BREAK_INTERVAL = 15 * 60;

export type TickResult = "active" | "idle" | "breakDue";

/**
 * One calendar day: seconds per app, seconds per hour-of-day, and seconds per
 * domain nested under the browser showing it.
 *
 * Nesting rather than one flat domain map keeps Chrome's github.com and
 * Safari's github.com attributable to the right browser row.
 *
 * `sites` is a BREAKDOWN OF the browser's own total in `apps`, not extra time
 * on top of it: 5s ticked into "Google Chrome" is the same 5s ticked into
 * sites["Google Chrome"]["github.com"]. The dashboard relies on that.
 */
export interface DayRecord {
  apps: Record<string, number>;
  hours: number[];
  sites: Record<string, Record<string, number>>;
  /** Most tabs seen open at once today — the tantrum's paper trail. */
  peakTabs: number;
}

export function emptyDay(): DayRecord {
  return { apps: {}, hours: new Array(24).fill(0), sites: {}, peakTabs: 0 };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce anything to a non-negative integer count of seconds. */
function seconds(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function numberMap(v: unknown): Record<string, number> {
  if (!isObject(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v)) {
    const s = seconds(raw);
    if (s > 0) out[k] = s;
  }
  return out;
}

/**
 * Parse one day.
 *
 * Deliberately tolerant of every missing key, which is the whole reason the
 * Swift hand-writes its decoder: a synthesised one treats every key as
 * required, so the first Loaf+ launch would fail to decode a file written by
 * free Loaf (no `sites`, no `peakTabs`) and silently throw the user's history
 * away. The same trap exists here the moment anyone reaches for a strict
 * schema, so the tolerance is tested rather than assumed.
 */
export function parseDay(v: unknown): DayRecord {
  if (!isObject(v)) return emptyDay();

  const hours = new Array<number>(24).fill(0);
  if (Array.isArray(v.hours)) {
    for (let i = 0; i < Math.min(24, v.hours.length); i++) {
      hours[i] = seconds(v.hours[i]);
    }
  }

  const sites: Record<string, Record<string, number>> = {};
  if (isObject(v.sites)) {
    for (const [browser, domains] of Object.entries(v.sites)) {
      const m = numberMap(domains);
      if (Object.keys(m).length > 0) sites[browser] = m;
    }
  }

  return {
    apps: numberMap(v.apps),
    hours,
    sites,
    peakTabs: seconds(v.peakTabs),
  };
}

/**
 * Parse a whole stats file, in either format.
 *
 * v0.2+ is `{ "2026-08-30": { apps, hours, sites, peakTabs } }`.
 * v0.1 was `{ "2026-08-30": { "Xcode": 1200 } }` — apps only, no wrapper.
 *
 * The two are told apart by looking at a day's values: a v0.2 record's values
 * are objects and arrays, a v0.1 record's are plain numbers. Guessing wrong in
 * either direction loses history, so it checks rather than assumes.
 */
export function parseStats(json: string | null): Record<string, DayRecord> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // A truncated or corrupt file. Starting fresh is bad, but throwing on
    // launch is worse; the caller keeps the old file until the next save.
    return {};
  }
  if (!isObject(raw)) return {};

  const out: Record<string, DayRecord> = {};
  for (const [day, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const looksLegacy = Object.values(value).every((x) => typeof x === "number");
    out[day] = looksLegacy
      ? { ...emptyDay(), apps: numberMap(value) }
      : parseDay(value);
  }
  return out;
}

/** Local calendar day as `yyyy-MM-dd`. */
export function dayKeyFor(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "1h 30m", "45m", or "under a minute". */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "under a minute";
}

export interface HistoryEntry {
  readonly date: Date;
  readonly label: string;
  readonly total: number;
  readonly isToday: boolean;
  /**
   * False for days Loaf was not running. The dashboard uses this to tell real
   * history apart from illustrative sample bars — a day with no data is not the
   * same as a day with zero minutes.
   */
  readonly hasData: boolean;
}

export class Tracker {
  private days: Record<string, DayRecord>;
  private continuousActiveValue = 0;
  private readonly now: () => Date;

  constructor(opts: { json?: string | null; now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.days = parseStats(opts.json ?? null);
  }

  /**
   * Which day we are writing to, resolved fresh every time.
   *
   * The reference caches this and refreshes it inside `tick`, which leaves a
   * window after midnight where the getters still answer for yesterday —
   * "today" reads as a full day's work until the first tick lands, and any
   * site credited in between is filed under the wrong date. Deriving it costs
   * nothing and the window disappears.
   */
  private get dayKey(): string {
    return dayKeyFor(this.now());
  }

  /**
   * The tracker's idea of now.
   *
   * Exposed so anything rendering this data reads the same clock. The dashboard
   * captions a chart built from `history()`; sourcing that caption from an
   * ambient `new Date()` would let the two disagree in exactly the tests where
   * the clock is injected, which is where a date bug would otherwise be caught.
   */
  currentDate(): Date {
    return this.now();
  }

  get continuousActive(): number {
    return this.continuousActiveValue;
  }

  get today(): Record<string, number> {
    return this.days[this.dayKey]?.apps ?? {};
  }

  get totalToday(): number {
    return Object.values(this.today).reduce((a, b) => a + b, 0);
  }

  get peakTabsToday(): number {
    return this.days[this.dayKey]?.peakTabs ?? 0;
  }

  /** Per-browser domain breakdown for today: browser -> domain -> seconds. */
  get todaySitesByBrowser(): Record<string, Record<string, number>> {
    return this.days[this.dayKey]?.sites ?? {};
  }

  /** Today's domains merged across every browser, biggest first. */
  todaySitesMerged(): Array<{ domain: string; seconds: number }> {
    const merged: Record<string, number> = {};
    for (const domains of Object.values(this.todaySitesByBrowser)) {
      for (const [domain, secs] of Object.entries(domains)) {
        merged[domain] = (merged[domain] ?? 0) + secs;
      }
    }
    return Object.entries(merged)
      .map(([domain, secs]) => ({ domain, seconds: secs }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  get totalSiteSecondsToday(): number {
    return Object.values(this.todaySitesByBrowser).reduce(
      (sum, domains) => sum + Object.values(domains).reduce((a, b) => a + b, 0),
      0,
    );
  }

  /**
   * Any domain, on any day. Used to tell someone who switched the radar off
   * that what it already recorded is still on disk — switching it off stops the
   * collecting, it is not the delete button.
   */
  get hasAnySiteData(): boolean {
    return Object.values(this.days).some((d) => Object.keys(d.sites).length > 0);
  }

  /**
   * The earliest day with a record, or null if nothing has ever been recorded.
   *
   * Stands in for an install date, and is better than one: a user migrating
   * from the Swift app brings months of history with them, and an "installed
   * today" marker would throw all of it off the left edge of every chart. Keys
   * are `yyyy-MM-dd`, so lexical order is chronological order.
   */
  firstRecordedDay(): string | null {
    const keys = Object.keys(this.days);
    return keys.length === 0 ? null : keys.reduce((a, b) => (a < b ? a : b));
  }

  /** Real per-day totals for the last `limit` calendar days, oldest first. */
  history(limit: number): HistoryEntry[] {
    const today = this.now();
    const startOfToday = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const todayKey = this.dayKey;
    const out: HistoryEntry[] = [];
    for (let offset = limit - 1; offset >= 0; offset--) {
      const date = new Date(startOfToday);
      date.setDate(date.getDate() - offset);
      const key = dayKeyFor(date);
      const record = this.days[key];
      const total = record
        ? Object.values(record.apps).reduce((a, b) => a + b, 0)
        : 0;
      out.push({
        date,
        label:
          limit > 7
            ? String(date.getDate())
            : date.toLocaleDateString(undefined, { weekday: "short" }),
        total,
        isToday: key === todayKey,
        hasData: record !== undefined,
      });
    }
    return out;
  }

  /**
   * Per-app seconds summed across the given days.
   *
   * Added for the weekly recap, which was reading `today` and printing it under
   * a heading that said "my week" — a wrong number on the one artefact of Loaf
   * that other people see.
   */
  appTotalsAcross(dayKeys: readonly string[]): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const key of dayKeys) {
      const record = this.days[key];
      if (!record) continue;
      for (const [app, seconds] of Object.entries(record.apps)) {
        totals[app] = (totals[app] ?? 0) + seconds;
      }
    }
    return totals;
  }

  /**
   * The peak tab count recorded on each of the given days.
   *
   * Only days that have one appear, because "never measured" and "zero tabs"
   * are different and the recap has to be able to tell them apart.
   */
  peakTabsAcross(dayKeys: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of dayKeys) {
      const record = this.days[key];
      if (record && record.peakTabs > 0) out[key] = record.peakTabs;
    }
    return out;
  }

  /** Seconds active per hour-of-day (0 = midnight), across every recorded day. */
  hourlyHistogram(): number[] {
    const buckets = new Array<number>(24).fill(0);
    for (const record of Object.values(this.days)) {
      for (let h = 0; h < Math.min(24, record.hours.length); h++) {
        buckets[h] += record.hours[h]!;
      }
    }
    return buckets;
  }

  /**
   * One tick of the tracker.
   *
   * @param appName the frontmost app, or null if the platform could not say.
   * @param idleSeconds seconds since the last input, or null if unavailable.
   */
  tick(appName: string | null, idleSeconds: number | null): TickResult {
    const now = this.now();

    // An idle reading the OS would not give us is not evidence of idleness.
    // Treating "unavailable" as "away" would stop the clock permanently on any
    // machine where the call is refused.
    if (idleSeconds !== null && idleSeconds > IDLE_THRESHOLD) {
      this.continuousActiveValue = 0;
      return "idle";
    }

    // A name we could not determine is still time spent — the reference credits
    // it too, under its own label, rather than dropping it. Silently losing the
    // seconds would make the day total disagree with the sum of its rows.
    const name = appName && appName.length > 0 ? appName : "Somewhere mysterious";

    const record = this.days[this.dayKey] ?? emptyDay();
    record.apps[name] = (record.apps[name] ?? 0) + TICK_INTERVAL;
    record.hours[now.getHours()] += TICK_INTERVAL;
    this.days[this.dayKey] = record;

    this.continuousActiveValue += TICK_INTERVAL;
    if (this.continuousActiveValue >= BREAK_INTERVAL) {
      this.continuousActiveValue = 0;
      return "breakDue";
    }
    return "active";
  }

  /**
   * Splits time already credited to a browser down to the domain that was on
   * screen. NEVER adds to the day total — the dashboard relies on that.
   */
  creditSite(browser: string, domain: string, secs: number): void {
    if (!browser || !domain || secs <= 0) return;
    const record = this.days[this.dayKey] ?? emptyDay();
    const forBrowser = record.sites[browser] ?? {};
    forBrowser[domain] = (forBrowser[domain] ?? 0) + secs;
    record.sites[browser] = forBrowser;
    this.days[this.dayKey] = record;
  }

  notePeakTabs(count: number): void {
    if (count <= 0) return;
    const record = this.days[this.dayKey] ?? emptyDay();
    if (count <= record.peakTabs) return;
    record.peakTabs = count;
    this.days[this.dayKey] = record;
  }

  statsMessage(): string {
    if (this.totalToday <= 0) {
      return "Nothing on the books yet.\nGo do something — I'm watching.";
    }
    const lines = [`Today with you: ${formatDuration(this.totalToday)}`];
    const medals = ["🥇", "🥈", "🥉"];
    Object.entries(this.today)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([name, secs], i) => {
        lines.push(`${medals[i]} ${name} — ${formatDuration(secs)}`);
      });
    return lines.join("\n");
  }

  resetToday(): void {
    this.days[this.dayKey] = emptyDay();
    this.continuousActiveValue = 0;
  }

  /**
   * Wipes every domain ever recorded, leaving app totals alone. The radar is
   * the one thing here that needed permission, so it gets its own eject button.
   */
  forgetAllSites(): void {
    for (const record of Object.values(this.days)) {
      record.sites = {};
      record.peakTabs = 0;
    }
  }

  /** The on-disk form. Keep this readable by the Swift app. */
  serialize(): string {
    return JSON.stringify(this.days);
  }
}
