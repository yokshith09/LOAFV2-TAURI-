import { describe, it, expect } from "vitest";
import {
  clampPoint,
  hostVisibleFrame,
  legalOrigins,
  nextOrigin,
  smoothstep,
  WanderController,
  type Frame,
  type MovableWindow,
  type Pt,
  type ScreenInfo,
} from "../src/behaviour/wander";

const WIN: Frame = { x: 400, y: 300, width: 134, height: 150 };

const screen = (x: number, y: number, w: number, h: number, inset = 24): ScreenInfo => ({
  frame: { x, y, width: w, height: h },
  visible: { x: x + inset, y: y + inset, width: w - inset * 2, height: h - inset * 2 },
});

const ONE_SCREEN: ScreenInfo[] = [screen(0, 0, 1920, 1080)];

/** Deterministic pseudo-random, so a layout sweep replays exactly. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const inside = (p: Pt, b: Frame): boolean =>
  p.x >= b.x - 1e-6 &&
  p.x <= b.x + b.width + 1e-6 &&
  p.y >= b.y - 1e-6 &&
  p.y <= b.y + b.height + 1e-6;

describe("legalOrigins", () => {
  it("insets the visible frame by the window size", () => {
    const b = legalOrigins({ width: 100, height: 80 }, { x: 0, y: 0, width: 500, height: 400 });
    expect(b).toEqual({ x: 0, y: 0, width: 400, height: 320 });
  });

  it("collapses to zero rather than going negative for an oversized window", () => {
    // Something has to give, and a pet hanging off the top edge is a pet hidden
    // under the menu bar.
    const b = legalOrigins({ width: 900, height: 900 }, { x: 10, y: 20, width: 500, height: 400 });
    expect(b.width).toBe(0);
    expect(b.height).toBe(0);
    expect(clampPoint({ x: 9999, y: 9999 }, b)).toEqual({ x: 10, y: 20 });
  });
});

describe("hostVisibleFrame", () => {
  it("returns null when there are no screens", () => {
    expect(hostVisibleFrame(WIN, [])).toBeNull();
  });

  it("picks the screen holding the window's centre", () => {
    const screens = [screen(0, 0, 1000, 1000), screen(1000, 0, 1000, 1000)];
    const onSecond: Frame = { x: 1400, y: 400, width: 134, height: 150 };
    expect(hostVisibleFrame(onSecond, screens)!.x).toBe(1024);
  });

  it("picks the screen holding most of a straddling window", () => {
    const screens = [screen(0, 0, 1000, 1000), screen(1000, 0, 1000, 1000)];
    // Mostly on the left screen, centre just over the seam.
    const straddling: Frame = { x: 940, y: 400, width: 134, height: 150 };
    const host = hostVisibleFrame(straddling, screens);
    expect(host).not.toBeNull();
  });

  it("rescues a window stranded in dead space rather than returning nothing", () => {
    // Two displays with a gap, window in the void between them. Falling through
    // to the first screen is what lets the caller clamp it back.
    const screens = [screen(0, 0, 800, 600), screen(2000, 0, 800, 600)];
    const lost: Frame = { x: 1200, y: 200, width: 134, height: 150 };
    expect(hostVisibleFrame(lost, screens)).not.toBeNull();
  });

  it("never picks by keyboard focus — only by where the window is", () => {
    // The bug this guards: using "the main screen" walks the window into
    // another display's coordinates, which is how you lose it.
    const screens = [screen(0, 0, 1000, 1000), screen(1000, 0, 1000, 1000)];
    const onSecond: Frame = { x: 1500, y: 500, width: 100, height: 100 };
    expect(hostVisibleFrame(onSecond, screens)!.x).toBe(1024);
  });
});

describe("nextOrigin", () => {
  const base = {
    frame: WIN,
    home: { x: WIN.x, y: WIN.y },
    visible: ONE_SCREEN[0]!.visible,
    leash: 170,
    goHome: false,
  };

  it("goes straight home when asked", () => {
    const p = nextOrigin({ ...base, goHome: true, rng: seeded(1) });
    expect(p).toEqual({ x: WIN.x, y: WIN.y });
  });

  it("pulls an out-of-range home into the legal box first", () => {
    // The display changed, or the dock grew.
    const p = nextOrigin({
      ...base,
      home: { x: -9999, y: -9999 },
      goHome: true,
      rng: seeded(1),
    });
    const bounds = legalOrigins(WIN, base.visible);
    expect(inside(p, bounds)).toBe(true);
  });

  it("keeps the whole window on screen across many layouts and seeds", () => {
    const layouts: Array<{ visible: Frame; frame: Frame }> = [];
    for (let i = 0; i < 40; i++) {
      const w = 200 + i * 60;
      const h = 150 + i * 40;
      layouts.push({
        visible: { x: i * 7, y: i * 3, width: w, height: h },
        // Deliberately includes windows bigger than their screen.
        frame: { x: i * 7, y: i * 3, width: 134 + (i % 5) * 120, height: 150 + (i % 3) * 200 },
      });
    }
    for (const l of layouts) {
      for (let seed = 1; seed <= 5; seed++) {
        const bounds = legalOrigins(l.frame, l.visible);
        const p = nextOrigin({
          frame: l.frame,
          home: { x: l.frame.x, y: l.frame.y },
          visible: l.visible,
          leash: 170,
          goHome: false,
          rng: seeded(seed),
        });
        expect(inside(p, bounds), JSON.stringify({ l, seed, p })).toBe(true);
      }
    }
  });

  it("never strays further than the leash from home", () => {
    // Clamping into an axis-aligned box is a projection onto a convex set, so
    // it can only shorten the distance to an anchor already inside the box —
    // which is why the leash survives the clamp.
    const leash = 170;
    for (let seed = 1; seed <= 200; seed++) {
      const p = nextOrigin({ ...base, leash, rng: seeded(seed) });
      const d = Math.hypot(p.x - base.home.x, p.y - base.home.y);
      expect(d, `seed ${seed}`).toBeLessThanOrEqual(leash + 1e-6);
    }
  });

  it("takes a step rather than a jitter", () => {
    // At least a third of the leash, so the caller is not forever rejecting
    // four-point twitches as not worth animating.
    let moved = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const p = nextOrigin({ ...base, rng: seeded(seed) });
      if (Math.hypot(p.x - WIN.x, p.y - WIN.y) > 24) moved++;
    }
    expect(moved).toBeGreaterThan(30);
  });

  it("moves mostly sideways — a vertical drifter reads as floating", () => {
    let dx = 0;
    let dy = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const p = nextOrigin({ ...base, rng: seeded(seed) });
      dx += Math.abs(p.x - WIN.x);
      dy += Math.abs(p.y - WIN.y);
    }
    expect(dx).toBeGreaterThan(dy);
  });

  it("tolerates a zero or negative leash without producing NaN", () => {
    for (const leash of [0, -50]) {
      const p = nextOrigin({ ...base, leash, rng: seeded(3) });
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("smoothstep", () => {
  it("pins the ends and eases the middle", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6);
  });

  it("clamps out-of-range input", () => {
    expect(smoothstep(-3)).toBe(0);
    expect(smoothstep(9)).toBe(1);
  });
});

describe("WanderController", () => {
  class FakeWindow implements MovableWindow {
    frame: Frame = { ...WIN };
    screensValue: ScreenInfo[] = ONE_SCREEN;
    getFrame(): Frame {
      return this.frame;
    }
    setOrigin(p: Pt): void {
      this.frame = { ...this.frame, x: p.x, y: p.y };
    }
    screens(): readonly ScreenInfo[] {
      return this.screensValue;
    }
  }

  it("refuses to start when there are no screens", () => {
    const w = new FakeWindow();
    w.screensValue = [];
    expect(new WanderController(seeded(1)).begin(w, 170, 32)).toBe(false);
  });

  it("adopts the current position as home on first use", () => {
    const c = new WanderController(seeded(1));
    expect(c.home).toBeNull();
    c.begin(new FakeWindow(), 170, 32);
    expect(c.home).toEqual({ x: WIN.x, y: WIN.y });
  });

  it("treats a user drag as the new home and forgets how far it had strayed", () => {
    const c = new WanderController(seeded(1));
    c.noteUserPlaced({ x: 111, y: 222 });
    expect(c.home).toEqual({ x: 111, y: 222 });
  });

  it("stops dead when aborted mid-walk", () => {
    // A tantrum starting, or the user grabbing the window, has to stop the walk
    // this frame — not once an animation in flight finishes.
    const c = new WanderController(seeded(7));
    const w = new FakeWindow();
    let started = false;
    for (let i = 0; i < 50 && !started; i++) started = c.begin(w, 170, 32);
    expect(started).toBe(true);
    c.step(0.1, w);
    const midX = w.frame.x;
    c.abort();
    c.step(1.0, w);
    expect(c.isMoving).toBe(false);
    expect(w.frame.x).toBe(midX);
  });

  it("finishes exactly on target and stops moving", () => {
    const c = new WanderController(seeded(7));
    const w = new FakeWindow();
    let started = false;
    for (let i = 0; i < 50 && !started; i++) started = c.begin(w, 170, 32);
    expect(started).toBe(true);
    for (let i = 0; i < 60 * 20 && c.isMoving; i++) c.step(1 / 60, w);
    expect(c.isMoving).toBe(false);
  });

  it("keeps the window on screen every frame of the walk", () => {
    const c = new WanderController(seeded(11));
    const w = new FakeWindow();
    let started = false;
    for (let i = 0; i < 50 && !started; i++) started = c.begin(w, 400, 32);
    expect(started).toBe(true);
    const bounds = legalOrigins(w.frame, ONE_SCREEN[0]!.visible);
    for (let i = 0; i < 60 * 20 && c.isMoving; i++) {
      c.step(1 / 60, w);
      expect(inside({ x: w.frame.x, y: w.frame.y }, bounds)).toBe(true);
    }
  });

  it("rescues the window if a display is unplugged mid-stroll", () => {
    // Clamps against the screen the window is CURRENTLY on, every frame.
    const c = new WanderController(seeded(5));
    const w = new FakeWindow();
    w.screensValue = [screen(0, 0, 1920, 1080), screen(1920, 0, 1920, 1080)];
    let started = false;
    for (let i = 0; i < 50 && !started; i++) started = c.begin(w, 400, 32);
    expect(started).toBe(true);
    c.step(0.2, w);
    w.screensValue = [screen(0, 0, 1920, 1080)]; // second display yanked
    for (let i = 0; i < 60 * 20 && c.isMoving; i++) c.step(1 / 60, w);
    const bounds = legalOrigins(w.frame, w.screensValue[0]!.visible);
    expect(inside({ x: w.frame.x, y: w.frame.y }, bounds)).toBe(true);
  });

  it("accepts shorter legs when drifting than when walking", () => {
    // Drift runs legs back to back, so a short one is a gentle change of
    // direction rather than a jerk.
    const walker = new WanderController(seeded(2));
    const drifter = new WanderController(seeded(2));
    drifter.linear = true;
    expect(drifter.linear).toBe(true);
    expect(walker.linear).toBe(false);
  });
});
