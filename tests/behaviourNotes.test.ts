import { describe, it, expect } from "vitest";
import {
  AppSwitchWatch,
  OncePer,
  hoppingLine,
  tunnelLine,
  lateNightLine,
  overworkLine,
  HOPPING_THRESHOLD,
  TUNNEL_MINUTES,
  OVERWORK_MULTIPLE,
} from "../src/insights/behaviour";

const MIN = 60_000;
const span = (s: number) => `${Math.round(s / 3600)}h`;

describe("AppSwitchWatch", () => {
  it("counts switches, not ticks", () => {
    const w = new AppSwitchWatch();
    let t = 0;
    for (const app of ["Code", "Code", "Code", "Chrome", "Chrome", "Code"]) {
      w.note(app, (t += MIN));
    }
    expect(w.recent(t)).toBe(2);
  });

  it("forgets switches older than the window", () => {
    const w = new AppSwitchWatch(10 * 60);
    let t = 0;
    w.note("A", (t += MIN));
    w.note("B", (t += MIN));
    w.note("C", (t += MIN));
    expect(w.recent(t)).toBe(2);
    t += 20 * MIN;
    expect(w.recent(t)).toBe(0);
  });

  // Treating "the OS would not say" as a switch would invent app-hopping out
  // of a screen lock.
  it("ignores an unanswered probe", () => {
    const w = new AppSwitchWatch();
    let t = 0;
    w.note("Code", (t += MIN));
    w.note(null, (t += MIN));
    w.note(null, (t += MIN));
    w.note("Code", (t += MIN));
    expect(w.recent(t)).toBe(0);
  });

  it("measures how long you have been in one app", () => {
    const w = new AppSwitchWatch();
    let t = 0;
    w.note("Code", (t += MIN));
    t += 30 * MIN;
    w.note("Code", t);
    expect(Math.round(w.streakSeconds(t) / 60)).toBe(30);
  });

  it("restarts the streak when the app changes", () => {
    const w = new AppSwitchWatch();
    let t = 0;
    w.note("Code", (t += MIN));
    t += 30 * MIN;
    w.note("Chrome", t);
    expect(w.streakSeconds(t)).toBe(0);
    expect(w.app).toBe("Chrome");
  });

  it("can be reset", () => {
    const w = new AppSwitchWatch();
    w.note("Code", MIN);
    w.reset();
    expect(w.recent(MIN)).toBe(0);
    expect(w.app).toBeNull();
  });
});

describe("hoppingLine", () => {
  // Normal work switches apps constantly — editor, browser, terminal.
  it("says nothing about ordinary switching", () => {
    expect(hoppingLine(HOPPING_THRESHOLD - 1)).toBeNull();
  });

  it("states the count once it is unusual", () => {
    const line = hoppingLine(HOPPING_THRESHOLD)!;
    expect(line).toContain(String(HOPPING_THRESHOLD));
    expect(line).toContain("10 minutes");
  });

  // Loaf does not know whether you were hunting for a file or falling apart.
  it("asks rather than diagnoses", () => {
    expect(hoppingLine(12)).toMatch(/\?$/);
  });
});

describe("tunnelLine", () => {
  it("says nothing about a normal stretch", () => {
    expect(tunnelLine("Code", TUNNEL_MINUTES - 1)).toBeNull();
  });

  it("mentions a very long one", () => {
    expect(tunnelLine("Code", 90)).toContain("Code");
  });

  // Two hours in an editor is a good day. Being asked if you are all right
  // would be irritating.
  it("reads as interest, not concern", () => {
    expect(tunnelLine("Code", 90)).toContain("Going well?");
  });

  it("rounds to something a person would say", () => {
    expect(tunnelLine("Code", 97)).toContain("90 minutes");
  });
});

describe("lateNightLine", () => {
  it.each([23, 0, 2, 4])("fires at %i:00", (h) => {
    expect(lateNightLine(h)).toContain("late");
  });

  it.each([5, 9, 14, 22])("stays quiet at %i:00", (h) => {
    expect(lateNightLine(h)).toBeNull();
  });

  // The one behaviour note that comes with something Loaf can do about it.
  it("offers to go quiet", () => {
    expect(lateNightLine(1)).toContain("go quiet");
  });
});

describe("overworkLine", () => {
  const usual = 4 * 3600;

  it("says nothing about an ordinary day", () => {
    expect(overworkLine(usual, usual, span)).toBeNull();
  });

  it("says something about a very long one", () => {
    const long = usual * OVERWORK_MULTIPLE + 1;
    expect(overworkLine(long, usual, span)).toContain("long one");
  });

  // There is no correct number of hours and Loaf is in no position to name one.
  it("measures against your own median, not a general figure", () => {
    const heavy = 9 * 3600;
    // Somebody whose normal IS nine hours hears nothing.
    expect(overworkLine(heavy, heavy, span)).toBeNull();
    // Somebody whose normal is two hours does.
    expect(overworkLine(heavy, 2 * 3600, span)).not.toBeNull();
  });

  it("stays quiet when there is no usual yet", () => {
    expect(overworkLine(9 * 3600, 0, span)).toBeNull();
  });
});

describe("OncePer", () => {
  it("allows the first, refuses the second", () => {
    const gate = new OncePer(60 * 60);
    expect(gate.allow("late", 0)).toBe(true);
    expect(gate.allow("late", 1000)).toBe(false);
  });

  it("allows again after the gap", () => {
    const gate = new OncePer(60 * 60);
    gate.allow("late", 0);
    expect(gate.allow("late", 61 * MIN)).toBe(true);
  });

  it("keeps kinds apart", () => {
    const gate = new OncePer(60 * 60);
    expect(gate.allow("late", 0)).toBe(true);
    expect(gate.allow("hopping", 0)).toBe(true);
  });

  it("can be reset", () => {
    const gate = new OncePer(60 * 60);
    gate.allow("late", 0);
    gate.reset();
    expect(gate.allow("late", 0)).toBe(true);
  });
});

describe("the gate must not be walked through by a changing number", () => {
  // The bug: the caller keyed the gate on the first twelve characters of the
  // message. Three of the four lines begin with a figure that moves, so the
  // key moved with it and the remark re-fired every time the number ticked.
  it("produces a different message as the number changes", () => {
    const span = (s: number) => `${Math.round(s / 3600)}h`;
    const a = overworkLine(9 * 3600, 2 * 3600, span)!;
    const b = overworkLine(11 * 3600, 2 * 3600, span)!;
    expect(a).not.toBe(b);
    // ...which is exactly why the key cannot be derived from the text.
    expect(a.slice(0, 12)).not.toBe(b.slice(0, 12));
  });

  it("holds when keyed on a stable kind instead", () => {
    const gate = new OncePer(2 * 60 * 60);
    expect(gate.allow("overwork", 0)).toBe(true);
    // An hour later, with a different number in the message, still gated.
    expect(gate.allow("overwork", 60 * 60 * 1000)).toBe(false);
    expect(gate.allow("overwork", 3 * 60 * 60 * 1000)).toBe(true);
  });

  it("keeps the four kinds independent", () => {
    const gate = new OncePer(2 * 60 * 60);
    for (const kind of ["overwork", "tunnel", "hopping", "late"]) {
      expect(gate.allow(kind, 0)).toBe(true);
    }
    for (const kind of ["overwork", "tunnel", "hopping", "late"]) {
      expect(gate.allow(kind, 1000)).toBe(false);
    }
  });
});
