import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { onCurve, ovalPath, roundedRectPath, fillOval, line } from "../src/core/draw";
import { point, rect } from "../src/core/types";
import { hex } from "../src/core/color";

describe("onCurve", () => {
  const p0 = point(0, 0);
  const p1 = point(0, 10);
  const p2 = point(10, 10);
  const p3 = point(10, 0);

  it("returns the start point at t=0", () => {
    expect(onCurve(p0, p1, p2, p3, 0)).toEqual({ x: 0, y: 0 });
  });

  it("returns the end point at t=1", () => {
    const r = onCurve(p0, p1, p2, p3, 1);
    expect(r.x).toBeCloseTo(10, 10);
    expect(r.y).toBeCloseTo(0, 10);
  });

  it("is symmetric about the midpoint for a symmetric curve", () => {
    const mid = onCurve(p0, p1, p2, p3, 0.5);
    expect(mid.x).toBeCloseTo(5, 10);
    expect(mid.y).toBeCloseTo(7.5, 10);
  });

  it("never produces NaN for t in range", () => {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const r = onCurve(p0, p1, p2, p3, t);
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isFinite(r.y)).toBe(true);
    }
  });
});

describe("ovalPath", () => {
  it("centres the ellipse in the rect and halves the extents", () => {
    const ctx = new RecordingCtx();
    ovalPath(ctx, rect(10, 20, 40, 60));
    const e = ctx.calls.find((c) => c.op === "ellipse");
    expect(e).toBeDefined();
    // cx, cy, rx, ry
    expect(e!.args.slice(0, 4)).toEqual([30, 50, 20, 30]);
  });

  it("begins a fresh path so it cannot inherit a previous subpath", () => {
    const ctx = new RecordingCtx();
    ovalPath(ctx, rect(0, 0, 10, 10));
    expect(ctx.ops()[0]).toBe("beginPath");
  });

  it("survives a zero-sized rect without emitting NaN", () => {
    const ctx = new RecordingCtx();
    ovalPath(ctx, rect(5, 5, 0, 0));
    expect(ctx.hasNonFiniteArgs()).toBe(false);
  });
});

describe("roundedRectPath", () => {
  it("clamps the radius to half the shorter side", () => {
    const ctx = new RecordingCtx();
    // radius 999 on a 20x10 rect must not invert the geometry.
    roundedRectPath(ctx, rect(0, 0, 20, 10), 999);
    expect(ctx.hasNonFiniteArgs()).toBe(false);
    const b = ctx.bounds();
    expect(b.minX).toBeGreaterThanOrEqual(-0.001);
    expect(b.maxX).toBeLessThanOrEqual(20.001);
    expect(b.minY).toBeGreaterThanOrEqual(-0.001);
    expect(b.maxY).toBeLessThanOrEqual(10.001);
  });

  it("treats a negative radius as square corners rather than inverting", () => {
    const ctx = new RecordingCtx();
    roundedRectPath(ctx, rect(0, 0, 20, 10), -5);
    expect(ctx.hasNonFiniteArgs()).toBe(false);
    const b = ctx.bounds();
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(20, 6);
  });

  it("closes the path so the fill is watertight", () => {
    const ctx = new RecordingCtx();
    roundedRectPath(ctx, rect(0, 0, 20, 10), 3);
    expect(ctx.ops()).toContain("closePath");
  });

  it("stays inside its rect for a normal radius", () => {
    const ctx = new RecordingCtx();
    roundedRectPath(ctx, rect(66, 16, 15, 42), 7.5);
    const b = ctx.bounds();
    expect(b.minX).toBeGreaterThanOrEqual(65.999);
    expect(b.maxX).toBeLessThanOrEqual(81.001);
    expect(b.minY).toBeGreaterThanOrEqual(15.999);
    expect(b.maxY).toBeLessThanOrEqual(58.001);
  });
});

describe("fillOval", () => {
  it("sets the fill colour before filling", () => {
    const ctx = new RecordingCtx();
    fillOval(ctx, rect(0, 0, 10, 10), hex(0xf6c177));
    const fillCall = ctx.calls.find((c) => c.op === "fill");
    expect(fillCall!.fill).toBe("rgb(246, 193, 119)");
  });
});

describe("line", () => {
  it("emits a round-capped two-point stroke", () => {
    const ctx = new RecordingCtx();
    line(ctx, point(1, 2), point(3, 4), 2.5);
    expect(ctx.ops()).toEqual(["beginPath", "moveTo", "lineTo", "stroke"]);
    expect(ctx.lineCap).toBe("round");
    const strokeCall = ctx.calls.find((c) => c.op === "stroke");
    expect(strokeCall!.lineWidth).toBe(2.5);
  });
});
