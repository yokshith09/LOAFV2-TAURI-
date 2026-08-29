import type { Color, Companion, Ctx2D, Point, SceneState } from "../core/types";
import { point, rectMidX, rectMidY } from "../core/types";
import { css, rgba } from "../core/color";
import { fillOval } from "../core/draw";

/**
 * Shared kit for the wardrobe. Ported from the private helpers at the top of
 * `OutfitStyles.swift`.
 *
 * Every garment is positioned from the companion's anchors — `hatAnchor`,
 * `headEllipse`, `eyeLeft/Right`, `neckY` — and sized as a *fraction of the
 * head*, never in absolute points. That is the whole trick behind one closet
 * fitting a cat with tall pointed ears, a duck with none, and a capybara built
 * like a brick: a garment never learns which head it is on, only how big it is
 * and where the top, the eyes and the neck are.
 */

/**
 * Cloth colours, kept in one place so six garments read as one wardrobe rather
 * than six props that happened to end up on the same animal.
 */
export const Cloth = {
  paper: rgba(255, 249, 242, 1),
  edge: rgba(211, 189, 163, 1),
  ink: rgba(51, 38, 29, 1),
  amber: rgba(255, 178, 94, 1),
  plum: rgba(138, 80, 128, 1),
  plumDeep: rgba(74, 54, 112, 1),
  santa: rgba(194, 64, 44, 1),
  santaDeep: rgba(156, 47, 33, 1),
  leaf: rgba(92, 158, 98, 1),
  leafDeep: rgba(68, 118, 74, 1),
  /**
   * Deeper than `amber` on purpose: several companions are amber-furred, and a
   * pumpkin the colour of the head it sits on is just a lump.
   */
  pumpkin: rgba(229, 115, 45, 1),
  pumpkinDeep: rgba(196, 86, 33, 1),
  petal: rgba(248, 177, 189, 1),
  petalCream: rgba(255, 241, 224, 1),
} as const;

/** The highest y anything worn may touch. Above this is the tab badge's headroom. */
export const CEILING = 164;

/** How far below its base a hat hangs — brims and rims overshoot a little. */
const HAT_UNDERCUT = 0.12;

export interface HatFit {
  /** Centre of the brim. */
  readonly base: Point;
  /** The size unit every part of the hat is a fraction of. */
  readonly u: number;
}

/**
 * Where a hat lands, on a head this file has never met.
 *
 * When a skull is tall (the cat's ears push `hatAnchor` up near the ceiling)
 * the hat first *sinks* further onto it, because a hat worn low still reads as
 * that hat, and only shrinks once it has run out of skull to sink into.
 *
 * @param height the hat's total vertical extent above the base, pom and stem
 * included, as a fraction of `u`. Draw inside `base.y .. base.y + u * height`
 * and you are guaranteed to clear the badge on every species.
 */
export function hatFit(c: Companion, height: number): HatFit {
  // Two limits fight over the size and the smaller wins. Head width is the
  // obvious one. The other is the band between the eyes and the badge: the
  // capybara is 84 across but has its eyes only ~35pt below the ceiling, so a
  // hat sized off its width alone would be worn over its own eyes.
  const brow = Math.max(c.eyeLeft.y, c.eyeRight.y) + c.headEllipse.height * 0.09;
  const unit = Math.min(
    c.headEllipse.width,
    Math.max(0, CEILING - brow) / (height + HAT_UNDERCUT),
  );
  const want = unit * height;
  // Sinking is worth a lot: on the cat, whose ears push the anchor to within
  // 18pt of the ceiling, refusing to sink would shrink a party hat to half
  // size, whereas seating it deeper keeps it full size and still looks snug.
  const sink = Math.min(unit * 0.18, Math.max(0, want - (CEILING - c.hatAnchor.y)));
  const shrink = Math.max(
    0.45,
    Math.min(1, (CEILING - (c.hatAnchor.y - sink)) / Math.max(want, 0.001)),
  );
  // Final min is the belt-and-braces clamp: whatever the anchors claim, the
  // crown cannot end up in the badge.
  const y = Math.min(c.hatAnchor.y - sink, CEILING - want * shrink);
  return { base: point(c.hatAnchor.x, y), u: unit * shrink };
}

/**
 * Authors a tilted garment upright: translate to `origin`, rotate, draw,
 * restore. Mirrors the Swift `inFrame`.
 */
export function inFrame(
  ctx: Ctx2D,
  origin: Point,
  degrees: number,
  body: () => void,
): void {
  ctx.save();
  ctx.translate(origin.x, origin.y);
  if (degrees !== 0) ctx.rotate((degrees * Math.PI) / 180);
  body();
  ctx.restore();
}

export function dot(ctx: Ctx2D, c: Point, r: number, fill: Color): void {
  fillOval(ctx, { x: c.x - r, y: c.y - r, width: r * 2, height: r * 2 }, fill);
}

/**
 * How fast a dangling thing swings. Cross companions swing harder; sleeping
 * ones barely move.
 */
export function swayRate(s: SceneState): number {
  switch (s.mood) {
    case "tantrum":
      return 6.5;
    case "sleeping":
      return 0.6;
    case "happy":
    case "proud":
      return 2.6;
    default:
      return 1.5;
  }
}

/** Centre of a companion's head box, used by the crown and the scarf. */
export function headCentre(c: Companion): Point {
  return point(rectMidX(c.headEllipse), rectMidY(c.headEllipse));
}

/** Set a stroke colour without a fill, for the garments that only outline. */
export function useStroke(ctx: Ctx2D, colour: Color): void {
  ctx.strokeStyle = css(colour);
}
