import { describe, it, expect } from "vitest";
import {
  WaterGuide,
  WATER_INTERVAL_SECONDS,
  WATER_PROMPTS,
} from "../src/behaviour/water";
import { PromptRotation } from "../src/bubble/prompts";

/** A clock the test drives, so nothing here waits on the wall. */
function clock(startMs = Date.UTC(2026, 7, 31, 9, 0, 0)) {
  let t = startMs;
  return {
    now: () => t,
    advanceSeconds(s: number) {
      t += s * 1000;
    },
  };
}

const guide = (c: ReturnType<typeof clock>, intervalSeconds = 60) =>
  new WaterGuide({ now: c.now, intervalSeconds });

describe("WaterGuide", () => {
  it("does not ask before the interval is up", () => {
    const c = clock();
    const g = guide(c);
    c.advanceSeconds(59);
    expect(g.askNow(false)).toBe(false);
  });

  it("asks once the interval has passed", () => {
    const c = clock();
    const g = guide(c);
    c.advanceSeconds(60);
    expect(g.askNow(false)).toBe(true);
  });

  // A reminder that stayed due would fire on every following tick, which is how
  // a companion becomes something you quit.
  it("does not ask twice for the same interval", () => {
    const c = clock();
    const g = guide(c);
    c.advanceSeconds(60);
    expect(g.askNow(false)).toBe(true);
    expect(g.askNow(false)).toBe(false);
    c.advanceSeconds(1);
    expect(g.askNow(false)).toBe(false);
  });

  // Skipped, not queued: five suppressed reminders must not arrive together the
  // moment a focus session ends.
  it("skips a suppressed reminder rather than saving it up", () => {
    const c = clock();
    const g = guide(c);
    for (let i = 0; i < 5; i++) {
      c.advanceSeconds(60);
      expect(g.askNow(true)).toBe(false);
    }
    c.advanceSeconds(60);
    expect(g.askNow(false)).toBe(true);
    expect(g.askNow(false)).toBe(false);
  });

  it("counts what the user confirms", () => {
    const c = clock();
    const g = guide(c);
    expect(g.glasses).toBe(0);
    g.noteGlass();
    g.noteGlass();
    expect(g.glasses).toBe(2);
  });

  // Being asked again four minutes after you filled a glass is the behaviour
  // that gets a reminder switched off for good.
  it("restarts the clock when you drink", () => {
    const c = clock();
    const g = guide(c);
    c.advanceSeconds(59);
    g.noteGlass();
    c.advanceSeconds(59);
    expect(g.askNow(false)).toBe(false);
    c.advanceSeconds(1);
    expect(g.askNow(false)).toBe(true);
  });

  it("starts the tally again the next day", () => {
    const c = clock();
    const g = guide(c);
    g.noteGlass();
    expect(g.glasses).toBe(1);
    c.advanceSeconds(24 * 60 * 60);
    expect(g.glasses).toBe(0);
  });

  it("can be told to forget", () => {
    const c = clock();
    const g = guide(c);
    g.noteGlass();
    g.reset();
    expect(g.glasses).toBe(0);
  });

  it("reports how long until the next ask", () => {
    const c = clock();
    const g = guide(c);
    c.advanceSeconds(20);
    expect(g.state.nextInSeconds).toBe(40);
  });

  it("defaults to forty-five minutes", () => {
    expect(WATER_INTERVAL_SECONDS).toBe(45 * 60);
  });

  it("has prompts, and rotates them rather than repeating", () => {
    expect(WATER_PROMPTS.length).toBeGreaterThan(1);
    const r = new PromptRotation(WATER_PROMPTS);
    const seen = WATER_PROMPTS.map(() => r.next());
    expect(new Set(seen).size).toBe(WATER_PROMPTS.length);
  });
});
