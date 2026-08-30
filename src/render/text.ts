import type { Color, Ctx2D } from "../core/types";
import { css } from "../core/color";

/**
 * Drawing text inside the flipped design space.
 *
 * The render context is scaled by -1 in y so the ported art can keep its y-up
 * coordinates. Glyphs do not survive that: calling `fillText` directly under
 * the flip renders every character upside down and mirrored.
 *
 * This un-flips locally — translate to the baseline, flip back, draw at the
 * origin — so callers pass ordinary design-space coordinates and get readable
 * text. It is the only sanctioned way to put type on the companion.
 */
export function drawFlippedText(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  opts: { font: string; colour: Color },
): void {
  ctx.save();
  ctx.font = opts.font;
  ctx.fillStyle = css(opts.colour);
  ctx.translate(x, y);
  ctx.scale(1, -1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Width of `text` in design points at `font`, for laying a pill out around it. */
export function measureFlippedText(
  ctx: Ctx2D,
  text: string,
  font: string,
): number {
  ctx.save();
  ctx.font = font;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}
