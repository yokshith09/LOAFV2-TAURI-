import type { Companion, Outfit, SceneState } from "../core/types";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "../core/types";
import { computeFit, drawCompanion } from "./scene";

/**
 * Pixel-art mode. Ported from `drawPixelated` in `CompanionView.swift`.
 *
 * A STYLE TOGGLE, NOT A SECOND SET OF SPRITES. The same vector scene is
 * rasterised into a coarse grid with smoothing off, then blown back up with
 * nearest-neighbour sampling. That means every companion — including any added
 * later, and any outfit they are wearing — gets a pixel version for free, and
 * it can never drift out of sync with the vector art.
 *
 * Unlike the rest of the render path this needs a REAL canvas rather than the
 * narrowed `Ctx2D`, because it draws one canvas into another. That is why it
 * lives in its own file: `scene.ts` stays testable in Node against a recording
 * stub, and the browser-only part is quarantined here.
 */

/**
 * Chosen by eye in the reference: coarse enough that the pixels are
 * unmistakably deliberate, fine enough that ears, eyes and the held scroll all
 * survive.
 */
export const PIXEL_GRID = { width: 56, height: 63 } as const;

/** Reused between frames — allocating a canvas per frame is a stutter machine. */
let scratch: HTMLCanvasElement | null = null;

function scratchCanvas(): HTMLCanvasElement {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = PIXEL_GRID.width;
    scratch.height = PIXEL_GRID.height;
  }
  return scratch;
}

/**
 * Render the companion as chunky pixel art into `ctx`.
 *
 * `viewWidth`/`viewHeight` are in CSS pixels, matching `renderScene`.
 */
export function renderPixelScene(
  ctx: CanvasRenderingContext2D,
  c: Companion,
  s: SceneState,
  viewWidth: number,
  viewHeight: number,
  outfit?: Outfit | null,
): void {
  ctx.clearRect(0, 0, viewWidth, viewHeight);

  const small = scratchCanvas();
  const sctx = small.getContext("2d");
  if (!sctx) return;

  // A reused canvas keeps the previous frame; clearing is not optional.
  sctx.clearRect(0, 0, small.width, small.height);
  sctx.save();
  // Hard edges are the whole point — an antialiased downscale is a blurry small
  // picture, not pixel art.
  sctx.imageSmoothingEnabled = false;
  // Squeeze the full design space into the grid, then apply the usual y-flip.
  sctx.translate(0, small.height);
  sctx.scale(small.width / DESIGN_WIDTH, -(small.height / DESIGN_HEIGHT));
  drawCompanion(sctx as unknown as Parameters<typeof drawCompanion>[0], c, s, outfit);
  sctx.restore();

  // Blow it back up with nearest-neighbour, into the same box the vector path
  // would have used, so switching the toggle does not move the character.
  const fit = computeFit(viewWidth, viewHeight);
  const drawnW = DESIGN_WIDTH * fit.scale;
  const drawnH = DESIGN_HEIGHT * fit.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, fit.tx, fit.ty - drawnH, drawnW, drawnH);
  ctx.restore();
}
