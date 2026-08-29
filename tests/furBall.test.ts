import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { FurBall, drawBall, drawSwipe } from "../src/behaviour/furBall";
import { findCompanion } from "../src/companions/registry";
import { DESIGN_WIDTH } from "../src/core/types";

const settle = (b: FurBall, seconds: number, dt = 1 / 60): void => {
  for (let i = 0; i < seconds / dt; i++) b.step(dt);
};

describe("fur ball physics", () => {
  it("falls under gravity", () => {
    const b = new FurBall({ x: 85, y: 120 });
    const y0 = b.y;
    b.step(1 / 60);
    expect(b.y).toBeLessThan(y0);
  });

  it("comes to rest ON the floor, not through it", () => {
    const b = new FurBall({ x: 85, y: 150 });
    settle(b, 6);
    expect(b.y).toBeCloseTo(FurBall.floor + FurBall.radius, 5);
  });

  it("stops bouncing rather than buzzing forever", () => {
    // Below a threshold a "bounce" is a buzz against the floor, not a hop.
    const b = new FurBall({ x: 85, y: 150 });
    settle(b, 8);
    expect(b.vy).toBe(0);
    expect(b.resting).toBe(true);
  });

  it("loses energy on every bounce", () => {
    const b = new FurBall({ x: 85, y: 200 });
    const peaks: number[] = [];
    let last = b.y;
    let rising = false;
    for (let i = 0; i < 60 * 6; i++) {
      b.step(1 / 60);
      if (b.y > last && !rising) rising = true;
      if (b.y < last && rising) {
        peaks.push(last);
        rising = false;
      }
      last = b.y;
    }
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]!).toBeLessThan(peaks[i - 1]!);
    }
  });

  it("bounces off both walls when they are on", () => {
    const left = new FurBall({ x: FurBall.wallLeft + 1, vx: -200 });
    left.step(1 / 60);
    expect(left.x).toBeGreaterThanOrEqual(FurBall.wallLeft);
    expect(left.vx).toBeGreaterThan(0);

    const right = new FurBall({ x: FurBall.wallRight - 1, vx: 200 });
    right.step(1 / 60);
    expect(right.x).toBeLessThanOrEqual(FurBall.wallRight);
    expect(right.vx).toBeLessThan(0);
  });

  it("passes straight through the walls when they are off", () => {
    // The door the game uses to start and end.
    const b = new FurBall({ x: 20, vx: -400, walls: false });
    settle(b, 2);
    expect(b.x).toBeLessThan(FurBall.wallLeft);
  });

  it("reports gone only once well clear of the window", () => {
    const b = new FurBall({ x: 85, walls: false });
    expect(b.gone).toBe(false);
    b.x = -FurBall.radius * 3 - 1;
    expect(b.gone).toBe(true);
    b.x = DESIGN_WIDTH + FurBall.radius * 3 + 1;
    expect(b.gone).toBe(true);
  });

  it("stays inside the window while the walls are on, whatever the speed", () => {
    for (const vx of [-2000, -500, 500, 2000]) {
      const b = new FurBall({ x: 85, vx });
      for (let i = 0; i < 60 * 5; i++) {
        b.step(1 / 60);
        expect(b.x).toBeGreaterThanOrEqual(FurBall.wallLeft - 0.001);
        expect(b.x).toBeLessThanOrEqual(FurBall.wallRight + 0.001);
      }
    }
  });

  it("spins with distance covered, not with time", () => {
    // A ball that spins while sliding is a ball on ice.
    const rolling = new FurBall({ x: 85, vx: 120 });
    rolling.step(1 / 60);
    expect(rolling.spin).not.toBe(0);

    const still = new FurBall({ x: 85 });
    const before = still.spin;
    still.step(1 / 60);
    expect(still.spin).toBe(before);
  });

  it("comes to a complete stop rather than creeping", () => {
    const b = new FurBall({ x: 85, vx: 60 });
    settle(b, 10);
    expect(b.vx).toBe(0);
  });

  it("never produces NaN, whatever the frame time", () => {
    for (const dt of [1 / 240, 1 / 60, 0.25, 1, 5]) {
      const b = new FurBall({ x: 85, y: 150, vx: 90 });
      for (let i = 0; i < 40; i++) b.step(dt);
      expect(Number.isFinite(b.x), `dt ${dt}`).toBe(true);
      expect(Number.isFinite(b.y), `dt ${dt}`).toBe(true);
      expect(Number.isFinite(b.spin), `dt ${dt}`).toBe(true);
    }
  });
});

describe("fur ball art", () => {
  it("draws a shadow, the ball and its windings", () => {
    const ctx = new RecordingCtx();
    drawBall(ctx, new FurBall({ x: 85 }));
    expect(ctx.count("fill")).toBeGreaterThan(2);
    expect(ctx.count("stroke")).toBeGreaterThan(0);
    expect(ctx.hasNonFiniteArgs()).toBe(false);
  });

  it("balances save and restore around the winding clip", () => {
    const ctx = new RecordingCtx();
    drawBall(ctx, new FurBall({ x: 85 }));
    expect(ctx.count("save")).toBe(ctx.count("restore"));
  });

  it("shows the trailing thread only while moving", () => {
    const still = new RecordingCtx();
    drawBall(still, new FurBall({ x: 85 }));
    const fast = new RecordingCtx();
    drawBall(fast, new FurBall({ x: 85, vx: 200 }));
    // The thread is nine line segments; a resting ball has none.
    expect(fast.count("lineTo")).toBeGreaterThan(still.count("lineTo"));
  });

  it("shrinks the contact shadow as the ball leaves the floor", () => {
    const shadowWidth = (y: number): number => {
      const ctx = new RecordingCtx();
      drawBall(ctx, new FurBall({ x: 85, y }));
      // The shadow is the first ellipse emitted.
      return ctx.calls.find((c) => c.op === "ellipse")!.args[2]!;
    };
    expect(shadowWidth(80)).toBeLessThan(shadowWidth(FurBall.floor + FurBall.radius));
  });
});

describe("the paw swipe", () => {
  it("reaches furthest at the midpoint of the swing", () => {
    // t = 0.5 is also the frame the ball is hit on, so contact happens at full
    // extension.
    const reach = (t: number): number => {
      const ctx = new RecordingCtx();
      drawSwipe(ctx, findCompanion("cat-ginger"), -1, t, new FurBall({ x: 30 }));
      return ctx.bounds().minX;
    };
    expect(reach(0.5)).toBeLessThan(reach(0.1));
    expect(reach(0.5)).toBeLessThan(reach(0.9));
  });

  it("draws nothing for pre-rendered art", () => {
    // Painting a bezier paw onto someone's sprite in a palette colour they did
    // not choose looks like a rendering fault.
    const cat = findCompanion("cat-ginger");
    const sprite = Object.create(cat) as typeof cat;
    Object.defineProperty(sprite, "isPreRendered", { value: true });

    const ctx = new RecordingCtx();
    drawSwipe(ctx, sprite, -1, 0.5, new FurBall({ x: 30 }));
    expect(ctx.calls).toHaveLength(0);
  });

  it("outlines the limb, so fur on fur is still visible", () => {
    // Drawn over the character's own body, where a plain fur-coloured limb
    // would be invisible.
    const ctx = new RecordingCtx();
    drawSwipe(ctx, findCompanion("cat-ginger"), -1, 0.5, new FurBall({ x: 30 }));
    const colours = ctx.paintedColours();
    expect(colours.size).toBeGreaterThan(1);
  });

  it("swipes from the correct side", () => {
    const cat = findCompanion("cat-ginger");
    const leftCtx = new RecordingCtx();
    drawSwipe(leftCtx, cat, -1, 0.01, new FurBall({ x: 30 }));
    const rightCtx = new RecordingCtx();
    drawSwipe(rightCtx, cat, 1, 0.01, new FurBall({ x: 140 }));
    // At t~0 the paw is still home, so each starts from its own hand anchor.
    expect(leftCtx.bounds().minX).toBeLessThan(rightCtx.bounds().minX);
  });
});
