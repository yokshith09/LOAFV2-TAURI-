/**
 * Drawing the loaf that rises beside the character during a focus session.
 *
 * Drawn in the same 170x190 design space as everything else, on the companion's
 * own canvas, so it scales and pixelates with him for free. It sits low and to
 * one side — beside his feet rather than over him, because the character is the
 * thing you are looking at and a loaf growing across his face would be a worse
 * version of both.
 *
 * The shape is one rounded dome on a base, and that is deliberate: at this size
 * a scored, seeded, artisan loaf is four dark smudges. What has to read at 40
 * pixels is the SILHOUETTE changing — low and flat, then domed — plus the
 * colour going from pale dough to baked. Everything else is detail nobody can
 * see.
 */

import type { Color, Ctx2D, Rect } from "../core/types";
import { rect } from "../core/types";
import { css } from "../core/color";
import type { Bake, LoafKind } from "../bakery/bakery";

/** Where the loaf sits. Left of centre, on the ground line. */
export const LOAF_ANCHOR = { x: 34, y: 15 };

/** Widths by kind, so a longer session is visibly a bigger loaf. */
const WIDTHS: Readonly<Record<LoafKind, number>> = {
  roll: 20,
  bun: 24,
  loaf: 30,
  sourdough: 34,
  cottage: 38,
};

/** Unbaked dough, and the colour it reaches. */
const RAW = { r: 233, g: 219, b: 193, a: 1 };
const BAKED = { r: 176, g: 118, b: 58, a: 1 };
const CRUST = { r: 122, g: 74, b: 32, a: 1 };

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * The dough's colour at a given browning, 0..1.
 *
 * Interpolated rather than stepped: bread does not change colour in stages, and
 * three discrete shades would read as three different objects appearing.
 */
function doughColour(browning: number): Color {
  const t = Math.min(1, Math.max(0, browning));
  return {
    r: mix(RAW.r, BAKED.r, t),
    g: mix(RAW.g, BAKED.g, t),
    b: mix(RAW.b, BAKED.b, t),
    a: 1,
  };
}

/**
 * The loaf's box at a given rise.
 *
 * Width grows a little, height grows a lot. Dough spreads before it domes, so a
 * loaf that scaled evenly would look like a balloon rather than bread.
 */
export function loafBox(bake: Bake): Rect {
  const full = WIDTHS[bake.kind];
  const width = full * (0.72 + 0.28 * bake.rise);
  const height = Math.max(1.5, full * 0.18 + full * 0.42 * bake.rise);
  return rect(LOAF_ANCHOR.x - width / 2, LOAF_ANCHOR.y, width, height);
}

/**
 * Draw the loaf.
 *
 * A no-op for a bake that has not started, so the caller can hand this whatever
 * the oven reports without asking whether there is anything in it.
 */
export function drawLoaf(ctx: Ctx2D, bake: Bake | null): void {
  if (bake === null || bake.rise <= 0.01) return;

  const box = loafBox(bake);
  const colour = doughColour(bake.browning);
  const domeHeight = box.height;

  ctx.save();

  // The body: a flat base with a domed top. Drawn as one path so the fill has
  // no seam down the middle where a rectangle would meet an ellipse.
  ctx.beginPath();
  ctx.moveTo(box.x, box.y);
  ctx.lineTo(box.x + box.width, box.y);
  ctx.bezierCurveTo(
    box.x + box.width,
    box.y + domeHeight * 0.72,
    box.x + box.width * 0.78,
    box.y + domeHeight,
    box.x + box.width / 2,
    box.y + domeHeight,
  );
  ctx.bezierCurveTo(
    box.x + box.width * 0.22,
    box.y + domeHeight,
    box.x,
    box.y + domeHeight * 0.72,
    box.x,
    box.y,
  );
  ctx.closePath();
  ctx.fillStyle = css(colour);
  ctx.fill();

  // A single score across the top, and only once it is browning. An uncooked
  // slash on pale dough reads as a crack, which is the opposite of the message.
  if (bake.browning > 0.15 && box.width > 14) {
    ctx.beginPath();
    ctx.moveTo(box.x + box.width * 0.3, box.y + domeHeight * 0.62);
    ctx.lineTo(box.x + box.width * 0.7, box.y + domeHeight * 0.72);
    ctx.strokeStyle = css(CRUST);
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    ctx.globalAlpha = Math.min(1, bake.browning);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
