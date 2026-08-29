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
import { blend, css, rgba, withAlpha, LOAF_INK, LOAF_BLUSH } from "../core/color";
import { fillOval, line } from "../core/draw";

/**
 * Waffle — a duckling, and the closet's deliberate break from the cat template.
 *
 * Ported from `CompanionDuck.swift`.
 *
 * No ears and no snout. The silhouette is two circles — a round head on a
 * teardrop body — and every bit of "duck" is carried by the orange: a wide flat
 * bill across the lower face and webbed feet underneath. That makes the crown
 * bare, which is what the feather cowlick is for: without it there would be
 * nothing up there for the shared tantrum fur spikes to belong to, and the
 * bristling would read as a hairy dome rather than a ruffled bird.
 */
export class DuckCompanion implements Companion {
  readonly id = "duck";
  readonly defaultName = "Waffle";
  readonly species = "Duck";
  readonly group: CompanionGroup = "elsewhere";
  readonly blurb = "Judges silently. Occasionally out loud.";
  readonly castsShadow = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  readonly palette: CompanionPalette = {
    fur: rgba(Math.round(0.969 * 255), Math.round(0.871 * 255), Math.round(0.545 * 255), 1),
    furDark: rgba(
      Math.round(0.878 * 255),
      Math.round(0.745 * 255),
      Math.round(0.388 * 255),
      1,
    ),
    furLight: rgba(255, Math.round(0.973 * 255), Math.round(0.894 * 255), 1),
    // Bill and feet.
    inner: rgba(Math.round(0.949 * 255), Math.round(0.627 * 255), Math.round(0.239 * 255), 1),
    ink: LOAF_INK,
    // A duck's nose is two holes in the bill, so `nose` is just the bill colour.
    nose: rgba(Math.round(0.949 * 255), Math.round(0.627 * 255), Math.round(0.239 * 255), 1),
    blush: LOAF_BLUSH,
  };

  /**
   * Round, and deliberately the same height as Loaf's head so shared hats and
   * the derived blush rects land the same way on both animals.
   */
  readonly headEllipse: Rect = rect(49, 85, 72, 64);
  readonly eyeLeft: Point = point(71, 127);
  readonly eyeRight: Point = point(99, 127);
  /** Beady. Next to that much bill, big round eyes turn him into a plush toy. */
  readonly eyeScale = 0.86;
  /** No ears to clear — a hat goes straight down on the crown. */
  readonly hatAnchor: Point = point(85, 148);
  readonly neckY = 91;
  /**
   * Further out than the cat's: a duck has no forearms, so the scroll is
   * pinched between two wingtips at the edge of the body.
   */
  readonly handLeft: Point = point(51, 44);
  readonly handRight: Point = point(119, 44);
  get handFill(): Color {
    return this.palette.fur;
  }

  /** The bill's shading colour, mixed from the palette rather than invented. */
  private get billDark(): Color {
    return blend(this.palette.inner, 0.3, this.palette.ink);
  }

  // --- Behind ---

  /**
   * Wings only — deliberately no tail, unlike Loaf. Front-on there is no tail
   * to see, and a fan off the right hip lands in the same silhouette the right
   * wing tip already occupies; the two stack into a staircase of pale points
   * that reads as a torn edge rather than a bird.
   */
  drawBehind(ctx: Ctx2D, s: SceneState): void {
    this.drawWing(ctx, s, false);
    this.drawWing(ctx, s, true);
  }

  /**
   * A stubby folded wing flat against each flank. Most of it is swallowed by
   * the body — only the outer crescent shows, which is how a duckling's tucked
   * wing looks, and it keeps the silhouette from going pear-shaped.
   */
  private drawWing(ctx: Ctx2D, s: SceneState, flip: boolean): void {
    const px = (x: number): number => (flip ? 170 - x : x);
    const p = this.palette;

    // Wings are the duck's hands, feet and voice at once, so they carry most of
    // the mood: furious flapping, a sleepy droop, a pleased little flutter.
    let beat: number;
    switch (s.mood) {
      case "tantrum":
        beat = Math.sin(s.phase * 12 + (flip ? Math.PI : 0)) * 9;
        break;
      case "happy":
      case "proud":
        beat = 2 + Math.sin(s.phase * 3.4) * 3.5;
        break;
      case "sleeping":
        beat = -3.5;
        break;
      case "scrolling":
        beat = -2.5;
        break;
      default:
        beat = Math.sin(s.phase * 1.8) * 1.2;
    }

    // Rooted a few points inside the head's circle rather than on its edge, so
    // the leading edge has nowhere to end in a visible spur. Both controls sit
    // well off the chord on purpose: anywhere near it and the curve renders as
    // a straight diagonal, giving him sloped, cut-off shoulders.
    ctx.beginPath();
    ctx.moveTo(px(65), 97);
    ctx.bezierCurveTo(px(49), 99, px(25), 84, px(22 - beat * 0.2), 58 + beat);
    // One pointed tip, not two splayed primaries: a notch between two tips gets
    // swallowed by the flank and reads as a chip in the outline. The corner is
    // sharp on purpose — a rounded end reads as a fin.
    ctx.bezierCurveTo(
      px(20),
      51 + beat * 0.9,
      px(22),
      45 + beat * 0.85,
      px(27 - beat * 0.12),
      41 + beat * 0.7,
    );
    ctx.bezierCurveTo(px(42), 52, px(60), 54, px(68), 62);
    ctx.closePath();
    ctx.fillStyle = css(p.fur);
    ctx.fill();
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.6));
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // Covert-feather grooves, angled along the wing so they cannot be mistaken
    // for the scratches they would be if they ran any other way.
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.5));
    for (const [ax, ay] of [
      [28, 67],
      [26, 58],
    ] as const) {
      line(
        ctx,
        point(px(ax), ay + beat * 0.6),
        point(px(ax + 9), ay + 8 + beat * 0.4),
        1.7,
      );
    }
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;

    // A teardrop: narrow at the shoulders, heavy and round at the base. Ducks
    // have no visible neck, so the body starts well up behind the head.
    ctx.fillStyle = css(p.fur);
    ctx.beginPath();
    ctx.moveTo(63, 108);
    ctx.bezierCurveTo(54, 92, 38, 74, 36, 52);
    ctx.bezierCurveTo(34, 28, 57, 15, 85, 15);
    ctx.bezierCurveTo(113, 15, 136, 28, 134, 52);
    ctx.bezierCurveTo(132, 74, 116, 92, 107, 108);
    ctx.closePath();
    ctx.fill();

    // Pale chest down. Kept well clear of the feet — run any lower and it stops
    // being a chest and starts being an egg he is standing behind.
    fillOval(ctx, rect(63, 32, 44, 48), withAlpha(p.furLight, 0.85));

    // Head and body are the same yellow and overlap heavily, so without a
    // shaded crease under the chin the two circles fuse into one blob.
    ctx.beginPath();
    ctx.moveTo(61, 92);
    ctx.bezierCurveTo(70, 81, 100, 81, 109, 92);
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.22));
    ctx.stroke();

    // Toed outward and set well apart. Two mirror-image feet a few points apart
    // put six identical evenly spaced lobes along the bottom edge, and a
    // scallop that regular reads as a skirt hem rather than feet.
    this.drawFoot(ctx, s, 66, -1, 0);
    this.drawFoot(ctx, s, 104, 1, Math.PI);
  }

  /**
   * Webbed feet, drawn after the body so they overlap its lower edge — a
   * sitting duck's feet stick out in front of it, not out from behind it.
   *
   * `out` is the direction this foot points away from the centre line: the long
   * toe goes on the outside, so the foot is a wedge rather than a symmetric fan.
   */
  private drawFoot(
    ctx: Ctx2D,
    s: SceneState,
    cx: number,
    out: number,
    beatOffset: number,
  ): void {
    // A cross duck stamps. Alternating feet, so it reads as stamping rather
    // than hopping.
    const dy =
      s.mood === "tantrum"
        ? Math.max(0, Math.sin(s.phase * 8 + beatOffset)) * 3.5
        : 0;

    // Toe tips, inner to outer. Each is a little longer and lower than the
    // last, which is what makes the foot splay.
    const innerTip = point(cx - out * 11, 18 + dy);
    const midTip = point(cx + out * 2, 15.5 + dy);
    const outerTip = point(cx + out * 16, 14.5 + dy);

    ctx.fillStyle = css(this.palette.inner);
    ctx.beginPath();
    ctx.moveTo(cx - out * 10, 27 + dy);
    ctx.bezierCurveTo(
      cx - out * 12,
      23 + dy,
      cx - out * 13,
      20 + dy,
      innerTip.x,
      innerTip.y,
    );
    // Web scalloping up between the toes.
    ctx.bezierCurveTo(
      cx - out * 8,
      21.5 + dy,
      cx - out * 2,
      20 + dy,
      midTip.x,
      midTip.y,
    );
    ctx.bezierCurveTo(
      cx + out * 6,
      20.5 + dy,
      cx + out * 12,
      19.5 + dy,
      outerTip.x,
      outerTip.y,
    );
    ctx.bezierCurveTo(
      cx + out * 17.5,
      18 + dy,
      cx + out * 14,
      23 + dy,
      cx + out * 11,
      27 + dy,
    );
    // The ankle domes up under the belly rather than closing on a straight
    // line. A flat top edge is a 20pt orange chord across the underside, which
    // made the feet look stapled on instead of tucked under him.
    ctx.bezierCurveTo(
      cx + out * 5,
      32.5 + dy,
      cx - out * 5,
      32.5 + dy,
      cx - out * 10,
      27 + dy,
    );
    ctx.closePath();
    ctx.fill();

    // One crease down the middle of each toe. Creasing the web valleys instead
    // leaves the strokes floating in the gaps between lobes rather than sitting
    // on the shapes they divide.
    ctx.strokeStyle = css(withAlpha(this.billDark, 0.42));
    for (const [tip, topX] of [
      [innerTip, cx - out * 7],
      [midTip, cx + out * 2],
      [outerTip, cx + out * 10],
    ] as const) {
      line(ctx, point(tip.x, tip.y + 2.5), point(topX, 24 + dy), 1.3);
    }
  }

  // --- Head ---

  drawHead(ctx: Ctx2D, s: SceneState): void {
    // Cowlick first, so the head circle buries its roots and only the tips show.
    this.drawCowlick(ctx, s);
    // Filled to headEllipse exactly — the shared fur spikes are placed off that
    // rect, and any mismatch leaves them floating clear of the skull.
    fillOval(ctx, this.headEllipse, this.palette.fur);
  }

  private drawCowlick(ctx: Ctx2D, s: SceneState): void {
    // The cowlick is this duck's ears: the one bit of headgear that can lean.
    let lean: number;
    let rise: number;
    switch (s.mood) {
      case "tantrum":
        lean = Math.sin(s.phase * 22) * 3; // bolt upright, vibrating
        rise = 0;
        break;
      case "sleeping":
        // Flopped sideways. It leans without shortening: pulling the tips down
        // as well retracted the outer two back inside the skull, which deletes
        // the cowlick in the one mood that most wants a droop.
        lean = -14;
        rise = 1;
        break;
      case "scrolling":
        lean = 9; // tipped forward over the page
        rise = -2;
        break;
      case "happy":
      case "proud":
        lean = Math.sin(s.phase * 3) * 3.5;
        rise = 1;
        break;
      default:
        lean = Math.sin(s.phase * 1.4) * 3;
        rise = 0;
    }

    ctx.fillStyle = css(this.palette.fur);
    // Splayed rather than parallel, so three tips clear the crown instead of
    // one fused nub. The tallest stops at y~157: any higher and it fouls the
    // badge. Last number is how much of the lean each strand takes — swinging
    // all three equally stretches whichever is already splayed that way into a
    // sickle while squashing its opposite flat.
    for (const [baseX, tipX, tipY, w, swing] of [
      [77, 66, 152, 4.5, 0.5],
      [85, 87, 157, 5.0, 1.0],
      [93, 105, 151, 4.0, 0.5],
    ] as const) {
      const baseY = 136;
      const tx = tipX + lean * swing;
      const ty = tipY + rise;
      ctx.beginPath();
      ctx.moveTo(baseX - w, baseY);
      ctx.bezierCurveTo(baseX - w - 1, (baseY + ty) / 2, tx - w * 0.9, ty - 6, tx, ty);
      ctx.bezierCurveTo(
        tx + w * 0.9,
        ty - 6,
        baseX + w + 1,
        (baseY + ty) / 2,
        baseX + w,
        baseY,
      );
      ctx.closePath();
      ctx.fill();
    }
  }

  // --- Muzzle — which is to say, the bill ---

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;

    // Two mandibles rather than one lozenge. Costs a few lines and buys the
    // tantrum an actual open-mouthed quack, which is the whole joke of the
    // character — a duck that merely frowned would be a chick in a bad mood.
    let gape: number;
    switch (s.mood) {
      case "tantrum":
        gape = 5 + 8 * Math.abs(Math.sin(s.phase * 5.0));
        break;
      case "happy":
      case "proud":
        gape = 2.5;
        break;
      default:
        gape = 0;
    }
    // A worried or sleepy bill turns its corners down instead of opening.
    const droop = s.mood === "worried" || s.mood === "sleeping" ? 2.4 : 0;
    const hinge = 107;
    const cornerY = hinge - droop;
    // The bill hinges at its corners: the middle springs open and the ends stay
    // put. Sliding the halves apart bodily reads as an upper mandible that has
    // come unhooked from the skull.
    const up = gape * 0.3;
    const down = gape * 0.7;

    // Dark throat behind the gap. Drawn first and bowed further than the gape
    // on both sides so the mandibles crop it, leaving no transparent slot.
    if (gape > 0.5) {
      ctx.fillStyle = css(blend(p.ink, 0.22, p.inner));
      ctx.beginPath();
      ctx.moveTo(59, cornerY);
      ctx.bezierCurveTo(71, hinge + up * 1.8, 99, hinge + up * 1.8, 111, cornerY);
      ctx.bezierCurveTo(99, hinge - down * 1.8, 71, hinge - down * 1.8, 59, cornerY);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = css(p.inner);

    // Lower mandible — narrower than the upper, so the closed bill has the
    // slight overbite a real one does.
    ctx.beginPath();
    ctx.moveTo(60, cornerY);
    ctx.bezierCurveTo(61, 101 - down * 0.5, 70, 97 - down * 0.5, 85, 97 - down * 0.5);
    ctx.bezierCurveTo(100, 97 - down * 0.5, 109, 101 - down * 0.5, 110, cornerY);
    ctx.bezierCurveTo(96, hinge - down * 1.35, 74, hinge - down * 1.35, 60, cornerY);
    ctx.closePath();
    ctx.fill();

    // Upper mandible — the wide flat spatula that makes the whole face read.
    ctx.beginPath();
    ctx.moveTo(57, cornerY);
    ctx.bezierCurveTo(58, 114 + up * 0.35, 69, 116 + up * 0.35, 85, 116 + up * 0.35);
    ctx.bezierCurveTo(101, 116 + up * 0.35, 112, 114 + up * 0.35, 113, cornerY);
    ctx.bezierCurveTo(
      100,
      hinge + up * 1.35 - 1.5,
      70,
      hinge + up * 1.35 - 1.5,
      57,
      cornerY,
    );
    ctx.closePath();
    ctx.fill();

    // A closed bill needs a seam or it is just an orange blob; an open one is
    // already telling you where the join is.
    if (gape < 0.5) {
      ctx.beginPath();
      ctx.moveTo(61, cornerY);
      ctx.bezierCurveTo(76, cornerY - 1.5, 94, cornerY - 1.5, 109, cornerY);
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.strokeStyle = css(withAlpha(this.billDark, 0.7));
      ctx.stroke();
    }

    // Nostrils.
    const nostril = withAlpha(this.billDark, 0.55);
    for (const x of [76, 94]) {
      fillOval(ctx, rect(x - 1.5, 110.8 + up * 0.35, 3.0, 2.4), nostril);
    }
  }
}
