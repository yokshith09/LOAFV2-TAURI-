import type { Companion, Ctx2D, Outfit, Rect, SceneState } from "../core/types";
import {
  insetBy,
  point,
  rect,
  rectMaxX,
  rectMaxY,
  rectMidX,
  rectMidY,
  rectMinX,
  rectMinY,
} from "../core/types";
import { css, withAlpha, WHITE } from "../core/color";
import { fillOval, fillRounded, line, roundedRectPath, strokeLine } from "../core/draw";
import { CEILING, Cloth, dot, hatFit, inFrame, swayRate, useStroke } from "./kit";

/**
 * The wardrobe. Ported from `OutfitStyles.swift`.
 *
 * The one thing a garment cannot negotiate is the top of the design space:
 * y 166..190 belongs to the floating tab badge. `hatFit` settles that argument
 * for every hat, so an individual garment only has to stay inside the box it is
 * handed.
 */

// --- Party hat ---------------------------------------------------------------

/**
 * The only one with no month: a party is something you declare, not something
 * the calendar hands you.
 */
export class PartyHatOutfit implements Outfit {
  readonly id = "party";
  readonly name = "Party hat";
  readonly glyph = "🎉";
  readonly months: ReadonlySet<number> = new Set();

  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void {
    // A stubbier cone than a real party hat: every point of height it asks for
    // is a point it has to sink into the skull to get, and a cone worn down
    // over the eyes is worse than a cone that is slightly short.
    const fit = hatFit(companion, 0.37);
    const u = fit.u;
    const h = u * 0.28;
    const w = u * 0.42;
    const pom = u * 0.065;

    // Worn at a slight angle with a lazy wobble — a party hat sitting perfectly
    // straight looks like a traffic cone.
    const tilt = -11 + Math.sin(s.phase * swayRate(s) * 0.8) * 2.5;

    inFrame(ctx, fit.base, tilt, () => {
      const cone = (): void => {
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0);
        ctx.lineTo(0, h);
        ctx.lineTo(w / 2, 0);
        // The brim bows down, so the cone reads as sitting *over* a round skull
        // rather than balancing on a flat cut.
        ctx.bezierCurveTo(w * 0.2, -w * 0.1, -w * 0.2, -w * 0.1, -w / 2, 0);
        ctx.closePath();
      };

      // Plum body, amber stripes — not the other way round. Most companions are
      // warm-furred, and an amber cone on amber fur needs an outline to
      // survive, which this house style does not do.
      cone();
      ctx.fillStyle = css(Cloth.plum);
      ctx.fill();

      // Diagonal stripes, clipped to the cone so they taper with it.
      ctx.save();
      cone();
      ctx.clip();
      ctx.fillStyle = css(Cloth.amber);
      for (const k of [0.16, 0.52]) {
        ctx.beginPath();
        ctx.moveTo(-w, h * k);
        ctx.lineTo(w, h * (k + 0.42));
        ctx.lineTo(w, h * (k + 0.6));
        ctx.lineTo(-w, h * (k + 0.18));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      // The pom sits down over the apex rather than balancing above it, or the
      // point of the cone reads as a spike holding a floating ball.
      const pomC = point(0, h + pom * 0.15);
      dot(ctx, pomC, pom + u * 0.014, Cloth.edge);
      dot(ctx, pomC, pom, Cloth.paper);
    });
  }
}

// --- Flower crown ------------------------------------------------------------

/**
 * Spring. Rides the head's own rim rather than the hat anchor, so it wraps a
 * duck's bald dome and a cat's brow at the same distance from the fur.
 */
export class FlowerCrownOutfit implements Outfit {
  readonly id = "flowers";
  readonly name = "Flower crown";
  readonly glyph = "🌸";
  readonly months: ReadonlySet<number> = new Set([3, 4, 5]);

  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void {
    void s;
    const head = companion.headEllipse;
    const u = head.width;
    const r = u * 0.085;
    const rx = head.width / 2 + u * 0.01;
    const ry = head.height / 2 + u * 0.01;

    // Seven stations along the top of the skull. The arc stops well short of
    // the horizontal — carried lower it stops being a crown and starts being a
    // pair of headphones.
    const stations = Array.from({ length: 7 }, (_, i) => {
      const a = Math.PI * (0.86 - (0.72 * i) / 6.0);
      return point(rectMidX(head) + rx * Math.cos(a), rectMidY(head) + ry * Math.sin(a));
    });
    // Tall heads would push the crown into the badge; drop the whole ring
    // instead of squashing it, so the flowers keep their spacing.
    const highest = Math.max(...stations.map((p) => p.y));
    const overshoot = Math.max(0, highest + r * 1.25 - CEILING);
    const ring = stations.map((p) => point(p.x, p.y - overshoot));

    useStroke(ctx, Cloth.leaf);
    ctx.beginPath();
    ctx.moveTo(ring[0]!.x, ring[0]!.y);
    for (let i = 1; i < ring.length - 1; i += 2) {
      const c = ring[i]!;
      const to = ring[i + 1]!;
      ctx.bezierCurveTo(c.x, c.y, c.x, c.y, to.x, to.y);
    }
    ctx.lineWidth = u * 0.045;
    ctx.lineCap = "round";
    ctx.stroke();

    // Leaves on alternate stations, pushed clear of the vine so they read as
    // leaves rather than as a lump in the stem.
    for (const i of [1, 5]) {
      const p = ring[i]!;
      const outX = p.x - rectMidX(head);
      const outY = p.y - rectMidY(head);
      const n = Math.max(1, Math.hypot(outX, outY));
      const lean = i === 1 ? 40 : -40;
      inFrame(
        ctx,
        point(p.x + (outX / n) * r * 0.45, p.y + (outY / n) * r * 0.45),
        lean,
        () => {
          fillOval(ctx, rect(-r * 0.3, -r * 0.85, r * 0.6, r * 1.7), Cloth.leafDeep);
        },
      );
    }

    // Middle bloom biggest, so the crown has a front rather than reading as a
    // row of identical stickers. Nothing moves with phase on purpose: a woven
    // band sits still, and flowers that bob would be a second animation
    // fighting the one the companion is already doing.
    const blooms: ReadonlyArray<readonly [number, number, typeof Cloth.petal]> = [
      [0, 0.8, Cloth.petalCream],
      [2, 0.95, Cloth.petal],
      [3, 1.15, Cloth.petalCream],
      [4, 0.95, Cloth.petal],
      [6, 0.8, Cloth.petalCream],
    ];
    for (const [i, scale, colour] of blooms) {
      this.flower(ctx, ring[i]!, r * scale, colour, i * 0.7);
    }
  }

  private flower(
    ctx: Ctx2D,
    p: { x: number; y: number },
    r: number,
    petal: typeof Cloth.petal,
    spin: number,
  ): void {
    for (let i = 0; i < 5; i++) {
      const a = spin + i * ((Math.PI * 2) / 5);
      dot(
        ctx,
        point(p.x + Math.cos(a) * r * 0.52, p.y + Math.sin(a) * r * 0.52),
        r * 0.5,
        petal,
      );
    }
    dot(ctx, point(p.x, p.y), r * 0.3, Cloth.amber);
  }
}

// --- Sunglasses --------------------------------------------------------------

/**
 * Summer. The only garment that works off the eye anchors — and the only one
 * drawn on top of features that already exist, since the eyes are drawn by the
 * time an outfit gets its turn. That is the point: the lenses hide them.
 */
export class SunglassesOutfit implements Outfit {
  readonly id = "shades";
  readonly name = "Sunglasses";
  readonly glyph = "😎";
  readonly months: ReadonlySet<number> = new Set([6, 7, 8]);

  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void {
    const head = companion.headEllipse;
    // Sized off the head's *smaller* dimension. The capybara's face is half as
    // tall as it is wide, and lenses scaled to that width cover it like a
    // welding mask.
    const u = Math.min(head.width, head.height * 1.15);
    const l = companion.eyeLeft;
    const rt = companion.eyeRight;
    const gap = Math.max(rt.x - l.x, u * 0.2);

    // Lenses grow to fill the gap but never wider than the face can carry.
    const lw = Math.min(gap * 0.9, u * 0.37);
    const lh = lw * 0.68;
    // They slip down the nose when he dozes off.
    const drop = s.mood === "sleeping" ? lh * 0.42 : 0;
    const midY = (l.y + rt.y) / 2 - drop;

    const lenses: Rect[] = [
      rect(l.x - lw / 2, midY - lh / 2, lw, lh),
      rect(rt.x - lw / 2, midY - lh / 2, lw, lh),
    ];

    // Temples first: they belong behind the lenses.
    useStroke(ctx, Cloth.ink);
    lenses.forEach((lens, i) => {
      const outX = i === 0 ? rectMinX(lens) : rectMaxX(lens);
      const earX =
        i === 0
          ? Math.min(rectMinX(head) + u * 0.02, outX - u * 0.02)
          : Math.max(rectMaxX(head) - u * 0.02, outX + u * 0.02);
      line(
        ctx,
        point(outX, rectMaxY(lens) - lh * 0.22),
        point(earX, rectMaxY(lens) - lh * 0.05),
        u * 0.035,
      );
    });

    for (const lens of lenses) {
      fillRounded(
        ctx,
        insetBy(lens, -u * 0.018, -u * 0.018),
        lh * 0.44,
        Cloth.ink,
      );
      fillRounded(ctx, lens, lh * 0.38, Cloth.plumDeep);

      // A single diagonal glint. Two would read as a cartoon "shine" and stop
      // looking like glass.
      ctx.save();
      roundedRectPath(ctx, lens, lh * 0.38);
      ctx.clip();
      ctx.fillStyle = css(withAlpha(WHITE, 0.22));
      ctx.beginPath();
      ctx.moveTo(rectMinX(lens) + lw * 0.1, rectMinY(lens));
      ctx.lineTo(rectMinX(lens) + lw * 0.42, rectMinY(lens));
      ctx.lineTo(rectMinX(lens) + lw * 0.72, rectMaxY(lens));
      ctx.lineTo(rectMinX(lens) + lw * 0.4, rectMaxY(lens));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Brow bar bridging the two lenses — the line that makes a pair of ovals
    // read as sunglasses at thumbnail size.
    const barX = rectMinX(lenses[0]!) - u * 0.018;
    const barW = rectMaxX(lenses[1]!) + u * 0.018 - barX;
    const bar = rect(barX, rectMaxY(lenses[0]!) - u * 0.012, barW, u * 0.055);
    fillRounded(ctx, bar, bar.height * 0.45, Cloth.ink);
  }
}

// --- Tiny pumpkin hat --------------------------------------------------------

/**
 * October. Sized deliberately small — it is a pumpkin worn as a hat, not a
 * pumpkin the companion is trapped under.
 */
export class PumpkinHatOutfit implements Outfit {
  readonly id = "pumpkin";
  readonly name = "Tiny pumpkin hat";
  readonly glyph = "🎃";
  readonly months: ReadonlySet<number> = new Set([10]);

  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void {
    const fit = hatFit(companion, 0.38);
    const u = fit.u;
    const w = u * 0.42;
    const h = u * 0.27;

    // Top-heavy and only balanced there, so it rocks — barely when calm,
    // properly when the head underneath is shaking.
    const rock =
      -6 + Math.sin(s.phase * swayRate(s) * 0.9) * (s.mood === "tantrum" ? 5 : 1.6);

    inFrame(ctx, fit.base, rock, () => {
      const cy = h * 0.45;

      // Three overlapping ovals: the lobed silhouette is what says "pumpkin" at
      // 20 points wide, long before any detail is legible.
      fillOval(ctx, rect(-w / 2, cy - h * 0.44, w * 0.52, h * 0.88), Cloth.pumpkinDeep);
      fillOval(
        ctx,
        rect(w / 2 - w * 0.52, cy - h * 0.44, w * 0.52, h * 0.88),
        Cloth.pumpkinDeep,
      );
      fillOval(ctx, rect(-w * 0.34, cy - h / 2, w * 0.68, h), Cloth.pumpkin);

      // Ribs: two short arcs, not a full grid — more than that turns to mud.
      useStroke(ctx, withAlpha(Cloth.pumpkinDeep, 0.85));
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(dir * w * 0.13, cy + h * 0.42);
        ctx.bezierCurveTo(
          dir * w * 0.24,
          cy + h * 0.18,
          dir * w * 0.24,
          cy - h * 0.18,
          dir * w * 0.13,
          cy - h * 0.42,
        );
        ctx.lineWidth = u * 0.022;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      useStroke(ctx, Cloth.leafDeep);
      ctx.beginPath();
      ctx.moveTo(0, cy + h * 0.3);
      ctx.bezierCurveTo(
        0,
        cy + h * 0.5,
        u * 0.055,
        cy + h * 0.5,
        u * 0.045,
        cy + h * 0.5 + u * 0.075,
      );
      ctx.lineWidth = u * 0.045;
      ctx.lineCap = "round";
      ctx.stroke();

      inFrame(ctx, point(-u * 0.055, cy + h * 0.44), -28, () => {
        fillOval(ctx, rect(-u * 0.055, -u * 0.022, u * 0.11, u * 0.044), Cloth.leaf);
      });
    });
  }
}

// --- Cosy scarf --------------------------------------------------------------

/**
 * November. The one garment that hangs off `neckY` rather than the skull, and
 * the one that moves: the loose end swings on phase, harder when cross.
 */
export class ScarfOutfit implements Outfit {
  readonly id = "scarf";
  readonly name = "Cosy scarf";
  readonly glyph = "🧣";
  readonly months: ReadonlySet<number> = new Set([11]);

  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void {
    const head = companion.headEllipse;
    const u = head.width;
    const y = companion.neckY;
    const w = u * 0.86;
    const band = u * 0.17;
    const mid = rectMidX(head);

    // The loose end drops from the knot. Whatever neckY a species declares, the
    // fringe stops a good margin above the ground plane rather than pooling on
    // the floor.
    const knotX = mid + u * 0.2;
    const tailTop = y - band * 0.15;
    const len = Math.max(u * 0.22, Math.min(u * 0.55, tailTop - 26));
    const sway = Math.sin(s.phase * swayRate(s)) * u * 0.07;
    const tw = u * 0.15;

    const tail = (): void => {
      ctx.beginPath();
      ctx.moveTo(knotX - tw / 2, tailTop);
      ctx.bezierCurveTo(
        knotX - tw / 2 - sway * 0.3,
        tailTop - len * 0.45,
        knotX - tw / 2 + sway * 0.7,
        tailTop - len * 0.8,
        knotX - tw / 2 + sway,
        tailTop - len,
      );
      ctx.lineTo(knotX + tw / 2 + sway, tailTop - len);
      ctx.bezierCurveTo(
        knotX + tw / 2 + sway * 0.7,
        tailTop - len * 0.8,
        knotX + tw / 2 - sway * 0.3,
        tailTop - len * 0.45,
        knotX + tw / 2,
        tailTop,
      );
      ctx.closePath();
    };

    tail();
    ctx.fillStyle = css(Cloth.plum);
    ctx.fill();

    // Stripes clipped to the tail so they follow the swing instead of sliding
    // off it.
    ctx.save();
    tail();
    ctx.clip();
    ctx.fillStyle = css(Cloth.petalCream);
    for (const k of [0.62, 0.8]) {
      const sx = knotX - tw;
      const sy = tailTop - len * k;
      const sw = tw * 2 + Math.abs(sway) * 2;
      const sh = u * 0.035;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + sw, sy);
      ctx.lineTo(sx + sw, sy + sh);
      ctx.lineTo(sx, sy + sh);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Fringe.
    useStroke(ctx, Cloth.plumDeep);
    for (const k of [-0.3, 0, 0.3]) {
      const fx = knotX + sway + tw * k;
      line(
        ctx,
        point(fx, tailTop - len),
        point(fx + sway * 0.15, tailTop - len - u * 0.05),
        u * 0.028,
      );
    }

    // The wrap: one thick round-capped stroke that dips in the middle, which is
    // what a band wrapping a neck toward the viewer does. Stroking it twice —
    // dark, then lighter and nudged up — leaves a rolled bottom edge without an
    // outline drawn around the whole thing.
    const wrap = (width: number, lift: number, colour: typeof Cloth.plum): void => {
      useStroke(ctx, colour);
      ctx.beginPath();
      ctx.moveTo(mid - w / 2 + band * 0.4, y + band * 0.18 + lift);
      ctx.bezierCurveTo(
        mid - w * 0.22,
        y - band * 0.42 + lift,
        mid + w * 0.22,
        y - band * 0.42 + lift,
        mid + w / 2 - band * 0.4,
        y + band * 0.18 + lift,
      );
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
    };
    wrap(band, 0, Cloth.plumDeep);
    wrap(band * 0.78, band * 0.13, Cloth.plum);

    // Knot, sitting over both.
    inFrame(ctx, point(knotX, y - band * 0.08), -12, () => {
      fillRounded(
        ctx,
        rect(-u * 0.115, -u * 0.09, u * 0.23, u * 0.18),
        u * 0.06,
        Cloth.plumDeep,
      );
    });
  }
}

// --- Santa hat ---------------------------------------------------------------

/**
 * December through February — it carries the whole winter, so it has to survive
 * being worn for three months without becoming a joke worn thin.
 */
export class SantaHatOutfit implements Outfit {
  readonly id = "santa";
  readonly name = "Santa hat";
  readonly glyph = "🎅";
  readonly months: ReadonlySet<number> = new Set([12, 1, 2]);

  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void {
    // Headroom is the scarce resource up here, so the cone spends its length
    // sideways: it arcs over the skull and the tip droops down beside the ear,
    // which is both the more recognisable silhouette and the one that stays
    // clear of the badge on a tall-eared head.
    const fit = hatFit(companion, 0.3);
    const u = fit.u;
    const brimW = u * 0.72;
    const brimH = u * 0.13;

    inFrame(ctx, fit.base, 0, () => {
      const drift = Math.sin(s.phase * swayRate(s) * 0.5) * u * 0.025;
      // The tip stops at the head's own edge: further out and the pom starts
      // fighting the tantrum's anger marks for the same air.
      const tip = point(u * 0.38 + drift, u * 0.19 - Math.abs(drift) * 0.4);

      const crown = (): void => {
        ctx.beginPath();
        ctx.moveTo(-brimW * 0.48, brimH * 0.1);
        ctx.bezierCurveTo(-u * 0.28, u * 0.34, u * 0.24, u * 0.35, tip.x, tip.y);
        ctx.bezierCurveTo(
          u * 0.3,
          u * 0.13,
          u * 0.34,
          u * 0.05,
          brimW * 0.42,
          brimH * 0.1,
        );
        ctx.closePath();
      };

      crown();
      ctx.fillStyle = css(Cloth.santa);
      ctx.fill();

      // A sliver of shadow along the underside of the flop, so the cone reads
      // as bending away from you rather than as a flat red comma.
      ctx.save();
      crown();
      ctx.clip();
      ctx.fillStyle = css(Cloth.santaDeep);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.bezierCurveTo(
        u * 0.3,
        u * 0.13,
        u * 0.34,
        u * 0.05,
        brimW * 0.42,
        brimH * 0.1,
      );
      ctx.lineTo(u * 0.02, brimH * 0.1);
      ctx.bezierCurveTo(u * 0.16, u * 0.14, u * 0.28, u * 0.2, tip.x, tip.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Brim: a bowed band rather than a flat pill, so it follows the curve of
      // whatever skull is underneath. Cream on a cream duck would vanish, hence
      // the darker pass underneath acting as a keyline.
      const brim = (width: number, colour: typeof Cloth.paper): void => {
        useStroke(ctx, colour);
        ctx.beginPath();
        ctx.moveTo(-brimW / 2 + brimH * 0.5, 0);
        ctx.bezierCurveTo(
          -brimW * 0.2,
          brimH * 0.5,
          brimW * 0.2,
          brimH * 0.5,
          brimW / 2 - brimH * 0.5,
          0,
        );
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.stroke();
      };
      brim(brimH + u * 0.03, Cloth.edge);
      brim(brimH, Cloth.paper);

      const pom = u * 0.085;
      const pomC = point(tip.x + pom * 0.28, tip.y - pom * 0.15);
      dot(ctx, pomC, pom + u * 0.015, Cloth.edge);
      dot(ctx, pomC, pom, Cloth.paper);
    });
  }
}

/** The wardrobe's stock, in the order the closet shows them. */
export const OUTFIT_STYLES: readonly Outfit[] = [
  new PartyHatOutfit(),
  new FlowerCrownOutfit(),
  new SunglassesOutfit(),
  new PumpkinHatOutfit(),
  new ScarfOutfit(),
  new SantaHatOutfit(),
];

// Referenced for side-effect-free imports in tests.
export { strokeLine };
