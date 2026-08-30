import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { drawFocusRing, drawFocusPill } from "../src/render/focusRing";
import { drawFlippedText } from "../src/render/text";
import { BADGE_STRIP_Y } from "../src/core/types";
import { rgba } from "../src/core/color";

/**
 * Lowest y among calls that actually place geometry.
 *
 * `drawFlippedText` translates to the baseline and then draws at the origin, so
 * the recording stub — which does not track transforms — sees a literal (0, 0)
 * and would drag the bounding box down to zero.
 */
const geometryMinY = (ctx: RecordingCtx): number => {
  const ys = ctx.calls
    .filter((c) => c.op === "moveTo" || c.op === "lineTo" || c.op === "ellipse")
    .map((c) => (c.op === "ellipse" ? c.args[1]! - c.args[3]! : c.args[1]!));
  return Math.min(...ys);
};

const display = (over: Partial<{ remaining: number; paused: boolean; progress: number }> = {}) => ({
  remaining: 1471,
  paused: false,
  progress: 0.4,
  ...over,
});

describe("the focus ring", () => {
  it("draws spent track plus the remaining arc", () => {
    const ctx = new RecordingCtx();
    drawFocusRing(ctx, display());
    expect(ctx.count("stroke")).toBe(2);
    expect(ctx.count("ellipse")).toBe(2);
  });

  it("omits the arc once it is shorter than its own round cap", () => {
    // Below this it draws as a blob that looks like a bug rather than the last
    // few seconds.
    const ctx = new RecordingCtx();
    drawFocusRing(ctx, display({ progress: 0.999 }));
    expect(ctx.count("stroke")).toBe(1);
  });

  it("shortens the arc as the session runs down", () => {
    const sweep = (progress: number): number => {
      const ctx = new RecordingCtx();
      drawFocusRing(ctx, display({ progress }));
      const arcs = ctx.calls.filter((c) => c.op === "ellipse");
      // args: cx, cy, rx, ry, rotation, start, end, ccw
      const last = arcs[arcs.length - 1]!;
      return Math.abs(last.args[5]! - last.args[6]!);
    };
    expect(sweep(0.75)).toBeLessThan(sweep(0.25));
  });

  it("dims but does not hide the arc when paused", () => {
    // Still has to say "this much is left", just quietly — never mistakable
    // for spent track.
    const running = new RecordingCtx();
    drawFocusRing(running, display({ paused: false }));
    const paused = new RecordingCtx();
    drawFocusRing(paused, display({ paused: true }));
    expect(paused.count("stroke")).toBe(running.count("stroke"));
    expect(paused.paintedColours()).not.toEqual(running.paintedColours());
  });

  it("draws heavier for the pixel grid", () => {
    // A hairline lands under one grid pixel and breaks into dashes.
    const normal = new RecordingCtx();
    drawFocusRing(normal, display(), false);
    const pixel = new RecordingCtx();
    drawFocusRing(pixel, display(), true);
    const weight = (c: RecordingCtx): number =>
      c.calls.find((x) => x.op === "stroke")!.lineWidth;
    expect(weight(pixel)).toBeGreaterThan(weight(normal));
  });

  it("winds from six o'clock, where you can see it", () => {
    // Anchored at twelve, the first and last minutes of every session would
    // drain behind the character.
    const ctx = new RecordingCtx();
    drawFocusRing(ctx, display());
    const arc = ctx.calls.find((c) => c.op === "ellipse")!;
    expect(arc.args[5]).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("stays clear of the badge strip", () => {
    const ctx = new RecordingCtx();
    drawFocusRing(ctx, display());
    expect(ctx.bounds().maxY).toBeLessThan(BADGE_STRIP_Y);
  });

  it("never animates — it is on screen for forty-five minutes", () => {
    // A pulse would be unbearable by minute three. There is no phase input at
    // all, so the same state must render identically every time.
    const a = new RecordingCtx();
    drawFocusRing(a, display());
    const b = new RecordingCtx();
    drawFocusRing(b, display());
    expect(a.signature()).toBe(b.signature());
  });
});

describe("the focus pill", () => {
  it("shows the formatted countdown", () => {
    const ctx = new RecordingCtx();
    drawFocusPill(ctx, display({ remaining: 1471 }));
    expect(ctx.texts).toContain("24:31");
  });

  it("widens for the pause bars so the digits do not shift", () => {
    const width = (paused: boolean): number => {
      const ctx = new RecordingCtx();
      drawFocusPill(ctx, display({ paused }));
      const b = ctx.bounds();
      return b.maxX - b.minX;
    };
    expect(width(true)).toBeGreaterThan(width(false));
  });

  it("draws two bars when paused and none when running", () => {
    // A dimmer pill alone reads as "low contrast", not "stopped".
    const running = new RecordingCtx();
    drawFocusPill(running, display({ paused: false }));
    const paused = new RecordingCtx();
    drawFocusPill(paused, display({ paused: true }));
    expect(paused.count("fill")).toBe(running.count("fill") + 2);
  });

  it("sits in the badge's slot", () => {
    const ctx = new RecordingCtx();
    drawFocusPill(ctx, display());
    expect(geometryMinY(ctx)).toBeGreaterThanOrEqual(168);
  });

  it("balances save and restore around the text flip", () => {
    const ctx = new RecordingCtx();
    drawFocusPill(ctx, display());
    expect(ctx.count("save")).toBe(ctx.count("restore"));
  });
});

describe("text in the flipped space", () => {
  it("un-flips before drawing, or every glyph is upside down", () => {
    // The render context is scaled by -1 in y so the ported art keeps its y-up
    // coordinates. Glyphs do not survive that.
    const ctx = new RecordingCtx();
    drawFlippedText(ctx, "hello", 10, 20, {
      font: "12px sans-serif",
      colour: rgba(0, 0, 0, 1),
    });
    const scale = ctx.calls.find((c) => c.op === "scale");
    expect(scale, "no counter-flip applied").toBeDefined();
    expect(scale!.args[1]).toBe(-1);
    expect(scale!.args[0]).toBe(1);
  });

  it("restores the transform so the flip does not leak", () => {
    const ctx = new RecordingCtx();
    drawFlippedText(ctx, "hello", 10, 20, {
      font: "12px sans-serif",
      colour: rgba(0, 0, 0, 1),
    });
    expect(ctx.count("save")).toBe(ctx.count("restore"));
    expect(ctx.ops()[0]).toBe("save");
    expect(ctx.ops()[ctx.ops().length - 1]).toBe("restore");
  });
});
