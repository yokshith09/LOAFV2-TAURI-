import { describe, it, expect } from "vitest";
import {
  Tracker,
  parseStats,
  parseDay,
  dayKeyFor,
  formatDuration,
  emptyDay,
  TICK_INTERVAL,
  IDLE_THRESHOLD,
  BREAK_INTERVAL,
} from "../src/tracker/tracker";
import { MemoryStatsStore } from "../src/tracker/statsStore";

/** A clock the test moves by hand. */
class Clock {
  constructor(private t: Date) {}
  now = (): Date => new Date(this.t);
  advance(seconds: number): void {
    this.t = new Date(this.t.getTime() + seconds * 1000);
  }
  set(d: Date): void {
    this.t = d;
  }
}

const at = (iso: string): Clock => new Clock(new Date(iso));

/** Run `n` active ticks of the same app, advancing the clock as a real one would. */
const run = (t: Tracker, clock: Clock, app: string, n: number): void => {
  for (let i = 0; i < n; i++) {
    t.tick(app, 0);
    clock.advance(TICK_INTERVAL);
  }
};

describe("accumulating time", () => {
  it("credits the frontmost app one tick at a time", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 3);
    expect(t.today["Xcode"]).toBe(3 * TICK_INTERVAL);
    expect(t.totalToday).toBe(3 * TICK_INTERVAL);
  });

  it("keeps apps apart", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 2);
    run(t, clock, "Safari", 1);
    expect(t.today).toEqual({ Xcode: 10, Safari: 5 });
  });

  it("files each tick under the hour it happened in", () => {
    const clock = at("2026-08-30T09:59:55");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 2); // 09:59:55 and 10:00:00
    const hours = t.hourlyHistogram();
    expect(hours[9]).toBe(TICK_INTERVAL);
    expect(hours[10]).toBe(TICK_INTERVAL);
  });

  it("records time it cannot name rather than dropping it", () => {
    // Dropping it would make the day total disagree with the sum of its rows,
    // and the dashboard adds the rows up.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.tick(null, 0);
    expect(t.totalToday).toBe(TICK_INTERVAL);
    expect(Object.keys(t.today)).toEqual(["Somewhere mysterious"]);
  });

  it("counts an empty app name as unnameable, not as an app called nothing", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.tick("", 0);
    expect(t.today[""]).toBeUndefined();
  });
});

describe("idleness", () => {
  it("credits nothing once you have been away past the threshold", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    expect(t.tick("Xcode", IDLE_THRESHOLD + 1)).toBe("idle");
    expect(t.totalToday).toBe(0);
  });

  it("still counts you at exactly the threshold", () => {
    // The boundary decides whether a three-minute read of the screen is work or
    // absence; it is the comparison most likely to be flipped by a refactor.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    expect(t.tick("Xcode", IDLE_THRESHOLD)).toBe("active");
    expect(t.totalToday).toBe(TICK_INTERVAL);
  });

  it("keeps counting when the OS will not say how idle you are", () => {
    // "Unavailable" is not evidence of absence. Reading it as idle would stop
    // the clock permanently on any machine where the call is refused, and the
    // user would just see a tracker that records nothing.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    expect(t.tick("Xcode", null)).toBe("active");
    expect(t.totalToday).toBe(TICK_INTERVAL);
  });

  it("forgets the streak so a break is not owed the moment you return", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", BREAK_INTERVAL / TICK_INTERVAL - 1);
    t.tick("Xcode", IDLE_THRESHOLD + 1);
    expect(t.continuousActive).toBe(0);
    expect(t.tick("Xcode", 0)).toBe("active");
  });
});

describe("the break nudge", () => {
  it("arrives after a quarter hour of unbroken work", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    const ticks = BREAK_INTERVAL / TICK_INTERVAL;
    for (let i = 0; i < ticks - 1; i++) {
      expect(t.tick("Xcode", 0)).toBe("active");
      clock.advance(TICK_INTERVAL);
    }
    expect(t.tick("Xcode", 0)).toBe("breakDue");
  });

  it("resets after nudging, so it does not fire every tick afterwards", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", BREAK_INTERVAL / TICK_INTERVAL);
    expect(t.continuousActive).toBe(0);
    expect(t.tick("Xcode", 0)).toBe("active");
  });

  it("counts the streak across app switches", () => {
    // The nudge is about time at the machine, not loyalty to one window.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    const ticks = BREAK_INTERVAL / TICK_INTERVAL;
    let last = "active";
    for (let i = 0; i < ticks; i++) {
      last = t.tick(i % 2 === 0 ? "Xcode" : "Safari", 0);
      clock.advance(TICK_INTERVAL);
    }
    expect(last).toBe("breakDue");
  });
});

describe("the turn of the day", () => {
  it("starts a new day at midnight without touching yesterday", () => {
    const clock = at("2026-08-30T23:59:55");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 1); // lands on the 30th
    clock.set(new Date("2026-08-31T00:00:05"));
    run(t, clock, "Safari", 1);

    expect(t.today).toEqual({ Safari: TICK_INTERVAL });
    const days = JSON.parse(t.serialize()) as Record<string, unknown>;
    expect(Object.keys(days).sort()).toEqual(["2026-08-30", "2026-08-31"]);
  });

  it("answers for the new day before the first tick of it", () => {
    // The reference caches the day key and refreshes it inside tick, so between
    // midnight and the next tick "today" still reports yesterday's total — a
    // full day's work, shown as if it had already been done.
    const clock = at("2026-08-30T22:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 4);
    expect(t.totalToday).toBe(20);

    clock.set(new Date("2026-08-31T00:00:01"));
    expect(t.totalToday).toBe(0);
  });

  it("files a site credited after midnight under the new day", () => {
    const clock = at("2026-08-30T23:59:59");
    const t = new Tracker({ now: clock.now });
    clock.set(new Date("2026-08-31T00:00:01"));
    t.creditSite("Google Chrome", "github.com", 5);

    const days = JSON.parse(t.serialize()) as Record<string, { sites: unknown }>;
    expect(Object.keys(days)).toEqual(["2026-08-31"]);
  });
});

describe("the site breakdown", () => {
  it("splits a browser's time without adding to the day", () => {
    // sites is a breakdown OF the browser's total, not extra time on top of it.
    // The dashboard's percentages are wrong the moment this stops holding.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Google Chrome", 4);
    const before = t.totalToday;

    t.creditSite("Google Chrome", "github.com", 10);
    t.creditSite("Google Chrome", "news.example", 10);

    expect(t.totalToday).toBe(before);
    expect(t.totalSiteSecondsToday).toBe(20);
  });

  it("keeps the same domain in two browsers apart", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.creditSite("Google Chrome", "github.com", 30);
    t.creditSite("Safari", "github.com", 12);

    expect(t.todaySitesByBrowser["Google Chrome"]!["github.com"]).toBe(30);
    expect(t.todaySitesByBrowser["Safari"]!["github.com"]).toBe(12);
  });

  it("merges across browsers, biggest first", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.creditSite("Google Chrome", "github.com", 30);
    t.creditSite("Safari", "github.com", 12);
    t.creditSite("Safari", "news.example", 50);

    expect(t.todaySitesMerged()).toEqual([
      { domain: "news.example", seconds: 50 },
      { domain: "github.com", seconds: 42 },
    ]);
  });

  it("remembers the busiest tab count and never lowers it", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.notePeakTabs(9);
    t.notePeakTabs(3);
    expect(t.peakTabsToday).toBe(9);
  });

  it("ignores a tab count of zero", () => {
    // A browser that has just quit reports zero; that is not a new low-water
    // mark, it is the absence of a reading.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.notePeakTabs(9);
    t.notePeakTabs(0);
    expect(t.peakTabsToday).toBe(9);
  });

  it("says whether anything was ever recorded, on any day", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    expect(t.hasAnySiteData).toBe(false);
    t.creditSite("Safari", "github.com", 5);
    expect(t.hasAnySiteData).toBe(true);
  });
});

describe("forgetting", () => {
  it("wipes every domain on every day but leaves app totals alone", () => {
    // The radar is the one thing here that needed permission, so it gets its own
    // eject button — and pressing it must not cost the user their screen time.
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Safari", 3);
    t.creditSite("Safari", "github.com", 15);
    t.notePeakTabs(20);

    t.forgetAllSites();

    expect(t.hasAnySiteData).toBe(false);
    expect(t.peakTabsToday).toBe(0);
    expect(t.totalToday).toBe(15);
  });

  it("clears today only, when today is what was asked for", () => {
    const clock = at("2026-08-29T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 2);
    clock.set(new Date("2026-08-30T10:00:00"));
    run(t, clock, "Safari", 2);

    t.resetToday();

    expect(t.totalToday).toBe(0);
    expect(t.continuousActive).toBe(0);
    const days = JSON.parse(t.serialize()) as Record<string, { apps: object }>;
    expect(days["2026-08-29"]!.apps).toEqual({ Xcode: 10 });
  });
});

describe("reading a file written by the Swift app", () => {
  it("keeps every field of a full record", () => {
    const json = JSON.stringify({
      "2026-08-30": {
        apps: { Xcode: 1200 },
        hours: new Array(24).fill(0).map((_, i) => (i === 10 ? 1200 : 0)),
        sites: { Safari: { "github.com": 600 } },
        peakTabs: 14,
      },
    });
    const clock = at("2026-08-30T12:00:00");
    const t = new Tracker({ json, now: clock.now });

    expect(t.totalToday).toBe(1200);
    expect(t.hourlyHistogram()[10]).toBe(1200);
    expect(t.todaySitesByBrowser["Safari"]!["github.com"]).toBe(600);
    expect(t.peakTabsToday).toBe(14);
  });

  it("survives a record with no sites and no peakTabs", () => {
    // This is the exact file free Loaf writes. The Swift hand-writes its decoder
    // for this case because a synthesised one treats every key as required and
    // throws the user's whole history away on the first paid launch.
    const json = JSON.stringify({
      "2026-08-30": { apps: { Xcode: 60 }, hours: new Array(24).fill(0) },
    });
    const clock = at("2026-08-30T12:00:00");
    const t = new Tracker({ json, now: clock.now });
    expect(t.totalToday).toBe(60);
    expect(t.peakTabsToday).toBe(0);
  });

  it("pads a short hours array instead of reading off the end", () => {
    const day = parseDay({ apps: {}, hours: [5, 5] });
    expect(day.hours).toHaveLength(24);
    expect(day.hours[23]).toBe(0);
  });

  it("ignores extra keys a newer version might add", () => {
    // Forward compatibility runs the same risk backwards: a user who tries a
    // later build and comes back must not lose the days in between.
    const day = parseDay({ apps: { Xcode: 5 }, somethingNew: true });
    expect(day.apps).toEqual({ Xcode: 5 });
  });

  it("reads the v0.1 file, which had no wrapper at all", () => {
    const json = JSON.stringify({ "2026-08-30": { Xcode: 1200, Safari: 300 } });
    const clock = at("2026-08-30T12:00:00");
    const t = new Tracker({ json, now: clock.now });
    expect(t.totalToday).toBe(1500);
    expect(t.today["Xcode"]).toBe(1200);
  });

  it("does not mistake an empty day for the old format", () => {
    // `{}` satisfies "every value is a number" vacuously. Guessing v0.1 there is
    // harmless for that day but the check is what stops the two formats being
    // told apart by luck.
    const parsed = parseStats(JSON.stringify({ "2026-08-30": {} }));
    expect(parsed["2026-08-30"]).toEqual(emptyDay());
  });

  it("starts empty rather than throwing on a truncated file", () => {
    // Half a JSON document is what a crash mid-write leaves. Refusing to launch
    // over it helps nobody.
    expect(parseStats('{"2026-08-30": {"apps":')).toEqual({});
    expect(parseStats("")).toEqual({});
    expect(parseStats(null)).toEqual({});
  });

  it("drops junk values without dropping the day around them", () => {
    const parsed = parseStats(
      JSON.stringify({
        "2026-08-30": { apps: { Xcode: 60, Broken: null, Negative: -5 } },
      }),
    );
    expect(parsed["2026-08-30"]!.apps).toEqual({ Xcode: 60 });
  });

  it("round-trips through its own on-disk form", () => {
    const clock = at("2026-08-30T10:00:00");
    const first = new Tracker({ now: clock.now });
    run(first, clock, "Xcode", 6);
    first.creditSite("Safari", "github.com", 12);
    first.notePeakTabs(7);

    const second = new Tracker({ json: first.serialize(), now: clock.now });
    expect(second.totalToday).toBe(first.totalToday);
    expect(second.todaySitesMerged()).toEqual(first.todaySitesMerged());
    expect(second.peakTabsToday).toBe(7);
    expect(second.serialize()).toBe(first.serialize());
  });
});

describe("history", () => {
  it("returns the window oldest first, ending today", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    const days = t.history(7);
    expect(days).toHaveLength(7);
    expect(days[6]!.isToday).toBe(true);
    expect(dayKeyFor(days[0]!.date)).toBe("2026-08-24");
  });

  it("tells a day with no data apart from a day with no time", () => {
    // The dashboard draws sample bars for days Loaf was not running. Reporting
    // an absent day as a real zero would show a flat line as if measured.
    const clock = at("2026-08-29T10:00:00");
    const t = new Tracker({ now: clock.now });
    t.resetToday(); // a real, recorded, empty day
    clock.set(new Date("2026-08-30T10:00:00"));

    const [, yesterday, today] = t.history(3);
    expect(yesterday!.hasData).toBe(true);
    expect(yesterday!.total).toBe(0);
    expect(today!.hasData).toBe(false);
  });

  it("labels a long window by date and a short one by weekday", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    expect(t.history(30)[29]!.label).toBe("30");
    expect(t.history(7)[6]!.label).not.toBe("30");
  });

  it("sums the hourly histogram across every recorded day", () => {
    const clock = at("2026-08-29T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 2);
    clock.set(new Date("2026-08-30T10:00:00"));
    run(t, clock, "Xcode", 2);
    expect(t.hourlyHistogram()[10]).toBe(4 * TICK_INTERVAL);
  });
});

describe("what it says out loud", () => {
  it("owns up to an empty day", () => {
    const clock = at("2026-08-30T10:00:00");
    expect(new Tracker({ now: clock.now }).statsMessage()).toContain("Nothing on the books");
  });

  it("medals the top three and stops there", () => {
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 5);
    run(t, clock, "Safari", 4);
    run(t, clock, "Slack", 3);
    run(t, clock, "Notes", 2);

    const lines = t.statsMessage().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("Xcode");
    expect(lines[3]).toContain("Slack");
    expect(t.statsMessage()).not.toContain("Notes");
  });

  it("reads durations the way a person would", () => {
    expect(formatDuration(0)).toBe("under a minute");
    expect(formatDuration(59)).toBe("under a minute");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(5430)).toBe("1h 30m");
  });
});

describe("the day key", () => {
  it("is the local date, not the UTC one", () => {
    // A key derived from toISOString rolls over at midnight UTC, which for most
    // of the world lands in the middle of a working afternoon and splits the day
    // in two.
    const evening = new Date(2026, 7, 30, 23, 30, 0);
    expect(dayKeyFor(evening)).toBe("2026-08-30");
  });

  it("pads to a sortable width", () => {
    expect(dayKeyFor(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("the persistence seam", () => {
  it("hands back exactly what was stored", async () => {
    const store = new MemoryStatsStore('{"2026-08-30":{"apps":{"Xcode":60}}}');
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ json: await store.load(), now: clock.now });
    expect(t.totalToday).toBe(60);
  });

  it("takes back what the tracker wrote", async () => {
    const store = new MemoryStatsStore();
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ now: clock.now });
    run(t, clock, "Xcode", 3);
    store.save(t.serialize());

    const reloaded = new Tracker({ json: await store.load(), now: clock.now });
    expect(reloaded.totalToday).toBe(15);
  });
});

describe("the first recorded day", () => {
  it("is null before anything has been recorded", () => {
    const clock = at("2026-08-30T10:00:00");
    expect(new Tracker({ now: clock.now }).firstRecordedDay()).toBeNull();
  });

  it("is the earliest day on file, not the earliest key written", () => {
    // Object key order follows insertion, and a migrated file can arrive in any
    // order at all, so this cannot just take the first key.
    const json = JSON.stringify({
      "2026-08-30": { apps: { Xcode: 5 } },
      "2026-08-01": { apps: { Xcode: 5 } },
      "2026-08-15": { apps: { Xcode: 5 } },
    });
    const clock = at("2026-08-30T10:00:00");
    expect(new Tracker({ json, now: clock.now }).firstRecordedDay()).toBe("2026-08-01");
  });

  it("reaches back past an upgrade rather than starting at today", () => {
    // Standing in for an install date. A real "installed today" marker would
    // throw a migrating user's months of history off the left of every chart.
    const json = JSON.stringify({ "2025-11-04": { apps: { Xcode: 60 } } });
    const clock = at("2026-08-30T10:00:00");
    const t = new Tracker({ json, now: clock.now });
    t.tick("Xcode", 0);
    expect(t.firstRecordedDay()).toBe("2025-11-04");
  });
});

describe("totals across a set of days", () => {
  // Added for the weekly recap, which was reading `today` and printing it
  // under a heading that said "my week".
  const week = JSON.stringify({
    "2026-08-29": { apps: { Chrome: 3600, Code: 1800 }, hours: new Array(24).fill(0), sites: {}, peakTabs: 20 },
    "2026-08-30": { apps: { Chrome: 1800, Mail: 600 }, hours: new Array(24).fill(0), sites: {}, peakTabs: 55 },
    "2026-08-31": { apps: { Code: 7200 }, hours: new Array(24).fill(0), sites: {}, peakTabs: 0 },
  });

  it("adds each app up across the days given", () => {
    const t = new Tracker({ json: week });
    const totals = t.appTotalsAcross(["2026-08-29", "2026-08-30", "2026-08-31"]);
    expect(totals).toEqual({ Chrome: 5400, Code: 9000, Mail: 600 });
  });

  it("ignores days it was not given", () => {
    const t = new Tracker({ json: week });
    expect(t.appTotalsAcross(["2026-08-31"])).toEqual({ Code: 7200 });
  });

  it("skips days with no record rather than inventing a zero", () => {
    const t = new Tracker({ json: week });
    expect(t.appTotalsAcross(["2020-01-01"])).toEqual({});
  });

  // "Never measured" and "zero tabs" are different, and the recap has to be
  // able to tell them apart.
  it("reports peak tabs only for days that have one", () => {
    const t = new Tracker({ json: week });
    const peaks = t.peakTabsAcross(["2026-08-29", "2026-08-30", "2026-08-31"]);
    expect(peaks).toEqual({ "2026-08-29": 20, "2026-08-30": 55 });
  });
});
