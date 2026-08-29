import type { Color, Ctx2D, Point, Rect } from "./types";
import { css } from "./color";

/**
 * Small shared drawing primitives.
 *
 * Ported from the `Draw` enum in `Companion.swift`. Companions are free to use
 * the context directly; these just remove the most repetitive incantations and,
 * more importantly, give AppKit-shaped call sites (`ovalIn:`, `roundedRect:`)
 * a like-for-like Canvas equivalent so the ported geometry stays comparable to
 * the Swift original line by line.
 */

/** Bezier circle constant: how far a control point sits along a 90-degree arc. */
const KAPPA = 0.5522847498307936;

/** `NSBezierPath(ovalIn:)` — an ellipse inscribed in the rect. */
export function ovalPath(ctx: Ctx2D, r: Rect): void {
  const rx = r.width / 2;
  const ry = r.height / 2;
  ctx.beginPath();
  ctx.ellipse(r.x + rx, r.y + ry, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
}

/** Fill an ellipse inscribed in `r`. */
export function fillOval(ctx: Ctx2D, r: Rect, fill: Color): void {
  ctx.fillStyle = css(fill);
  ovalPath(ctx, r);
  ctx.fill();
}

/**
 * `NSBezierPath(roundedRect:xRadius:yRadius:)`.
 *
 * Built from four cubic corner arcs rather than the newer `roundRect`, which is
 * not in every webview we target and is not in our narrowed `Ctx2D` surface.
 */
export function roundedRectPath(ctx: Ctx2D, r: Rect, radius: number): void {
  // A radius past half the shorter side would self-intersect; clamp like AppKit.
  const rad = Math.max(0, Math.min(radius, Math.min(r.width, r.height) / 2));
  const { x, y, width: w, height: h } = r;
  const o = rad * KAPPA;

  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.bezierCurveTo(x + w - rad + o, y, x + w, y + rad - o, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.bezierCurveTo(x + w, y + h - rad + o, x + w - rad + o, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.bezierCurveTo(x + rad - o, y + h, x, y + h - rad + o, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.bezierCurveTo(x, y + rad - o, x + rad - o, y, x + rad, y);
  ctx.closePath();
}

export function fillRounded(ctx: Ctx2D, r: Rect, radius: number, fill: Color): void {
  ctx.fillStyle = css(fill);
  roundedRectPath(ctx, r, radius);
  ctx.fill();
}

/**
 * `NSBezierPath.appendArc(withCenter:radius:startAngle:endAngle:)`.
 *
 * AppKit takes DEGREES and sweeps in the direction of increasing angle, which
 * in a y-up space reads as counter-clockwise. Our context is flipped to y-up,
 * so sweeping from `startDeg` to `endDeg` with the canvas default direction
 * produces the same arc — only the units differ. Like AppKit, this joins the
 * current point to the arc's start with a line rather than beginning a new
 * subpath, which is what lets `block()` chain four corners into one outline.
 */
export function arcDeg(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
): void {
  const rad = (d: number): number => (d * Math.PI) / 180;
  ctx.ellipse(cx, cy, radius, radius, 0, rad(startDeg), rad(endDeg), false);
}

/**
 * A box with independent top and bottom corner radii.
 *
 * `roundedRectPath` can only be uniformly soft. The capybara's snout and rump
 * both want a soft top over a squarer base — the flat-bottomed snout is what
 * makes that face blunt rather than merely wide.
 */
export function blockPath(
  ctx: Ctx2D,
  r: Rect,
  top: number,
  bottom: number,
): void {
  const minX = r.x;
  const maxX = r.x + r.width;
  const minY = r.y;
  const maxY = r.y + r.height;

  ctx.beginPath();
  ctx.moveTo(minX, minY + bottom);
  arcDeg(ctx, minX + bottom, minY + bottom, bottom, 180, 270);
  arcDeg(ctx, maxX - bottom, minY + bottom, bottom, 270, 360);
  arcDeg(ctx, maxX - top, maxY - top, top, 0, 90);
  arcDeg(ctx, minX + top, maxY - top, top, 90, 180);
  ctx.closePath();
}

export function fillBlock(
  ctx: Ctx2D,
  r: Rect,
  top: number,
  bottom: number,
  fill: Color,
): void {
  ctx.fillStyle = css(fill);
  blockPath(ctx, r, top, bottom);
  ctx.fill();
}

/** A round-capped straight stroke. Mirrors `Draw.line`. */
export function line(ctx: Ctx2D, a: Point, b: Point, width: number): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
}

export function strokeLine(
  ctx: Ctx2D,
  a: Point,
  b: Point,
  width: number,
  colour: Color,
): void {
  ctx.strokeStyle = css(colour);
  line(ctx, a, b, width);
}

/**
 * Cubic bezier evaluation — used to ride stripes along a swaying tail.
 * Mirrors `Draw.onCurve`.
 */
export function onCurve(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
