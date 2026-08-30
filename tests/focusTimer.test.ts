import { describe, it, expect, vi } from "vitest";
import {
  FocusTimer,
  MemoryStore,
  formatClock,
  spell,
  stretch,
  MAX_DURATION,
  MIN_DURATION,
  PRESETS,
  STALE_AFTER_SECONDS,
} from "../src/focus/timer";

/** A clock the test drives by hand. */
class Clock {
  ms: number;
  constructor(start = 1_700_000_000_000) {
    this.ms = start;
  }
  now = (): number => this.ms;
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

const make = (store = new MemoryStore()) => {
  const clock = new Clock();
  const t = new FocusTimer({ now: clock.now, store });
  return { t, clock, store };
};

describe("formatting", () => {
  it("shows m:ss under an hour and h:mm:ss over", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59)).toBe("0:59");
    expect(formatClock(1471)).toBe("24:31");
    expect(formatClock(3852)).toBe("1:04:12");
  });

  it("floors negatives rather than showing a negative clock", () => {
    expect(formatClock(-30)).toBe("0:00");
  });

  it("spells a human phrase", () => {
    expect(spell(45 * 60)).toBe("45 minutes");
    expect(spell(60)).toBe("1 minute");
    expect(spell(60 * 60)).toBe("1 hour");
    expect(spell(90 * 60)).toBe("1 hour 30");
    expect(spell(2 * 60 * 60)).toBe("2 hours");
  });

  it("never congratulates anyone on negative minutes", () => {
    expect(spell(-180)).toBe("0 minutes");
  });
});

describe("stretch", () => {
  it("keeps the WHOLE session inside the cap, not just the remainder", () => {
    // Clamping only the remainder let a stretched session run past four hours.
    const spent = MAX_DURATION - 600; // ten minutes left of the cap
    expect(stretch(600, 3600, spent)).toBe(600);
  });

  it("never goes below zero", () => {
    expect(stretch(120, -600, 0)).toBe(0);
  });
});

describe("counting down against a wall clock", () => {
  it("derives remaining from the deadline, not from ticks", () => {
    const { t, clock } = make();
    t.setDurationMinutes(45);
    t.start();
    expect(t.remaining).toBe(45 * 60);
    clock.advance(600);
    expect(t.remaining).toBe(45 * 60 - 600);
  });

  it("stays correct across a lid close with no ticks at all", () => {
    // The bug this guards: a tick-decremented clock runs slow while the machine
    // sleeps, so a 45-minute session ends at 52.
    const { t, clock } = make();
    t.setDurationMinutes(45);
    t.start();
    clock.advance(40 * 60); // machine asleep; poll() never called
    expect(t.remaining).toBe(5 * 60);
  });

  it("rounds up so a fresh session reads its full length", () => {
    const { t } = make();
    t.setDurationMinutes(5);
    t.start();
    expect(formatClock(t.remaining)).toBe("5:00");
  });

  it("reports progress from 0 to 1", () => {
    const { t, clock } = make();
    t.setDurationMinutes(10);
    expect(t.progress).toBe(0);
    t.start();
    clock.advance(5 * 60);
    expect(t.progress).toBeCloseTo(0.5, 2);
    clock.advance(5 * 60);
    expect(t.progress).toBe(1);
  });
});

describe("pause and resume are lossless", () => {
  it("does not walk the clock backwards over many pause cycles", () => {
    // THE documented bug: `remaining` rounds UP, so storing the rounded value
    // on pause hands the fraction back every time. Pausing and resuming on a
    // quick rhythm then gains time faster than it loses it and the session
    // never ends.
    const { t, clock } = make();
    t.setDurationMinutes(5);
    t.start();

    for (let i = 0; i < 200; i++) {
      clock.advance(0.4);
      t.pause();
      t.start();
    }
    // 200 x 0.4s = 80 seconds really elapsed. Allow a second of slop, but the
    // buggy version would show MORE than it started with.
    expect(t.remaining).toBeLessThanOrEqual(5 * 60 - 79);
    expect(t.remaining).toBeGreaterThan(5 * 60 - 82);
  });

  it("holds the clock still while paused", () => {
    const { t, clock } = make();
    t.setDurationMinutes(10);
    t.start();
    clock.advance(60);
    t.pause();
    const left = t.remaining;
    clock.advance(600);
    expect(t.remaining).toBe(left);
  });

  it("treats a pause landing exactly on the deadline as a finish", () => {
    // Parking at 0:00 would be a state with nowhere to go.
    const { t, clock } = make();
    t.setDurationMinutes(1);
    t.start();
    clock.advance(60);
    t.pause();
    expect(t.state).toBe("finished");
  });

  it("ignores a second start rather than rewinding the clock", () => {
    // A double-press would otherwise silently re-aim the deadline at the full
    // length.
    const { t, clock } = make();
    t.setDurationMinutes(10);
    t.start();
    clock.advance(120);
    t.start();
    expect(t.remaining).toBe(10 * 60 - 120);
  });
});

describe("adjusting mid-session", () => {
  it("moves the finish line, not the start", () => {
    const { t, clock } = make();
    t.setDurationMinutes(25);
    t.start();
    clock.advance(300); // 20:00 left
    t.adjust(5);
    expect(t.remaining).toBe(25 * 60);
  });

  it("lands exactly where it started after +5 then -5", () => {
    // Holding `spent` fixed across an adjust is what keeps the ring honest.
    // Taking max() of the old and new lengths let duration grow but never come
    // back down, so every pair of presses recorded minutes that never elapsed.
    const { t, clock } = make();
    t.setDurationMinutes(25);
    t.start();
    clock.advance(300);
    const before = { remaining: t.remaining, duration: t.duration };
    t.adjust(5);
    t.adjust(-5);
    expect(t.remaining).toBe(before.remaining);
    expect(t.duration).toBe(before.duration);
  });

  it("finishes rather than bricking when -5 empties a paused session", () => {
    // Without this, the session parks in paused/0:00 where start() has nothing
    // to count and the play button is dead for good.
    const { t, clock } = make();
    t.setDurationMinutes(5);
    t.start();
    clock.advance(60);
    t.pause();
    t.adjust(-5);
    expect(t.state).toBe("finished");
    expect(t.remaining).toBe(0);
  });

  it("keeps a stretched session inside the four-hour cap", () => {
    const { t } = make();
    t.setDurationSeconds(MAX_DURATION);
    t.start();
    t.adjust(60);
    expect(t.duration).toBeLessThanOrEqual(MAX_DURATION);
  });

  it("clamps the chosen length at both ends", () => {
    const { t } = make();
    t.setDurationSeconds(1);
    expect(t.duration).toBe(MIN_DURATION);
    t.setDurationSeconds(99 * 60 * 60);
    expect(t.duration).toBe(MAX_DURATION);
  });

  it("offers the documented presets", () => {
    expect([...PRESETS]).toEqual([5, 15, 30, 45, 60, 90]);
  });
});

describe("finishing", () => {
  it("fires onFinish once, with the time the session actually took", () => {
    const onFinish = vi.fn();
    const { t, clock } = make();
    t.onFinish = onFinish;
    t.setDurationMinutes(5);
    t.start();
    clock.advance(5 * 60);
    t.poll();
    t.poll();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(5 * 60);
  });

  it("quotes the shortened length when cut short by -5", () => {
    // The completion bubble quotes this number, so it has to be one the user
    // would recognise.
    const onFinish = vi.fn();
    const { t, clock } = make();
    t.onFinish = onFinish;
    t.setDurationMinutes(10);
    t.start();
    clock.advance(4 * 60); // 6:00 left
    t.adjust(-10);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]![0]).toBe(4 * 60);
  });

  it("clears the finished state only via acknowledge", () => {
    const { t, clock } = make();
    t.setDurationMinutes(1);
    t.start();
    clock.advance(60);
    t.poll();
    expect(t.state).toBe("finished");
    t.acknowledge();
    expect(t.state).toBe("idle");
  });
});

describe("surviving a quit", () => {
  it("keeps counting a session that is still running", () => {
    const store = new MemoryStore();
    const a = make(store);
    a.t.setDurationMinutes(30);
    a.t.start();
    a.clock.advance(600);

    const b = new FocusTimer({ now: a.clock.now, store });
    expect(b.state).toBe("running");
    expect(b.remaining).toBeCloseTo(20 * 60, -1);
  });

  it("rings for a session that ended moments ago", () => {
    const store = new MemoryStore();
    const a = make(store);
    a.t.setDurationMinutes(5);
    a.t.start();
    a.clock.advance(5 * 60 + 10);

    const b = new FocusTimer({ now: a.clock.now, store });
    expect(b.state).toBe("finished");
  });

  it("silently drops a stale alarm", () => {
    // An alert for a session that ended over lunch is noise, not a reminder.
    const store = new MemoryStore();
    const a = make(store);
    a.t.setDurationMinutes(5);
    a.t.start();
    a.clock.advance(5 * 60 + STALE_AFTER_SECONDS + 30);

    const b = new FocusTimer({ now: a.clock.now, store });
    expect(b.state).toBe("idle");
  });

  it("restores a paused session with its fraction intact", () => {
    const store = new MemoryStore();
    const a = make(store);
    a.t.setDurationMinutes(10);
    a.t.start();
    a.clock.advance(90.4);
    a.t.pause();

    const b = new FocusTimer({ now: a.clock.now, store });
    expect(b.state).toBe("paused");
    expect(b.remaining).toBe(a.t.remaining);
  });

  it("believes the length over a deadline that disagrees with it", () => {
    // A record that disagrees with itself — a clamped duration, a clock
    // corrected backwards, a hand-edited store. remaining > duration would pin
    // the ring at 0% and quote more time left than the session is long.
    const store = new MemoryStore();
    const clock = new Clock();
    store.setItem("pomodoro.state", "running");
    store.setItem("pomodoro.duration", String(10 * 60));
    store.setItem("pomodoro.endDate", String(clock.now() + 99 * 60 * 1000));

    const t = new FocusTimer({ now: clock.now, store });
    expect(t.remaining).toBeLessThanOrEqual(t.duration);
  });

  it("caps a restored paused session at its own length", () => {
    const store = new MemoryStore();
    const clock = new Clock();
    store.setItem("pomodoro.state", "paused");
    store.setItem("pomodoro.duration", String(5 * 60));
    store.setItem("pomodoro.pausedRemaining", String(99 * 60));

    const t = new FocusTimer({ now: clock.now, store });
    expect(t.remaining).toBeLessThanOrEqual(5 * 60);
  });

  it("ignores a corrupt record rather than throwing", () => {
    const store = new MemoryStore();
    store.setItem("pomodoro.state", "banana");
    store.setItem("pomodoro.duration", "not a number");
    expect(() => new FocusTimer({ store })).not.toThrow();
    expect(new FocusTimer({ store }).state).toBe("idle");
  });
});

describe("the shape the behaviour licence consumes", () => {
  it("reports null when no session is active", () => {
    const { t } = make();
    expect(t.display).toBeNull();
  });

  it("reports remaining and paused while active", () => {
    const { t, clock } = make();
    t.setDurationMinutes(5);
    t.start();
    clock.advance(60);
    expect(t.display).toEqual({ remaining: 4 * 60, paused: false });
    t.pause();
    expect(t.display?.paused).toBe(true);
  });
});
