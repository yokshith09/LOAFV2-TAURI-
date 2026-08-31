import { describe, it, expect } from "vitest";
import {
  notesFor,
  quietHourNote,
  busiestAppNote,
  comparedToUsualNote,
  streakNote,
  firstDayNote,
  ENOUGH_FOR_A_DAY,
  ENOUGH_DAYS_FOR_USUAL,
  ENOUGH_TABS_TO_MENTION,
  tabsNote,
  type NoteInputs,
} from "../src/insights/notes";
import type { HistoryEntry } from "../src/tracker/tracker";

const HOUR = 3600;

function day(total: number, opts: { isToday?: boolean; hasData?: boolean } = {}): HistoryEntry {
  return {
    date: new Date(2026, 7, 31),
    label: "Mon",
    total,
    isToday: opts.isToday ?? false,
    hasData: opts.hasData ?? true,
  };
}

function inputs(over: Partial<NoteInputs> = {}): NoteInputs {
  return {
    today: { Chrome: 2 * HOUR },
    totalToday: 2 * HOUR,
    hours: Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 12 ? 1800 : 0)),
    history: [day(2 * HOUR), day(2 * HOUR), day(2 * HOUR), day(2 * HOUR, { isToday: true })],
    ...over,
  };
}

describe("nothing is said about a thin day", () => {
  const thin = inputs({ totalToday: ENOUGH_FOR_A_DAY - 1, today: { Chrome: 60 } });

  it.each([
    ["quiet hour", quietHourNote],
    ["busiest app", busiestAppNote],
    ["compared to usual", comparedToUsualNote],
    ["first day", firstDayNote],
  ])("%s stays quiet", (_name, generate) => {
    expect(generate(thin)).toBeNull();
  });
});

describe("busiestAppNote", () => {
  it("names the app when it dominates the day", () => {
    const n = busiestAppNote(inputs({ today: { Chrome: 3 * HOUR, Code: 1 * HOUR }, totalToday: 4 * HOUR }));
    expect(n?.text).toContain("Chrome");
    expect(n?.text).toContain("75%");
  });

  // "Chrome, 38%" is a table, not an observation.
  it("says nothing when the day was evenly spread", () => {
    const n = busiestAppNote(
      inputs({ today: { Chrome: 2 * HOUR, Code: 2 * HOUR, Mail: 2 * HOUR }, totalToday: 6 * HOUR }),
    );
    expect(n).toBeNull();
  });
});

describe("comparedToUsualNote", () => {
  const past = (totals: number[]) => [
    ...totals.map((t) => day(t)),
    day(0, { isToday: true }),
  ];

  it("waits until there is enough history to have a usual", () => {
    const n = comparedToUsualNote(
      inputs({ history: past([2 * HOUR, 2 * HOUR]).slice(0, ENOUGH_DAYS_FOR_USUAL - 1) }),
    );
    expect(n).toBeNull();
  });

  it("says so when today is much heavier", () => {
    const n = comparedToUsualNote(
      inputs({ totalToday: 6 * HOUR, history: past([2 * HOUR, 2 * HOUR, 2 * HOUR]) }),
    );
    expect(n?.text).toContain("more than usual");
  });

  it("says so when today is much lighter", () => {
    const n = comparedToUsualNote(
      inputs({ totalToday: 1 * HOUR, history: past([4 * HOUR, 4 * HOUR, 4 * HOUR]) }),
    );
    expect(n?.text).toContain("less than usual");
  });

  it("calls an ordinary day ordinary", () => {
    const n = comparedToUsualNote(
      inputs({ totalToday: 2 * HOUR, history: past([2 * HOUR, 2 * HOUR, 2 * HOUR]) }),
    );
    expect(n?.text).toContain("about usual");
  });

  // One eleven-hour day must not redefine normal for the rest of the week.
  it("uses the median, so one outlier does not move usual", () => {
    const n = comparedToUsualNote(
      inputs({ totalToday: 2 * HOUR, history: past([2 * HOUR, 2 * HOUR, 11 * HOUR]) }),
    );
    expect(n?.text).toContain("about usual");
  });

  it("ignores days Loaf was not running", () => {
    const history = [
      day(0, { hasData: false }),
      day(0, { hasData: false }),
      day(2 * HOUR),
      day(2 * HOUR),
      day(2 * HOUR),
      day(2 * HOUR, { isToday: true }),
    ];
    const n = comparedToUsualNote(inputs({ totalToday: 2 * HOUR, history }));
    expect(n?.text).toContain("about usual");
  });
});

describe("quietHourNote", () => {
  it("names an hour that stayed clear", () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 17 && h !== 14 ? 1800 : 0));
    expect(quietHourNote(inputs({ hours }))?.text).toContain("2pm");
  });

  // An hour before you started is trivially clear. True, useless, and it makes
  // the feature look like it is counting rather than noticing.
  it("never names an hour outside the span you were working", () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 17 ? 1800 : 0));
    // 7am and 8am are empty, but they are before the day began.
    expect(quietHourNote(inputs({ hours }))).toBeNull();
  });

  it("says nothing about a day too short to have a middle", () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h === 10 ? 3600 : 0));
    expect(quietHourNote(inputs({ hours }))).toBeNull();
  });

  it("says nothing when every working hour was busy", () => {
    const hours = Array.from({ length: 24 }, () => 1800);
    expect(quietHourNote(inputs({ hours }))).toBeNull();
  });
});

describe("streakNote", () => {
  it("counts consecutive days with data", () => {
    const history = [day(HOUR), day(HOUR), day(HOUR), day(HOUR, { isToday: true })];
    expect(streakNote(inputs({ history }))?.text).toContain("4 days");
  });

  it("stops at the first gap", () => {
    const history = [day(HOUR), day(0, { hasData: false }), day(HOUR), day(HOUR, { isToday: true })];
    expect(streakNote(inputs({ history }))).toBeNull();
  });

  // Two days is a Tuesday and a Wednesday, not a streak.
  it("does not call two days a streak", () => {
    const history = [day(0, { hasData: false }), day(HOUR), day(HOUR, { isToday: true })];
    expect(streakNote(inputs({ history }))).toBeNull();
  });
});

describe("firstDayNote", () => {
  it("is honest about having nothing to compare against", () => {
    const n = firstDayNote(inputs({ history: [day(2 * HOUR, { isToday: true })] }));
    expect(n?.text).toContain("once I've seen a few days");
  });

  it("stops once there is history", () => {
    expect(firstDayNote(inputs())).toBeNull();
  });
});

describe("notesFor", () => {
  it("puts the hardest-won observation first", () => {
    const notes = notesFor(
      inputs({
        totalToday: 6 * HOUR,
        today: { Chrome: 5 * HOUR, Code: 1 * HOUR },
        history: [day(2 * HOUR), day(2 * HOUR), day(2 * HOUR), day(6 * HOUR, { isToday: true })],
      }),
    );
    expect(notes[0]?.kind).toBe("compared-to-usual");
  });

  it("returns nothing at all on a day with nothing in it", () => {
    expect(
      notesFor(inputs({ totalToday: 0, today: {}, hours: new Array(24).fill(0), history: [] })),
    ).toEqual([]);
  });

  it("never repeats a kind", () => {
    const notes = notesFor(inputs());
    const kinds = notes.map((n) => n.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("tabsNote", () => {
  const withTabs = (tabsNow: number | null, pastPeakTabs: number[] = []) =>
    inputs({ tabsNow, pastPeakTabs });

  it("says nothing when the browser will not say", () => {
    expect(tabsNote(withTabs(null))).toBeNull();
  });

  it("says nothing about a handful of tabs", () => {
    expect(tabsNote(withTabs(ENOUGH_TABS_TO_MENTION - 1))).toBeNull();
  });

  it("states the count before it knows your habits", () => {
    expect(tabsNote(withTabs(30))?.text).toBe("30 tabs open.");
  });

  it("compares against your own usual once it has enough days", () => {
    const n = tabsNote(withTabs(40, [10, 12, 11, 13]));
    expect(n?.text).toContain("40 tabs open");
    expect(n?.text).toContain("about 12");
  });

  // "23 vs 21" is a measurement, not an observation.
  it("stays quiet when today is normal for you", () => {
    expect(tabsNote(withTabs(22, [20, 21, 22, 20]))).toBeNull();
  });

  // A person who lives at 60 tabs should not be told about it every day.
  it("does not nag someone whose normal is high", () => {
    expect(tabsNote(withTabs(62, [60, 58, 61, 63]))).toBeNull();
  });

  it("never names a tab", () => {
    const n = tabsNote(withTabs(40, [10, 12, 11]));
    // The whole point: the text is a count and a comparison, nothing else.
    expect(n?.text).toMatch(/^\d+ tabs open( — you usually work with about \d+)?\.$/);
  });
});
