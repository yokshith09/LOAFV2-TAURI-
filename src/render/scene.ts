import type { Companion, Ctx2D, SceneState } from "../core/types";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "../core/types";
import { drawEyes, drawFurSpikes } from "./face";

/**
 * Scene orchestration and the design-space transform.
 *
 * Ported from `renderDesignSpace` / `drawCharacter` in `CompanionView.swift`.
 *
 * THE ONE THING TO GET RIGHT HERE is the coordinate flip. The Swift original
 * draws in AppKit's y-up space; Canvas 2D is y-down. Rather than rewriting
 * every bezier literal (thousands of numbers, each an opportunity for a typo),
 * we keep the art authored y-up exactly as in the reference and install a
 * single flip transform here. That is why `catCompanion.ts` can be diffed
 * line-for-line against `CatBreeds.swift`.
 */

export interface FitTransform {
  /** Uniform scale applied to the 170x190 design space. */
  readonly scale: number;
  /** Canvas-space translate applied before the flip. */
  readonly tx: number;
  readonly ty: number;
}

/**
 * Fit the design space into `viewWidth` x `viewHeight`, centred, preserving
 * aspect ratio. Pure so it can be unit-tested without a canvas.
 */
export function computeFit(viewWidth: number, viewHeight: number): FitTransform {
  const scale = Math.min(viewWidth / DESIGN_WIDTH, viewHeight / DESIGN_HEIGHT);
  const drawnW = DESIGN_WIDTH * scale;
  const drawnH = DESIGN_HEIGHT * scale;
  const offsetX = (viewWidth - drawnW) / 2;
  const offsetY = (viewHeight - drawnH) / 2;
  return {
    scale,
    tx: offsetX,
    // Push the origin to the BOTTOM of the drawn area; the -scale below then
    // makes increasing design-y travel upward on screen.
    ty: offsetY + drawnH,
  };
}

/**
 * Map a design-space point to canvas space under a fit transform.
 * Exposed for tests and for hit-testing later (clicking the companion).
 */
export function designToCanvas(
  fit: FitTransform,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: fit.tx + x * fit.scale, y: fit.ty - y * fit.scale };
}

/** Apply the fit + flip to a context. Caller is responsible for save/restore. */
export function applyFit(ctx: Ctx2D, fit: FitTransform): void {
  ctx.translate(fit.tx, fit.ty);
  ctx.scale(fit.scale, -fit.scale);
}

/**
 * Draw one frame of the companion, back to front.
 *
 * Order is load-bearing and matches the Swift: anything behind the body, then
 * the body, then the head, then the shared eyes, then the species' own muzzle.
 * Fur spikes go last so a bristling tantrum reads on top of the silhouette.
 */
export function drawCompanion(ctx: Ctx2D, c: Companion, s: SceneState): void {
  c.drawBehind(ctx, s);
  c.drawBody(ctx, s);
  c.drawHead(ctx, s);

  // Tantrum bristling sits over the head outline but under the face.
  if (s.mood === "tantrum") {
    drawFurSpikes(ctx, c, s.phase);
  }

  // Art that arrives with its own face (a sprite pack) must not get a second
  // set of eyes painted on top of the first.
  if (!c.drawsOwnFace) {
    drawEyes(ctx, c, s);
  }
  c.drawMuzzle(ctx, s);
}

/**
 * Full render into a view of the given size: clears, fits, draws.
 * The caller supplies size explicitly so this stays testable and DPR-agnostic.
 */
export function renderScene(
  ctx: Ctx2D,
  c: Companion,
  s: SceneState,
  viewWidth: number,
  viewHeight: number,
): void {
  ctx.clearRect(0, 0, viewWidth, viewHeight);
  ctx.save();
  applyFit(ctx, computeFit(viewWidth, viewHeight));
  drawCompanion(ctx, c, s);
  ctx.restore();
}
