import type {
  Color,
  Companion,
  CompanionGroup,
  CompanionPalette,
  Ctx2D,
  Point,
  Rect,
  SceneState,
} from "../core/types";
import { point, rect } from "../core/types";
import { css, hex, rgba, withAlpha } from "../core/color";
import { fillOval } from "../core/draw";

/**
 * Meringue — a small polite ghost, in the house style.
 *
 * Ported from `CompanionGhost.swift`. Two things make this one different from
 * every other companion:
 *
 * 1. **It drifts.** `drifts` is true, so it wanders the screen continuously
 *    rather than sitting where it was put. That is not a habit granted to it;
 *    it is what a ghost is, so it is on by default.
 * 2. **It has an outline.** The rest of the closet is flat fills with no
 *    strokes, which works because they are saturated enough to read against any
 *    wallpaper. A pale ghost is not: on a white desktop a white ghost is a
 *    rumour. The soft periwinkle edge keeps it visible on light backgrounds
 *    without turning it grey, and doubles as the "not quite solid" cue.
 */
export class GhostCompanion implements Companion {
  readonly id = "ghost";
  readonly defaultName = "Meringue";
  readonly species = "Ghost";
  readonly blurb = "Drifts about. Means well. Cannot be held.";
  readonly group: CompanionGroup = "elsewhere";
  /** Ghosts famously don't cast one, and it's floating anyway. */
  readonly castsShadow = false;
  /** The whole point of this character. */
  readonly drifts = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;

  readonly palette: CompanionPalette = {
    fur: hex(0xf4effa), // the sheet itself
    furDark: hex(0xb7a3d6), // the edge, and the tantrum bristles
    furLight: hex(0xffffff),
    inner: hex(0xc9b8e4),
    ink: hex(0x3a3350),
    nose: hex(0xc9b8e4),
    blush: rgba(
      Math.round(0.78 * 255),
      Math.round(0.62 * 255),
      Math.round(0.8 * 255),
      0.55,
    ),
    // Plain dark eyes; an iris reads as alive.
  };

  /** The upper dome. Hats sit on it, blush hangs off it, bristles grow from it. */
  readonly headEllipse: Rect = rect(46, 96, 78, 56);
  readonly eyeLeft: Point = point(71, 120);
  readonly eyeRight: Point = point(99, 120);
  readonly eyeScale = 0.95;
  readonly hatAnchor: Point = point(85, 150);
  /** No neck to speak of — a scarf sits where the body starts to widen. */
  readonly neckY = 92;
  readonly handLeft: Point = point(46, 76);
  readonly handRight: Point = point(124, 76);
  get handFill(): Color {
    return this.palette.fur;
  }

  // --- Behind ---

  /**
   * A faint wisp trailing under the hem, so it reads as hovering over something
   * rather than standing on nothing.
   */
  drawBehind(ctx: Ctx2D, s: SceneState): void {
    const sway = Math.sin(s.phase * 1.1) * 6;
    const widths = [46, 30, 16];
    widths.forEach((w, i) => {
      fillOval(
        ctx,
        rect(85 - w / 2 + sway * 0.3, 26 + i * 4, w, 7),
        withAlpha(this.palette.inner, 0.16 - i * 0.04),
      );
    });
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;

    // Translucent, but only slightly: much below this and the face loses
    // contrast against a busy wallpaper, which is the thing that matters.
    this.silhouettePath(ctx, s);
    ctx.fillStyle = css(withAlpha(p.fur, 0.94));
    ctx.fill();

    // A soft shade down the right and along the hem gives the flat shape some
    // volume without adding a second colour to the silhouette.
    ctx.save();
    this.silhouettePath(ctx, s);
    ctx.clip();
    fillOval(ctx, rect(96, 30, 60, 120), withAlpha(p.inner, 0.35));
    ctx.restore();

    // The edge. See the note at the top of the file — this is the one companion
    // that gets a stroke, and it is what makes it visible on a pale desktop.
    this.silhouettePath(ctx, s);
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.9));
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Little arm nubs, drawn after the edge so they read as part of the sheet.
    for (const [x, dir] of [
      [44, -1],
      [126, 1],
    ] as const) {
      const lift = Math.sin(s.phase * 1.6 + (dir < 0 ? 0 : Math.PI)) * 3;
      const arm = rect(x - 9, 70 + lift, 18, 15);
      fillOval(ctx, arm, withAlpha(p.fur, 0.94));
      // fillOval leaves the ellipse as the current path, so it can be stroked.
      ctx.strokeStyle = css(withAlpha(p.furDark, 0.9));
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
  }

  /**
   * The classic sheet: a domed top on straight shoulders, finished with a row
   * of scallops that travel sideways so the hem ripples instead of pulsing in
   * place.
   *
   * Builds the path without painting — the Swift returns an NSBezierPath and
   * fills, clips and strokes the same object, so this is called once per use.
   */
  private silhouettePath(ctx: Ctx2D, s: SceneState): void {
    const left = 42;
    const right = 128;
    const hem = 48;
    const crown = 152;
    // Cross ghosts pull themselves up and go rigid; sleeping ones sag.
    let stretch: number;
    switch (s.mood) {
      case "tantrum":
        stretch = 8;
        break;
      case "sleeping":
        stretch = -6;
        break;
      case "proud":
      case "happy":
        stretch = 4;
        break;
      default:
        stretch = 0;
    }

    ctx.beginPath();
    ctx.moveTo(left, hem);
    ctx.lineTo(left, 104);
    ctx.bezierCurveTo(
      left,
      crown + stretch - 8,
      60,
      crown + stretch,
      85,
      crown + stretch,
    );
    ctx.bezierCurveTo(
      110,
      crown + stretch,
      right,
      crown + stretch - 8,
      right,
      104,
    );
    ctx.lineTo(right, hem);

    // Four scallops, right to left. The travelling phase term is what makes it
    // ripple along the hem rather than bob as one piece.
    const n = 4;
    const span = (right - left) / n;
    for (let i = 0; i < n; i++) {
      const x1 = right - i * span;
      const x0 = x1 - span;
      const dip = 11 + Math.sin(s.phase * 2.2 - i * 1.1) * 5;
      ctx.bezierCurveTo(
        x1 - span * 0.25,
        hem - dip,
        x0 + span * 0.25,
        hem - dip,
        x0,
        hem,
      );
    }
    ctx.closePath();
  }

  // --- Head and face ---

  /**
   * The head is the top of the same sheet, so there is nothing to draw here —
   * but the shared eye system needs `headEllipse` to be where the face is,
   * and it is.
   */
  drawHead(_ctx: Ctx2D, _s: SceneState): void {
    // Intentionally empty.
  }

  /** No nose. A ghost is a mouth and two eyes. */
  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const y = 104;

    if (s.mood === "tantrum") {
      // A wide open wail.
      fillOval(ctx, rect(77, y - 10, 16, 19), p.ink);
      return;
    }
    if (s.mood === "sleeping") {
      // A small sighing o.
      fillOval(ctx, rect(81, y - 4, 8, 7), withAlpha(p.ink, 0.8));
      return;
    }

    ctx.beginPath();
    if (s.mood === "happy" || s.mood === "proud") {
      ctx.moveTo(76, y + 2);
      ctx.bezierCurveTo(80, y - 8, 90, y - 8, 94, y + 2);
    } else {
      // The default ghost mouth: a soft w, the same one the line-art ghost has.
      ctx.moveTo(77, y + 2);
      ctx.bezierCurveTo(79, y - 5, 83, y - 5, 85, y);
      ctx.bezierCurveTo(87, y - 5, 91, y - 5, 93, y + 2);
    }
    ctx.lineWidth = 2.0;
    ctx.lineCap = "round";
    ctx.strokeStyle = css(withAlpha(p.ink, 0.85));
    ctx.stroke();
  }
}
