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
import { point, rect, rectMaxX, rectMaxY, rectMinX, rectMinY } from "../core/types";
import { css, rgba, withAlpha, LOAF_INK, LOAF_BLUSH } from "../core/color";
import { fillBlock, fillOval, fillRounded, line } from "../core/draw";

/**
 * Bagel — the capybara.
 *
 * Ported from `CompanionCapybara.swift`, including its reasoning, because every
 * number in it is load-bearing.
 *
 * The whole animal is one proportion: a *small blunt head on an enormous
 * barrel*. Nothing else about a capybara is distinctive from the front — no
 * tail, no ruff, no ear shape worth the name — so if the head is ever as wide
 * as the shoulders he stops being a capybara and becomes a marmot. Head 84
 * wide, shoulders 94, hips 114, rump 126.
 *
 * The second thing carrying the species is the face, defined by what it does
 * *not* have. No pale muzzle patch — the snout is a shade darker, deepening
 * into a broad dark nose *bar* — because a light badge around the mouth is a
 * bear/dog marking and it outvotes any amount of correct skull. And no swept
 * whiskers: long whisker lines are a cat's signature and they overwrite
 * everything else on a face this flat, so the vibrissae are hinted at as roots
 * and nothing more.
 */
export class CapybaraCompanion implements Companion {
  readonly id = "capybara";
  readonly defaultName = "Bagel";
  readonly species = "Capybara";
  readonly group: CompanionGroup = "elsewhere";
  readonly blurb = "Unbothered. Moisturised. Aware of your screen time.";
  readonly castsShadow = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  readonly palette: CompanionPalette = {
    fur: rgba(Math.round(0.69 * 255), Math.round(0.502 * 255), Math.round(0.333 * 255), 1),
    furDark: rgba(
      Math.round(0.557 * 255),
      Math.round(0.392 * 255),
      Math.round(0.251 * 255),
      1,
    ),
    furLight: rgba(
      Math.round(0.851 * 255),
      Math.round(0.722 * 255),
      Math.round(0.573 * 255),
      1,
    ),
    inner: rgba(
      Math.round(0.788 * 255),
      Math.round(0.545 * 255),
      Math.round(0.478 * 255),
      1,
    ),
    ink: LOAF_INK,
    nose: rgba(Math.round(0.29 * 255), Math.round(0.208 * 255), Math.round(0.153 * 255), 1),
    blush: LOAF_BLUSH,
  };

  // --- Anchors ---

  /**
   * Flat-topped and, crucially, **narrower than the shoulders below it**. A head
   * that out-widens the body is the fastest way to turn this into a gopher, so
   * 84 here is a hard ceiling rather than a taste call.
   */
  readonly headEllipse: Rect = rect(43, 84, 84, 66);
  /** The wide gap is a capybara tell: eyes and ears live at the corners. */
  readonly eyeLeft: Point = point(63, 129);
  readonly eyeRight: Point = point(107, 129);
  /** Beady. Shrinking these is most of what stops this reading as a bear. */
  readonly eyeScale = 0.8;
  readonly hatAnchor: Point = point(85, 147);
  /** No neck, so a scarf wraps the jaw/shoulder junction itself. */
  readonly neckY = 90;
  readonly handLeft: Point = point(51, 43);
  readonly handRight: Point = point(119, 43);
  get handFill(): Color {
    return this.palette.fur;
  }

  /**
   * The skull, and the single most important shape in the file.
   *
   * A brick with a slightly narrower crown: straight full-width sides from the
   * jaw up to eye level, then a short lean in over the last 24pt to a flat top.
   * Draw it as an even rectangle and you get a bear cub; taper it from the jaw
   * up and you get an egg.
   */
  private headPath(ctx: Ctx2D): void {
    const r = this.headEllipse;
    // `knee` is not a styling choice. The shared fur spikes root on the oval
    // inscribed in headEllipse, still 41.5pt out from centre at y~122 — so the
    // sides must stay full width to y=126 or the spike bases land in mid-air
    // and visibly detach. The lean is squeezed into the 16pt above that.
    const inset = 8;
    const knee = rectMinY(r) + 42; // y=126: highest spike root, plus margin
    const brow = rectMaxY(r) - 8; // y=142: where the crown corners start
    const minX = rectMinX(r);
    const maxX = rectMaxX(r);
    const minY = rectMinY(r);
    const maxY = rectMaxY(r);

    ctx.beginPath();
    ctx.moveTo(minX, minY + 15);
    ctx.lineTo(minX, knee);
    // Temples ease in rather than turning a corner — a hard bevel made the
    // skull look like a helmet — and the outward bulge buys back margin for
    // the spike roots.
    ctx.bezierCurveTo(minX, knee + 6, minX + inset - 2, brow - 6, minX + inset, brow);
    ctx.bezierCurveTo(
      minX + inset + 1,
      maxY - 3,
      minX + inset + 6,
      maxY,
      minX + inset + 14,
      maxY,
    );
    ctx.lineTo(maxX - inset - 14, maxY);
    ctx.bezierCurveTo(maxX - inset - 6, maxY, maxX - inset - 1, maxY - 3, maxX - inset, brow);
    ctx.bezierCurveTo(maxX - inset + 2, brow - 6, maxX, knee + 6, maxX, knee);
    ctx.lineTo(maxX, minY + 15);
    ctx.bezierCurveTo(maxX, minY + 6, maxX - 6, minY, maxX - 15, minY);
    ctx.lineTo(minX + 15, minY);
    ctx.bezierCurveTo(minX + 6, minY, minX, minY + 6, minX, minY + 15);
    ctx.closePath();
  }

  // --- Behind ---

  /**
   * No tail worth drawing from the front, so the space behind goes to a rump: a
   * wider, darker slab peeking past the hips. It makes the bottom of the
   * silhouette the broadest part of him, which is the proportion doing all the
   * species work.
   */
  drawBehind(ctx: Ctx2D, s: SceneState): void {
    void s;
    fillBlock(ctx, rect(22, 14, 126, 44), 21, 16, this.palette.furDark);
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;

    // A barrel that keeps widening all the way down. Shoulders 10pt wider than
    // the skull, hips 20pt wider again, so head, chest and rump read as three
    // separate masses instead of one trapezoid.
    ctx.fillStyle = css(p.fur);
    ctx.beginPath();
    ctx.moveTo(38, 92);
    ctx.bezierCurveTo(31, 73, 27, 56, 28, 40);
    ctx.bezierCurveTo(29, 21, 54, 13, 85, 13);
    ctx.bezierCurveTo(116, 13, 141, 21, 142, 40);
    ctx.bezierCurveTo(143, 56, 139, 73, 132, 92);
    // Shoulders roll over behind the jaw instead of closing on a flat line. A
    // straight top edge left 5pt of hard shelf either side of the chin —
    // shoulder pads, not an animal.
    ctx.bezierCurveTo(126, 106, 44, 106, 38, 92);
    ctx.closePath();
    ctx.fill();

    fillRounded(ctx, rect(57, 20, 56, 62), 24, withAlpha(p.furLight, 0.85));

    // Coarse, sparse guard hairs. Capybara fur is bristly rather than fluffy,
    // so these are ticks, not the cat's soft stripes.
    const tick = withAlpha(p.furDark, 0.35);
    for (const [x, y] of [
      [35, 52],
      [38, 66],
      [122, 52],
      [119, 66],
    ] as const) {
      fillRounded(ctx, rect(x, y, 13, 4), 2, tick);
    }

    // Front feet: blunt, splayed, four stubby toes. Low and wide so the whole
    // thing still reads as a block sitting on the desk.
    for (const x of [45, 96]) {
      fillRounded(ctx, rect(x, 13, 29, 15), 7, p.fur);
    }
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.45));
    for (const x of [52.5, 59.5, 66.5, 103.5, 110.5, 117.5]) {
      line(ctx, point(x, 14), point(x, 21), 1.4);
    }

    // Contact shadow under the jaw. Faint: the proportion does the separating,
    // and a strong band here just smears across the chest.
    fillOval(ctx, rect(57, 70, 56, 18), withAlpha(p.furDark, 0.18));
  }

  // --- Head ---

  drawHead(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // Ears move about a fifth as far as the cat's. He notices things; he just
    // doesn't do anything about them.
    let lean: number;
    switch (s.mood) {
      case "tantrum":
        lean = -2.5;
        break;
      case "scrolling":
        lean = 2.0;
        break;
      case "sleeping":
        lean = -1.5;
        break;
      default:
        lean = Math.sin(s.phase * 0.8) * 0.5; // an idle half-flick
    }

    // Ears go down before the skull so the head crops them into flaps rather
    // than discs, and they sit on the *shoulder* of the skull rather than on
    // top of it. A round ear centred above the crown line is a bear cub no
    // matter what the rest of the drawing does.
    //
    // Solid furDark with no inner: a capybara's ear is a flat dark flap and
    // from the front there is no pink to see.
    for (const flip of [false, true]) {
      const sign = flip ? -1 : 1;
      const cx = 85 - sign * 35 - sign * (lean < 0 ? 1.5 : 0);
      const cy = 144 + lean;
      fillOval(ctx, rect(cx - 9.5, cy - 7.5, 19, 15), p.furDark);
    }

    ctx.fillStyle = css(p.fur);
    this.headPath(ctx);
    ctx.fill();
  }

  // --- Muzzle ---

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;

    // The blunt front, running 86% of the head's width — leave more than about
    // 6pt of bare cheek either side and it turns into a bear cub with a muzzle
    // patch. And it is a shade DARKER, not lighter: a pale muzzle patch is a
    // bear/dog marking. Tone runs fur -> dark snout -> near-black nose.
    fillBlock(ctx, rect(49, 84, 72, 34), 13, 15, withAlpha(p.furDark, 0.3));

    // The nose. Not a nose so much as a *bar* — four times as wide as it is
    // tall, capping the snout, notched where the split lip meets it. Round it
    // into an oval floating mid-pad and you have drawn a teddy bear.
    ctx.fillStyle = css(p.nose);
    ctx.beginPath();
    ctx.moveTo(64, 112);
    ctx.bezierCurveTo(73, 116.5, 97, 116.5, 106, 112);
    ctx.bezierCurveTo(108.5, 109, 104, 105, 100, 105);
    ctx.lineTo(88, 105);
    ctx.lineTo(85, 107.5);
    ctx.lineTo(82, 105);
    ctx.lineTo(70, 105);
    ctx.bezierCurveTo(66, 105, 61.5, 109, 64, 112);
    ctx.closePath();
    ctx.fill();

    // Split upper lip. Two points of rodent, cheaply.
    ctx.strokeStyle = css(withAlpha(p.ink, 0.45));
    line(ctx, point(85, 107.5), point(85, 99), 1.4);

    ctx.strokeStyle = css(withAlpha(p.ink, 0.85));
    ctx.beginPath();
    switch (s.mood) {
      case "happy":
      case "proud":
        ctx.moveTo(71, 97);
        ctx.bezierCurveTo(77, 90, 93, 90, 99, 97);
        break;
      case "tantrum":
        // The entire tantrum, facially: the flat line tips up in the middle by
        // three points. He is displeased. He will not be making a scene.
        ctx.moveTo(72, 95);
        ctx.bezierCurveTo(78, 98.5, 92, 98.5, 98, 95);
        break;
      case "sleeping":
        // Shorter and shallower than idle, but still curved — a dead straight
        // line meets the lip stroke in a little "T" that reads as a mistake.
        ctx.moveTo(77, 96);
        ctx.bezierCurveTo(81, 94, 89, 94, 93, 96);
        break;
      default:
        ctx.moveTo(72, 96);
        ctx.bezierCurveTo(78, 92.5, 92, 92.5, 98, 96);
    }
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";
    ctx.stroke();

    // Whisker *roots* — three specks per side, and no lines. Long swept
    // whiskers are the cat's signature; put four on any other muzzle and the
    // face reads as a recoloured cat whatever shape the skull is.
    const socket = withAlpha(p.ink, 0.3);
    for (const [x, y] of [
      [56, 108],
      [56, 103],
      [60, 105.5],
      [114, 108],
      [114, 103],
      [110, 105.5],
    ] as const) {
      fillOval(ctx, rect(x - 0.9, y - 0.9, 1.8, 1.8), socket);
    }
  }
}
