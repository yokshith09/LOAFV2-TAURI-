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
import {
  BADGE_STRIP_Y,
  point,
  rect,
  rectMaxX,
  rectMaxY,
  rectMidY,
  rectMinX,
} from "../core/types";
import { blend, css, rgba, withAlpha, BLACK, WHITE } from "../core/color";
import { fillOval, fillRounded, line } from "../core/draw";
import type { DogBreed } from "./dogBreeds";
import { DOG_BREEDS, findBreed } from "./dogBreeds";

/**
 * The shared dog: a sitting animal whose ears, muzzle, tail and bulk come from
 * data. Ported from `DogCompanion` in `DogBreeds.swift`, geometry unchanged.
 */
export class DogCompanion implements Companion {
  readonly breed: DogBreed;

  constructor(breed: DogBreed = DOG_BREEDS[0]!) {
    this.breed = breed;
  }

  static byId(id: string): DogCompanion {
    return new DogCompanion(findBreed(id));
  }

  get id(): string {
    return this.breed.id;
  }
  get defaultName(): string {
    return this.breed.defaultName;
  }
  get species(): string {
    return this.breed.breed;
  }
  get blurb(): string {
    return this.breed.blurb;
  }
  get group(): CompanionGroup {
    return "dogs";
  }
  get palette(): CompanionPalette {
    return this.breed.palette;
  }

  readonly castsShadow = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  /** How wide the animal is overall. The bulldog is the joke: nearly square. */
  private get girth(): number {
    switch (this.breed.build) {
      case "stocky":
        return 1.18;
      case "small":
        return 0.9;
      default:
        return 1.0;
    }
  }

  get headEllipse(): Rect {
    switch (this.breed.build) {
      case "stocky":
        return rect(38, 78, 94, 72);
      case "small":
        return rect(46, 82, 78, 66);
      default:
        return rect(44, 80, 82, 68);
    }
  }

  private get eyeSpread(): number {
    return this.breed.build === "stocky" ? 19 : 17;
  }
  private get eyeY(): number {
    return this.breed.build === "stocky" ? 120 : 119;
  }

  get eyeLeft(): Point {
    return point(85 - this.eyeSpread, this.eyeY);
  }
  get eyeRight(): Point {
    return point(85 + this.eyeSpread, this.eyeY);
  }
  get eyeScale(): number {
    return this.breed.jowls ? 0.85 : 0.95;
  }
  get hatAnchor(): Point {
    return point(85, this.breed.ears === "erect" ? 150 : 146);
  }
  /**
   * Low on the chest. Dogs of this shape have no visible neck, and a scarf
   * placed just under the skull ends up across the muzzle.
   */
  get neckY(): number {
    return 74;
  }
  get handLeft(): Point {
    return point(85 - 29 * this.girth, 44);
  }
  get handRight(): Point {
    return point(85 + 29 * this.girth, 44);
  }
  get handFill(): Color {
    return this.breed.socks ? this.palette.furLight : this.palette.fur;
  }

  // --- Behind ---

  drawBehind(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // Dogs wag. It's most of what separates them from the cat, so the tail is
    // the loudest mood signal they have.
    let speed: number;
    let amp: number;
    switch (s.mood) {
      case "happy":
      case "proud":
        speed = 9.0;
        amp = 15;
        break;
      case "tantrum":
        speed = 12.0;
        amp = 9;
        break;
      case "sleeping":
        speed = 0.8;
        amp = 3;
        break;
      default:
        speed = 1.8;
        amp = 7;
    }
    const sway = Math.sin(s.phase * speed) * amp;
    const x = 85 + 40 * this.girth;

    switch (this.breed.tail) {
      case "otter": {
        // Thick at the base, tapering, carried low and straight.
        ctx.strokeStyle = css(p.fur);
        ctx.lineWidth = 13;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - 6, 26);
        ctx.bezierCurveTo(
          x + 14,
          22,
          x + 24,
          36 + sway * 0.4,
          x + 22 + sway * 0.5,
          56 + sway,
        );
        ctx.stroke();
        break;
      }
      case "plume": {
        // Arches up and over the back in a spray of long hair.
        ctx.strokeStyle = css(p.furLight);
        ctx.lineWidth = 17;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - 8, 34);
        ctx.bezierCurveTo(x + 22, 52, x + 20, 82, x - 4 + sway * 0.4, 92 + sway * 0.5);
        ctx.stroke();
        // Feathering along the outer edge.
        ctx.strokeStyle = css(withAlpha(p.furDark, 0.18));
        for (const k of [0.35, 0.6, 0.85]) {
          const px = x - 8 + 26 * k;
          const py = 34 + 58 * k;
          line(ctx, point(px, py), point(px + 7, py + 5), 1.6);
        }
        break;
      }
      case "stub": {
        // Barely there, which is exactly the bulldog joke.
        fillOval(ctx, rect(x - 4, 30 + sway * 0.2, 16, 13), p.fur);
        break;
      }
      case "brush": {
        // Thick and curled, carried high.
        ctx.strokeStyle = css(p.furDark);
        ctx.lineWidth = 19;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - 8, 30);
        ctx.bezierCurveTo(x + 26, 44, x + 26, 74, x + 6 + sway * 0.4, 84 + sway * 0.4);
        ctx.stroke();
        // Pale underside, the giveaway of a husky's brush.
        ctx.strokeStyle = css(p.furLight);
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(x - 4, 36);
        ctx.bezierCurveTo(x + 16, 46, x + 16, 70, x + 4 + sway * 0.4, 80 + sway * 0.4);
        ctx.stroke();
        break;
      }
    }
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;
    const g = this.girth;

    // Haunches.
    fillOval(ctx, rect(85 - 59 * g, 14, 48 * g, 38), p.fur);
    fillOval(ctx, rect(85 + 11 * g, 14, 48 * g, 38), p.fur);

    // Torso — a dog's chest is broader and lower than the cat's.
    ctx.fillStyle = css(p.fur);
    ctx.beginPath();
    ctx.moveTo(85 - 28 * g, 100);
    ctx.bezierCurveTo(85 - 38 * g, 82, 85 - 46 * g, 62, 85 - 44 * g, 44);
    ctx.bezierCurveTo(85 - 43 * g, 24, 85 - 24 * g, 14, 85, 14);
    ctx.bezierCurveTo(85 + 24 * g, 14, 85 + 43 * g, 24, 85 + 44 * g, 44);
    ctx.bezierCurveTo(85 + 46 * g, 62, 85 + 38 * g, 82, 85 + 28 * g, 100);
    ctx.closePath();
    ctx.fill();

    if (this.breed.mask) {
      // A husky is dark over the back and shoulders, pale down the front.
      // The Swift mirrors the path with an affine transform; here the mirror
      // is just an x-flip helper, which avoids a whole transform stack.
      ctx.fillStyle = css(p.furDark);
      for (const flip of [false, true]) {
        const fx = (v: number): number => (flip ? 170 - v : v);
        ctx.beginPath();
        ctx.moveTo(fx(85 - 28 * g), 100);
        ctx.bezierCurveTo(
          fx(85 - 38 * g),
          82,
          fx(85 - 46 * g),
          62,
          fx(85 - 44 * g),
          44,
        );
        ctx.lineTo(fx(85 - 30 * g), 46);
        ctx.bezierCurveTo(
          fx(85 - 28 * g),
          70,
          fx(85 - 22 * g),
          86,
          fx(85 - 20 * g),
          100,
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    if (this.breed.patches) {
      // Bulldog blotches: hard-edged, asymmetric, never mirrored.
      const blot = withAlpha(p.furDark, 0.85);
      fillOval(ctx, rect(85 - 46 * g, 46, 32, 36), blot);
      fillOval(ctx, rect(85 + 16 * g, 24, 26, 24), blot);
    }

    if (this.breed.bib) {
      fillOval(
        ctx,
        rect(85 - 24 * g, 22, 48 * g, 66),
        withAlpha(p.furLight, this.breed.mask ? 1.0 : 0.85),
      );
    }

    // Front legs and paws.
    const legW = this.breed.build === "stocky" ? 18 : 15;
    for (const lx of [85 - 19 * g - legW / 2, 85 + 19 * g - legW / 2]) {
      fillRounded(ctx, rect(lx, 16, legW, 42), legW / 2, p.fur);
    }
    if (this.breed.socks) {
      for (const lx of [85 - 19 * g - legW / 2, 85 + 19 * g - legW / 2]) {
        fillRounded(ctx, rect(lx, 16, legW, 24), legW / 2, p.furLight);
      }
    }
    const pawFill = this.breed.socks ? p.furLight : p.fur;
    for (const cx of [85 - 19 * g, 85 + 19 * g]) {
      fillOval(ctx, rect(cx - 13, 13, 26, 15), pawFill);
    }
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.35));
    for (const cx of [85 - 19 * g, 85 + 19 * g]) {
      for (const dx of [-4, 0, 4]) {
        line(ctx, point(cx + dx, 15), point(cx + dx, 21), 1.4);
      }
    }

    if (this.breed.longHair) this.drawCoatCurtain(ctx);
  }

  /**
   * The shih tzu's floor-length coat: long strands hanging off the body, which
   * is most of why the breed reads as "a mop that owns you".
   */
  private drawCoatCurtain(ctx: Ctx2D): void {
    const p = this.palette;
    for (let i = 0; i < 9; i++) {
      const t = i / 8.0;
      const x = 44 + t * 82;
      const drop = 30 + Math.sin(t * Math.PI) * 16;
      fillRounded(ctx, rect(x - 6, 14, 13, drop), 6.5, p.furLight);
    }
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.16));
    for (let i = 0; i < 8; i++) {
      const x = 50 + i * 10.5;
      line(ctx, point(x, 20), point(x, 40), 1.4);
    }
  }

  // --- Head ---

  drawHead(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const head = this.headEllipse;
    const lean = s.mood === "tantrum" ? -7 : s.mood === "scrolling" ? 4 : 0;

    this.drawEars(ctx, lean);

    fillOval(ctx, head, p.fur);

    if (this.breed.mask) {
      // The husky's dark cap: over the skull and around the eyes, leaving a
      // pale muzzle and two pale brow spots. This mask *is* the breed.
      fillOval(
        ctx,
        rect(rectMinX(head), rectMidY(head) - 4, head.width, head.height / 2 + 6),
        p.furDark,
      );
      // Pale wedge down the centre of the face.
      ctx.fillStyle = css(p.furLight);
      ctx.beginPath();
      ctx.moveTo(85, rectMaxY(head) - 2);
      ctx.bezierCurveTo(
        85 - 9,
        rectMaxY(head) - 18,
        85 - 12,
        rectMidY(head),
        85 - 11,
        rectMidY(head) - 14,
      );
      ctx.lineTo(85 + 11, rectMidY(head) - 14);
      ctx.bezierCurveTo(
        85 + 12,
        rectMidY(head),
        85 + 9,
        rectMaxY(head) - 18,
        85,
        rectMaxY(head) - 2,
      );
      ctx.closePath();
      ctx.fill();
    }

    // Muzzle mass, in front of the head.
    switch (this.breed.muzzle) {
      case "square":
        fillOval(
          ctx,
          rect(85 - 24, 88, 48, 30),
          this.breed.mask ? p.furLight : withAlpha(p.furLight, 0.92),
        );
        break;
      case "short":
        fillOval(ctx, rect(85 - 27, 92, 54, 26), p.furLight);
        break;
      case "buried":
        // The shih tzu's face is behind hair; only a small muzzle shows.
        fillOval(ctx, rect(85 - 18, 92, 36, 22), p.furLight);
        break;
    }

    if (this.breed.jowls) {
      // Hanging cheeks either side of the mouth, below the muzzle line.
      fillOval(ctx, rect(85 - 34, 82, 30, 24), p.furLight);
      fillOval(ctx, rect(85 + 4, 82, 30, 24), p.furLight);
      // Brow wrinkles — two short arcs above the eyes.
      ctx.strokeStyle = css(withAlpha(p.furDark, 0.3));
      for (const dy of [0, 6]) {
        ctx.beginPath();
        ctx.moveTo(85 - 22, 132 + dy);
        ctx.bezierCurveTo(85 - 8, 137 + dy, 85 + 8, 137 + dy, 85 + 22, 132 + dy);
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }

    if (this.breed.mask) {
      // Pale brow spots over the dark cap — huskies have these and they do a
      // lot of the expression work.
      const spot = withAlpha(p.furLight, 0.9);
      for (const dx of [-this.eyeSpread, this.eyeSpread]) {
        fillOval(ctx, rect(85 + dx - 5, this.eyeY + 9, 10, 7), spot);
      }
    }

    if (this.breed.longHair) this.drawFaceHair(ctx);
  }

  /**
   * The shih tzu's parted fringe and topknot. Drawn after the head so it hangs
   * over the skull, which is what makes the face read as peeking out of hair.
   */
  private drawFaceHair(ctx: Ctx2D): void {
    const p = this.palette;
    const head = this.headEllipse;
    // Fringe: lobes around the upper half of the skull.
    for (let i = 0; i < 10; i++) {
      const a = Math.PI * (0.02 + (0.96 * i) / 9.0);
      const cx = 85 + Math.cos(a) * (head.width / 2 - 2);
      const cy = rectMidY(head) + Math.sin(a) * (head.height / 2 - 2);
      fillOval(ctx, rect(cx - 10, cy - 10, 20, 20), p.furLight);
    }
    // Side curtains falling past the jaw.
    for (const sx of [rectMinX(head) + 4, rectMaxX(head) - 18]) {
      fillRounded(ctx, rect(sx, 74, 15, 44), 7.5, p.furLight);
    }
    // Topknot, tied with a small plum bow — the one bit of grooming vanity.
    fillOval(ctx, rect(85 - 11, rectMaxY(head) - 6, 22, 18), p.furLight);
    const bow = rgba(
      Math.round(0.541 * 255),
      Math.round(0.314 * 255),
      Math.round(0.502 * 255),
      1,
    );
    fillOval(ctx, rect(85 - 11, rectMaxY(head) + 2, 10, 8), bow);
    fillOval(ctx, rect(85 + 1, rectMaxY(head) + 2, 10, 8), bow);
    fillOval(ctx, rect(85 - 2.5, rectMaxY(head) + 4, 5, 5), blend(bow, 0.3, BLACK));
  }

  private drawEars(ctx: Ctx2D, lean: number): void {
    const p = this.palette;
    const head = this.headEllipse;

    for (const flip of [false, true]) {
      const x = (v: number): number => (flip ? 170 - v : v);

      switch (this.breed.ears) {
        case "drop": {
          // Hangs down the side of the skull, wide and rounded.
          const long = this.breed.longHair ? 52 : 44;
          ctx.fillStyle = css(
            this.breed.longHair ? p.fur : blend(p.furDark, 0.45, p.fur),
          );
          ctx.beginPath();
          ctx.moveTo(x(rectMinX(head) + 10), rectMaxY(head) - 10);
          ctx.bezierCurveTo(
            x(rectMinX(head) - 12),
            rectMaxY(head) - 6,
            x(rectMinX(head) - 15),
            rectMaxY(head) - 34,
            x(rectMinX(head) - 9 - lean * 0.4),
            rectMaxY(head) - 10 - long,
          );
          ctx.bezierCurveTo(
            x(rectMinX(head) + 6),
            rectMaxY(head) - 12 - long,
            x(rectMinX(head) + 16),
            rectMaxY(head) - 40,
            x(rectMinX(head) + 18),
            rectMaxY(head) - 22,
          );
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "erect": {
          // Same clamp as the cats, for the same reason: the scrolling pose
          // leans ears UP (+4 for dogs), which pushed the husky's tip to y=170,
          // inside the reserved badge strip. The lean's sideways gesture is
          // kept; only the height is capped.
          const tipY = Math.min(rectMaxY(head) + 18 + lean, BADGE_STRIP_Y);
          ctx.fillStyle = css(p.furDark);
          ctx.beginPath();
          ctx.moveTo(x(rectMinX(head) + 12), rectMaxY(head) - 16);
          ctx.bezierCurveTo(
            x(rectMinX(head) + 8),
            rectMaxY(head) - 2,
            x(rectMinX(head) + 6),
            rectMaxY(head) + 10,
            x(rectMinX(head) + 8 - lean * 0.5),
            tipY,
          );
          ctx.bezierCurveTo(
            x(rectMinX(head) + 18 - lean),
            Math.min(rectMaxY(head) + 20 + lean, BADGE_STRIP_Y),
            x(rectMinX(head) + 30),
            rectMaxY(head) + 4,
            x(rectMinX(head) + 36),
            rectMaxY(head) - 8,
          );
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = css(p.inner);
          ctx.beginPath();
          ctx.moveTo(x(rectMinX(head) + 16), rectMaxY(head) - 14);
          ctx.bezierCurveTo(
            x(rectMinX(head) + 13),
            rectMaxY(head) - 2,
            x(rectMinX(head) + 11),
            rectMaxY(head) + 5,
            x(rectMinX(head) + 13 - lean * 0.4),
            Math.min(rectMaxY(head) + 11 + lean * 0.8, BADGE_STRIP_Y),
          );
          ctx.bezierCurveTo(
            x(rectMinX(head) + 19 - lean),
            rectMaxY(head) + 13 + lean,
            x(rectMinX(head) + 27),
            rectMaxY(head) + 2,
            x(rectMinX(head) + 31),
            rectMaxY(head) - 8,
          );
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "rose": {
          // Folded back on itself — small, low, and set wide.
          const cx = x(rectMinX(head) + 8);
          const cy = rectMaxY(head) - 20;
          fillOval(ctx, rect(cx - 11, cy - 9, 24, 20), blend(p.furDark, 0.5, p.fur));
          fillOval(ctx, rect(cx - 5, cy - 5, 14, 12), withAlpha(p.inner, 0.7));
          break;
        }
      }
    }
  }

  // --- Muzzle ---

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const noseY = this.breed.muzzle === "short" ? 108 : 106;

    // Dogs get a proper rounded nose leather, not the cat's little triangle.
    fillOval(ctx, rect(85 - 8, noseY - 6, 16, 12), p.nose);
    fillOval(ctx, rect(85 - 3.5, noseY - 1, 7, 4), withAlpha(WHITE, 0.22));

    const my = noseY - 8;
    ctx.strokeStyle = css(withAlpha(p.ink, 0.85));

    switch (s.mood) {
      case "tantrum": {
        // A bark: open mouth with teeth. The dogs are the loud ones.
        fillOval(ctx, rect(85 - 13, my - 15, 26, 18), p.ink);
        fillOval(
          ctx,
          rect(85 - 7, my - 14, 14, 9),
          rgba(Math.round(0.85 * 255), Math.round(0.45 * 255), Math.round(0.48 * 255), 1),
        );
        ctx.fillStyle = css(WHITE);
        for (const dx of [-10, 6]) {
          ctx.beginPath();
          ctx.moveTo(85 + dx, my - 2);
          ctx.lineTo(85 + dx + 4, my - 2);
          ctx.lineTo(85 + dx + 2, my - 7);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case "happy":
      case "proud": {
        // Open smile with a tongue — a dog's default expression.
        ctx.beginPath();
        ctx.moveTo(85 - 11, my);
        ctx.bezierCurveTo(85 - 7, my - 11, 85 + 7, my - 11, 85 + 11, my);
        ctx.lineWidth = 1.9;
        ctx.lineCap = "round";
        ctx.stroke();
        fillRounded(
          ctx,
          rect(85 - 5, my - 12, 10, 11),
          5,
          rgba(Math.round(0.93 * 255), Math.round(0.52 * 255), Math.round(0.55 * 255), 1),
        );
        break;
      }
      default: {
        // The classic dog "w" mouth.
        ctx.beginPath();
        ctx.moveTo(85, my + 1);
        ctx.lineTo(85, my - 3);
        ctx.moveTo(85, my - 3);
        ctx.bezierCurveTo(85 - 2, my - 8, 85 - 7, my - 8, 85 - 9, my - 4);
        ctx.moveTo(85, my - 3);
        ctx.bezierCurveTo(85 + 2, my - 8, 85 + 7, my - 8, 85 + 9, my - 4);
        ctx.lineWidth = 1.8;
        ctx.lineCap = "round";
        ctx.stroke();

        if (this.breed.jowls) {
          // Underbite: two small bottom teeth poking up over the lip.
          for (const dx of [-7, 3]) {
            fillRounded(ctx, rect(85 + dx, my - 6, 4.5, 5), 1.5, WHITE);
          }
        }
        break;
      }
    }

    // Freckle dots on the muzzle.
    const freckle = withAlpha(p.furDark, 0.3);
    for (const [dx, dy] of [
      [-16, 2],
      [-13, -4],
      [14, 2],
      [11, -4],
    ] as const) {
      fillOval(ctx, rect(85 + dx, noseY + dy - 6, 2.6, 2.6), freckle);
    }
  }
}
