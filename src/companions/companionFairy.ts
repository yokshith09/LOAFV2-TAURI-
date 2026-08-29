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
import { css, hex, rgba, withAlpha, WHITE } from "../core/color";
import { fillOval, fillRounded, ovalPath } from "../core/draw";

/**
 * Ember — a desk fairy, who does not stay a fairy.
 *
 * Ported from `CompanionFairy.swift`.
 *
 * Past your tab threshold she turns: skin goes crimson, horns come up, the
 * gossamer wings become torn membranes, and the halo becomes a fire ring. Every
 * other companion signals a tantrum with an expression; this one signals it by
 * becoming a different creature, which is the whole reason she is in the
 * closet.
 *
 * The transformation is driven by `mood === "tantrum"` inside each draw method
 * rather than by swapping companions, so the switch is instant, reversible, and
 * the shared eye/outfit/badge machinery keeps working across it.
 */

const DEMON = {
  skin: hex(0xd8404a),
  deep: hex(0x8e1f2e),
  glow: hex(0xff8a3d),
  ember: hex(0xffd36e),
} as const;

export class FairyCompanion implements Companion {
  readonly id = "fairy";
  readonly defaultName = "Ember";
  readonly species = "Desk fairy";
  readonly blurb = "Sweet. Until the tabs. Then: not sweet.";
  readonly group: CompanionGroup = "elsewhere";
  /** She hovers a few inches off the desk. */
  readonly castsShadow = false;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  /**
   * NOTE, carried over from the reference: its comment says the demon form
   * recolours at draw time "because the shared eye drawing reads `palette` and
   * we want her eyes to go molten too — see `eyePalette`".
   *
   * `eyePalette` does not exist anywhere in the Swift codebase. It is stale
   * comment drift: the intent was never implemented, so her eyes stay
   * fairy-purple even as a demon. Ported faithfully rather than inventing the
   * missing feature — if molten eyes are wanted, that is a deliberate change to
   * make, not a bug to quietly fix during a port.
   */
  readonly palette: CompanionPalette = {
    fur: hex(0xf3d9e4),
    furDark: hex(0xc48fb0),
    furLight: hex(0xfff6fa),
    inner: hex(0xb07bc4),
    ink: hex(0x3a2740),
    nose: hex(0xd98ba6),
    blush: rgba(Math.round(0.95 * 255), Math.round(0.55 * 255), Math.round(0.65 * 255), 0.6),
    iris: hex(0x7e5aa8),
  };

  readonly headEllipse: Rect = rect(56, 96, 58, 56);
  readonly eyeLeft: Point = point(75, 124);
  readonly eyeRight: Point = point(95, 124);
  readonly eyeScale = 0.95;
  readonly hatAnchor: Point = point(85, 152);
  readonly neckY = 90;
  readonly handLeft: Point = point(52, 52);
  readonly handRight: Point = point(118, 52);
  get handFill(): Color {
    return this.palette.fur;
  }

  // --- Wings and aura ---

  drawBehind(ctx: Ctx2D, s: SceneState): void {
    const cross = s.mood === "tantrum";
    // Wingbeat: a fast flutter normally, a slow heavy sweep as a demon — a
    // membrane that size does not buzz.
    const beat = Math.sin(s.phase * (cross ? 4.5 : 13)) * (cross ? 0.16 : 0.1);

    for (const dir of [-1, 1]) {
      ctx.save();
      ctx.translate(85, 84);
      ctx.rotate(dir * beat);

      if (cross) {
        // Torn bat membrane: a clawed leading edge with three scalloped bays.
        ctx.beginPath();
        ctx.moveTo(dir * 6, 6);
        ctx.bezierCurveTo(dir * 30, 22, dir * 56, 40, dir * 62, 62);
        for (let i = 0; i < 3; i++) {
          const k = 3 - i;
          ctx.bezierCurveTo(
            dir * (20 * k),
            30 + 6 * k,
            dir * (16 * k),
            16 + 12 * k,
            dir * (14 * k),
            8 + 13 * k,
          );
        }
        ctx.closePath();
        ctx.fillStyle = css(DEMON.deep);
        ctx.fill();
        ctx.strokeStyle = css(withAlpha(DEMON.skin, 0.5));
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else {
        // Gossamer: two translucent lobes per side, upper larger than lower.
        // Kept fairly opaque — at 0.4 alpha tucked behind the head they vanished
        // into the background, and a fairy whose wings you cannot see is just a
        // small person.
        for (const [rx, ry, oy, alpha] of [
          [28, 44, 16, 0.62],
          [20, 28, -16, 0.48],
        ] as const) {
          ctx.save();
          ctx.translate(dir * (rx * 1.05), oy);
          ctx.rotate((dir * -16 * Math.PI) / 180);
          const lobe = rect(-rx, -ry / 2, rx * 2, ry);
          fillOval(ctx, lobe, withAlpha(this.palette.inner, alpha));
          ctx.strokeStyle = css(withAlpha(this.palette.furLight, 0.5));
          ovalPath(ctx, lobe);
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }

    // Halo above, or a ring of fire.
    if (cross) {
      const flick = 0.6 + 0.4 * Math.sin(s.phase * 11);
      [24, 18, 12].forEach((r, i) => {
        fillOval(
          ctx,
          rect(85 - r, 156 - r * 0.32, r * 2, r * 0.64),
          withAlpha(DEMON.glow, (0.3 - i * 0.07) * flick),
        );
      });
    } else {
      const shimmer = 0.5 + 0.5 * Math.sin(s.phase * 2.2);
      ctx.strokeStyle = css(withAlpha(hex(0xffe9a8), 0.35 + shimmer * 0.35));
      ovalPath(ctx, rect(68, 152, 34, 12));
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    const cross = s.mood === "tantrum";
    const skin = cross ? DEMON.skin : this.palette.fur;
    const cloth = cross ? DEMON.deep : this.palette.inner;

    // Floating, so no legs — a dress tapering to a point, with a drifting hem.
    const drift = Math.sin(s.phase * (cross ? 3.2 : 1.6)) * 3;
    ctx.fillStyle = css(cloth);
    ctx.beginPath();
    ctx.moveTo(70, 96);
    ctx.bezierCurveTo(62, 76, 52, 54, 52 + drift, 34);
    ctx.bezierCurveTo(62 + drift, 26, 74, 22, 85, 22);
    ctx.bezierCurveTo(96, 22, 108 - drift, 26, 118 - drift, 34);
    ctx.bezierCurveTo(118, 54, 108, 76, 100, 96);
    ctx.closePath();
    ctx.fill();

    // Ragged hem when she has turned; a soft scalloped one when she has not.
    if (cross) {
      ctx.fillStyle = css(DEMON.deep);
      for (let i = 0; i < 7; i++) {
        const x = 54 + i * 10.5;
        ctx.beginPath();
        ctx.moveTo(x, 30);
        ctx.lineTo(x + 5, 12 - (i % 3) * 3);
        ctx.lineTo(x + 10, 30);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      for (let i = 0; i < 6; i++) {
        const x = 56 + i * 11;
        fillOval(ctx, rect(x - 6, 20, 16, 14), withAlpha(this.palette.furLight, 0.8));
      }
    }

    // Shoulders and arms.
    fillOval(ctx, rect(68, 84, 34, 22), skin);
    for (const x of [52, 100]) {
      fillRounded(ctx, rect(x, 46, 16, 40), 8, skin);
    }
    // Sash / belt.
    fillRounded(
      ctx,
      rect(66, 66, 38, 8),
      4,
      cross ? withAlpha(DEMON.ember, 0.9) : hex(0xffe9a8),
    );
  }

  // --- Head ---

  drawHead(ctx: Ctx2D, s: SceneState): void {
    const cross = s.mood === "tantrum";
    const skin = cross ? DEMON.skin : this.palette.fur;

    // Hair behind the face.
    fillOval(ctx, rect(50, 92, 70, 66), cross ? DEMON.deep : hex(0xe9b7d0));
    if (cross) {
      // Flame-licked hair tips.
      ctx.fillStyle = css(withAlpha(DEMON.glow, 0.8));
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * (0.08 + (0.84 * i) / 5.0);
        const cx = 85 + Math.cos(a) * 36;
        const cy = 124 + Math.sin(a) * 32;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy);
        ctx.bezierCurveTo(cx - 2, cy + 13 + (i % 3) * 3, cx + 3, cy + 9, cx + 4, cy);
        ctx.closePath();
        ctx.fill();
      }
    }

    fillOval(ctx, this.headEllipse, skin);

    if (cross) {
      // Horns. They rise from the forehead and only lean outward near the tip —
      // an earlier version swept them sideways from the temples, which read as a
      // second pair of ears next to the pointed ones.
      for (const dir of [-1, 1]) {
        ctx.fillStyle = css(DEMON.deep);
        ctx.beginPath();
        ctx.moveTo(85 + dir * 8, 143); // inner base
        ctx.bezierCurveTo(
          85 + dir * 10,
          160,
          85 + dir * 19,
          172,
          85 + dir * 27,
          178, // tip
        );
        ctx.bezierCurveTo(
          85 + dir * 27,
          165,
          85 + dir * 25,
          152,
          85 + dir * 22,
          142, // outer base
        );
        ctx.closePath();
        ctx.fill();
        // A lit edge along the front, so they read as solid horn rather than a
        // flat shape cut out of the background.
        ctx.strokeStyle = css(withAlpha(DEMON.skin, 0.55));
        ctx.beginPath();
        ctx.moveTo(85 + dir * 12, 146);
        ctx.bezierCurveTo(
          85 + dir * 13,
          159,
          85 + dir * 19,
          168,
          85 + dir * 25,
          174,
        );
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else {
      // A tiny flower circlet, which is what the horns replace.
      [-16, -6, 5, 15].forEach((dx, i) => {
        const r = i === 1 || i === 2 ? 5 : 4;
        fillOval(
          ctx,
          rect(85 + dx - r, 146 - r, r * 2, r * 2),
          i % 2 === 0 ? hex(0xfff3f7) : hex(0xf6b8ce),
        );
        fillOval(ctx, rect(85 + dx - 1.4, 144.6, 2.8, 2.8), hex(0xffd36e));
      });
    }

    // Ears — pointed, and longer as a demon.
    const earLen = cross ? 17 : 12;
    ctx.fillStyle = css(skin);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(85 + dir * 27, 130);
      ctx.lineTo(85 + dir * (27 + earLen), 130 + earLen * 0.7);
      ctx.lineTo(85 + dir * 26, 118);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const cross = s.mood === "tantrum";
    const ink = cross ? hex(0x51101b) : this.palette.ink;

    if (cross) {
      // A bared grin with two fangs.
      fillOval(ctx, rect(76, 100, 18, 11), ink);
      ctx.fillStyle = css(WHITE);
      for (const dx of [-6, 2]) {
        ctx.beginPath();
        ctx.moveTo(85 + dx, 111);
        ctx.lineTo(85 + dx + 4, 111);
        ctx.lineTo(85 + dx + 2, 104);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(79, 110);
      ctx.bezierCurveTo(82, 104, 88, 104, 91, 110);
      ctx.lineWidth = 1.8;
      ctx.lineCap = "round";
      ctx.strokeStyle = css(withAlpha(ink, 0.85));
      ctx.stroke();
    }

    // Sparks rising when she has turned — the aura that says this is not a
    // mood, it is a form.
    if (cross) {
      for (let i = 0; i < 5; i++) {
        const t = (s.phase * 0.9 + i * 0.2) % 1.0;
        const x = 85 + Math.sin(i * 2.1 + t * 4) * 44;
        const a = (1 - t) * 0.85;
        fillOval(ctx, rect(x - 2, 40 + t * 110, 4, 4), withAlpha(DEMON.ember, a));
      }
    }
  }
}
