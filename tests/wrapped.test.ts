import { describe, it, expect } from "vitest";
import {
  collectWrapped,
  wrappedLines,
  longestStreak,
  worthMaking,
  formatSpan,
  ENOUGH_DAYS_FOR_A_RECAP,
  type WrappedInputs,
} from "../src/wrapped/wrapped";
import type { HistoryEntry } from "../src/tracker/tracker";
import type { BakedLoaf } from "../src/bakery/bakery";

const HOUR = 3600;
const KEYS = [
  "2026-08-25",
  "2026-08-26",
  "2026-08-27",
  "2026-08-28",
  "2026-08-29",
  "2026-08-30",
  "2026-08-31",
];

const day = (total: number, hasData = true): HistoryEntry => ({
  date: new Date(2026, 7, 31),
  label: "Mon",
  total,
  isToday: false,
  hasData,
});

const loaf = (dayKey: string, minutes = 25): BakedLoaf => ({
  kind: "loaf",
  minutes,
  day: dayKey,
  bakedAt: 0,
});

function inputs(over: Partial<WrappedInputs> = {}): WrappedInputs {
  return {
    history: KEYS.map(() => day(2 * HOUR)),
    loaves: [],
    appTotals: { Chrome: 5 * HOUR, Code: 3 * HOUR },
    peakTabsByDay: {},
    dayKeys: KEYS,
    ...over,
  };
}

describe("worthMaking", () => {
  // A recap of a day and a half is the feature failing in public, on the user's
  // own timeline.
  it("refuses a week that has barely happened", () => {
    const history = KEYS.map((_, i) => day(HOUR, i < ENOUGH_DAYS_FOR_A_RECAP - 1));
    expect(worthMaking(history)).toBe(false);
    expect(collectWrapped(inputs({ history }))).toBeNull();
  });

  it("makes one once there is a week worth showing", () => {
    expect(worthMaking(KEYS.map(() => day(HOUR)))).toBe(true);
  });
});

describe("longestStreak", () => {
  it("counts the longest unbroken run", () => {
    const history = [day(1), day(1, false), day(1), day(1), day(1), day(1, false), day(1)];
    expect(longestStreak(history)).toBe(3);
  });

  it("is zero for a week with nothing in it", () => {
    expect(longestStreak(KEYS.map(() => day(0, false)))).toBe(0);
  });

  it("counts a full week", () => {
    expect(longestStreak(KEYS.map(() => day(HOUR)))).toBe(7);
  });
});

describe("collectWrapped", () => {
  it("adds up the week", () => {
    const stats = collectWrapped(inputs())!;
    expect(stats.totalSeconds).toBe(14 * HOUR);
    expect(stats.daysTracked).toBe(7);
    expect(stats.from).toBe(KEYS[0]);
    expect(stats.to).toBe(KEYS[6]);
  });

  it("counts only loaves baked inside the window", () => {
    const stats = collectWrapped(
      inputs({ loaves: [loaf(KEYS[0]!), loaf(KEYS[3]!), loaf("2026-01-01")] }),
    )!;
    expect(stats.sessions).toBe(2);
  });

  it("adds up focused minutes from the loaves", () => {
    const stats = collectWrapped(
      inputs({ loaves: [loaf(KEYS[0]!, 25), loaf(KEYS[1]!, 45)] }),
    )!;
    expect(stats.focusMinutes).toBe(70);
  });

  it("finds the best day", () => {
    const stats = collectWrapped(
      inputs({ loaves: [loaf(KEYS[2]!), loaf(KEYS[2]!), loaf(KEYS[5]!)] }),
    )!;
    expect(stats.bestDay).toEqual({ day: KEYS[2], loaves: 2 });
  });

  it("finds the worst tab day", () => {
    const stats = collectWrapped(
      inputs({ peakTabsByDay: { [KEYS[1]!]: 30, [KEYS[4]!]: 87, "2026-01-01": 200 } }),
    )!;
    expect(stats.worstTabDay).toBe(87);
  });

  // Never measured is not the same as zero.
  it("says nothing about tabs when the radar was never on", () => {
    expect(collectWrapped(inputs())!.worstTabDay).toBeNull();
  });

  it("names the app that took the most time", () => {
    expect(collectWrapped(inputs())!.topApp).toEqual({ name: "Chrome", seconds: 5 * HOUR });
  });

  it("names no app when nothing was tracked", () => {
    expect(collectWrapped(inputs({ appTotals: {} }))!.topApp).toBeNull();
  });
});

describe("wrappedLines", () => {
  const linesFor = (over: Partial<WrappedInputs> = {}) =>
    wrappedLines(collectWrapped(inputs(over))!);

  it("always leads with the time", () => {
    expect(linesFor()[0]!.label).toBe("at the keyboard");
  });

  // "0 focus sessions" on a card someone might post is a sentence nobody needs
  // to read about themselves.
  it("omits a line rather than printing a zero", () => {
    const labels = linesFor().map((l) => l.label);
    expect(labels).not.toContain("loaves baked");
    expect(labels).not.toContain("spent focused");
  });

  it("gets the plural right for one loaf", () => {
    const lines = linesFor({ loaves: [loaf(KEYS[0]!)] });
    expect(lines.find((l) => l.label === "loaf baked")).toBeTruthy();
  });

  it("includes the loaves once there are some", () => {
    const lines = linesFor({ loaves: [loaf(KEYS[0]!), loaf(KEYS[1]!)] });
    expect(lines.find((l) => l.label === "loaves baked")?.value).toBe("2");
  });

  it("does not call a single day a streak", () => {
    const history = [day(HOUR), day(0, false), day(HOUR), day(0, false), day(HOUR), day(HOUR, false), day(HOUR)];
    const lines = wrappedLines(collectWrapped(inputs({ history }))!);
    expect(lines.find((l) => l.label === "in a row")).toBeFalsy();
  });

  // The data does not exist. Inventing a plausible count for a picture people
  // will post is the one thing this product refuses to do.
  it("never claims a tantrum count", () => {
    const text = linesFor().map((l) => `${l.value} ${l.label}`).join(" ");
    expect(text.toLowerCase()).not.toContain("tantrum");
  });

  it("never claims a comparison against other people", () => {
    const text = linesFor().map((l) => `${l.value} ${l.label}`).join(" ");
    expect(text.toLowerCase()).not.toMatch(/than \d+% of|more than most|top \d+%/);
  });
});

describe("formatSpan", () => {
  it("reads naturally", () => {
    expect(formatSpan(45 * 60)).toBe("45m");
    expect(formatSpan(2 * HOUR)).toBe("2h");
    expect(formatSpan(2 * HOUR + 15 * 60)).toBe("2h 15m");
  });
});
