import { describe, it, expect } from "vitest";
import {
  remainingFrom,
  progressFrom,
  wordsFor,
  frameFor,
  stepMinutes,
  CIRCUMFERENCE,
  PRESETS,
  type FocusSnapshot,
} from "../src/focus/view";
import { focusBody, FOCUS_CSS } from "../src/focus/markup";
import { isFocusCommand, isFocusSnapshot, parseCommand } from "../src/focus/events";
import { FocusTimer, MemoryStore } from "../src/focus/timer";

const NOW = 1_800_000_000_000;
const snap = (over: Partial<FocusSnapshot> = {}): FocusSnapshot => ({
  state: "idle",
  duration: 1800,
  endsAt: null,
  pausedRemaining: null,
  ...over,
});

describe("deriving the clock from a snapshot", () => {
  it("counts down from the deadline while running", () => {
    // The whole reason the reference has to push a frame four times a second is
    // that its window cannot do this. Ours can, because the timer was already
    // counting to a wall clock.
    const s = snap({ state: "running", endsAt: NOW + 90_000 });
    expect(remainingFrom(s, NOW)).toBe(90);
    expect(remainingFrom(s, NOW + 30_000)).toBe(60);
  });

  it("never goes negative when the deadline has passed", () => {
    const s = snap({ state: "running", endsAt: NOW - 5_000 });
    expect(remainingFrom(s, NOW)).toBe(0);
  });

  it("holds still while paused, whatever the clock does", () => {
    const s = snap({ state: "paused", pausedRemaining: 412 });
    expect(remainingFrom(s, NOW)).toBe(412);
    expect(remainingFrom(s, NOW + 600_000)).toBe(412);
  });

  it("shows the whole planned session while idle", () => {
    expect(remainingFrom(snap({ duration: 2700 }), NOW)).toBe(2700);
  });

  it("is zero once finished", () => {
    expect(remainingFrom(snap({ state: "finished" }), NOW)).toBe(0);
  });

  it("agrees with the timer that produced the snapshot", () => {
    // The two live in different windows and must not drift. This is the test
    // that would fail if either implementation were edited alone.
    let clock = NOW;
    const timer = new FocusTimer({ now: () => clock, store: new MemoryStore() });
    timer.setDurationMinutes(25);
    timer.start();
    clock += 61_000;
    expect(remainingFrom(timer.snapshot, clock)).toBe(timer.remaining);

    timer.pause();
    clock += 500_000;
    expect(remainingFrom(timer.snapshot, clock)).toBe(timer.remaining);
  });

  it("tracks progress from nothing spent to everything", () => {
    const s = snap({ state: "running", duration: 100, endsAt: NOW + 100_000 });
    expect(progressFrom(s, NOW)).toBe(0);
    expect(progressFrom(s, NOW + 50_000)).toBeCloseTo(0.5, 2);
    expect(progressFrom(s, NOW + 100_000)).toBe(1);
  });

  it("does not divide by a zero-length session", () => {
    expect(progressFrom(snap({ duration: 0 }), NOW)).toBe(0);
  });
});

describe("what the window says", () => {
  it("says something different in each of the four states", () => {
    // Four states saying the same sentence would make the window useless at a
    // glance, which is the only way anyone reads a timer.
    const titles = (["idle", "running", "paused", "finished"] as const).map(
      (s) => wordsFor(s, 1800).title,
    );
    expect(new Set(titles).size).toBe(4);
  });

  it("names what the button will do, not what it is", () => {
    expect(wordsFor("idle", 1800).action).toBe("Start");
    expect(wordsFor("running", 1800).action).toBe("Pause");
    expect(wordsFor("paused", 1800).action).toBe("Resume");
    expect(wordsFor("finished", 1800).action).toBe("Start again");
  });

  it("spells the planned length rather than printing seconds", () => {
    expect(wordsFor("idle", 2700).sub).not.toContain("2700");
    expect(wordsFor("running", 2700).sub).toMatch(/^of /);
  });
});

describe("the frame handed to the page", () => {
  it("empties the arc at the start and fills it at the end", () => {
    const running = snap({ state: "running", duration: 100, endsAt: NOW + 100_000 });
    expect(frameFor(running, NOW).dash).toBeCloseTo(CIRCUMFERENCE, 3);
    expect(frameFor(running, NOW + 100_000).dash).toBeCloseTo(0, 3);
  });

  it("flags a clock that has outgrown the dial", () => {
    // Once an hour is on it the string is two characters longer than the dial
    // can hold at full size.
    expect(frameFor(snap({ duration: 1800 }), NOW).long).toBe(false);
    expect(frameFor(snap({ duration: 3 * 3600 }), NOW).long).toBe(true);
  });

  it("re-derives which preset is lit, because the duration moves without a state change", () => {
    // A preset tap or a +/-5 while idle changes the duration and nothing else.
    expect(frameFor(snap({ duration: 45 * 60 }), NOW).minutes).toBe(45);
  });
});

describe("the step buttons", () => {
  it("reads outward from the middle: -5 -1 +1 +5", () => {
    expect(stepMinutes()).toEqual([-5, -1, 1, 5]);
  });
});

describe("commands crossing the bus", () => {
  it("parses what the markup carries", () => {
    expect(parseCommand("toggle")).toEqual({ kind: "toggle" });
    expect(parseCommand("reset")).toEqual({ kind: "reset" });
    expect(parseCommand("preset:45")).toEqual({ kind: "preset", minutes: 45 });
    expect(parseCommand("adjust:-5")).toEqual({ kind: "adjust", minutes: -5 });
  });

  it("returns nothing for a command it does not know", () => {
    for (const junk of ["", "quit", "preset:", "preset:abc", "adjust"]) {
      expect(parseCommand(junk)).toBeNull();
    }
  });

  it("accepts every command the markup can produce", () => {
    const commands = [
      ...PRESETS.map((m) => parseCommand(`preset:${m}`)),
      ...stepMinutes().map((m) => parseCommand(`adjust:${m}`)),
      parseCommand("toggle"),
      parseCommand("reset"),
    ];
    for (const c of commands) expect(isFocusCommand(c)).toBe(true);
  });

  it("refuses a minute value that would reach the timer as NaN", () => {
    // Both `setDurationSeconds` and `adjust` clamp, but a NaN sails through a
    // clamp and puts NaN:NaN on the dial.
    expect(isFocusCommand({ kind: "preset", minutes: NaN })).toBe(false);
    expect(isFocusCommand({ kind: "adjust", minutes: Infinity })).toBe(false);
    expect(isFocusCommand({ kind: "preset", minutes: 99999 })).toBe(false);
    expect(isFocusCommand({ kind: "preset", minutes: "45" })).toBe(false);
    expect(isFocusCommand(null)).toBe(false);
    expect(isFocusCommand({ kind: "explode" })).toBe(false);
  });

  it("accepts a snapshot the timer actually produces", () => {
    const timer = new FocusTimer({ now: () => NOW, store: new MemoryStore() });
    expect(isFocusSnapshot(timer.snapshot)).toBe(true);
    timer.start();
    expect(isFocusSnapshot(timer.snapshot)).toBe(true);
  });

  it("rejects a snapshot it would otherwise draw a clock from", () => {
    for (const junk of [
      null,
      { state: "sprinting", duration: 60, endsAt: null, pausedRemaining: null },
      { state: "idle", duration: "60", endsAt: null, pausedRemaining: null },
      { state: "idle", duration: NaN, endsAt: null, pausedRemaining: null },
      { state: "idle", duration: 60, endsAt: "soon", pausedRemaining: null },
    ]) {
      expect(isFocusSnapshot(junk)).toBe(false);
    }
  });
});

describe("the focus window's markup", () => {
  const body = focusBody(frameFor(snap(), NOW));

  it("offers every preset the timer defines", () => {
    for (const m of PRESETS) expect(body).toContain(`data-focus-cmd="preset:${m}"`);
  });

  it("lights the preset matching the current duration", () => {
    const lit = focusBody(frameFor(snap({ duration: 45 * 60 }), NOW)).match(
      /class="preset on"/g,
    );
    expect(lit).toHaveLength(1);
  });

  it("lights nothing when the duration is between presets", () => {
    // Reachable with +/-1, and a stale highlight would claim a length that is
    // not the one running.
    expect(focusBody(frameFor(snap({ duration: 37 * 60 }), NOW))).not.toContain(
      'class="preset on"',
    );
  });

  it("carries the ids the page updates in place", () => {
    // The page assigns into these every second; a rename here that missed the
    // page would freeze the clock silently.
    for (const id of ["clock", "sub", "pill", "title", "note", "act", "arc"]) {
      expect(body).toContain(`id="${id}"`);
    }
  });

  it("carries no inline handler and no script", () => {
    expect(body).not.toContain("<script");
    expect(body).not.toMatch(/\son[a-z]+=/);
  });

  it("keeps the arc geometry and the dash maths on the same numbers", () => {
    // Splitting these between the CSS and the code is how a resized dial ends up
    // with an arc that no longer closes.
    expect(body).toContain(`stroke-dasharray="${CIRCUMFERENCE.toFixed(3)}"`);
    expect(FOCUS_CSS).toContain("216px");
  });

  it("colours each state differently", () => {
    for (const state of ["running", "paused", "finished"]) {
      expect(FOCUS_CSS).toContain(`body[data-state="${state}"]`);
    }
  });

  it("reserves room for the longer sentence", () => {
    // A frame rewrites the copy without re-measuring the window, so a block that
    // could grow would push the footer out of a window sized for the short one.
    expect(FOCUS_CSS).toContain("min-height:36px");
  });
});
