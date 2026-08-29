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
import { BADGE_STRIP_Y, point, rect } from "../core/types";
import { css, hex, withAlpha } from "../core/color";
import { fillOval, fillRounded, line, onCurve, strokeLine } from "../core/draw";
import type { CatCoat } from "./catBreeds";
import { CAT_COATS, findCoat } from "./catBreeds";

/**
 * The shared cat: a sitting tabby-shaped animal whose coat comes from data.
 *
 * Ported from `CatCompanion` in `CatBreeds.swift`. Geometry numbers are carried
 * over unchanged — the design space is still 170 x 190 y-up, so every literal
 * here can be diffed directly against the Swift original.
 */
export class CatCompanion implements Companion {
  readonly coat: CatCoat;

  constructor(coat: CatCoat = CAT_COATS[0]!) {
    this.coat = coat;
  }

  static byId(id: string): CatCompanion {
    return new CatCompanion(findCoat(id));
  }

  get id(): string {
    return this.coat.id;
  }
  get defaultName(): string {
    return this.coat.defaultName;
  }
  get species(): string {
    return this.coat.breed;
  }
  get blurb(): string {
    return this.coat.blurb;
  }
  get group(): CompanionGroup {
    return "cats";
  }
  get palette(): CompanionPalette {
    return this.coat.palette;
  }

  readonly castsShadow = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  // --- Anchors ---

  /** A persian's skull is wider and lower; everyone else shares the base head. */
  get headEllipse(): Rect {
    return this.coat.flatFace
      ? rect(41, 83, 88, 64)
      : rect(46, 83, 78, 66);
  }
  get eyeLeft(): Point {
    return point(this.coat.flatFace ? 67 : 70, this.coat.flatFace ? 116 : 118);
  }
  get eyeRight(): Point {
    return point(this.coat.flatFace ? 103 : 100, this.coat.flatFace ? 116 : 118);
  }
  get eyeScale(): number {
    return this.coat.flatFace ? 1.12 : 1.0;
  }
  get hatAnchor(): Point {
    return point(85, this.coat.flatFace ? 142 : 146);
  }
  get neckY(): number {
    return 92;
  }
  get handLeft(): Point {
    return point(57, 45);
  }
  get handRight(): Point {
    return point(113, 45);
  }
  get handFill(): Color {
    return this.coat.socks ? this.palette.furLight : this.palette.fur;
  }

  // --- Behind ---

  drawBehind(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const speed = s.mood === "tantrum" ? 9.5 : s.mood === "sleeping" ? 0.7 : 1.6;
    const amp = s.mood === "tantrum" ? 16 : s.mood === "sleeping" ? 4 : 9;
    const sway = Math.sin(s.phase * speed) * amp;
    // A long-haired tail is a plume: much thicker, and it doesn't taper.
    const width = this.coat.longHair ? 19 : s.mood === "tantrum" ? 15 : 11;

    const p0 = point(118, 24);
    const p1 = point(146, 18);
    const p2 = point(158, 38 + sway * 0.5);
    const p3 = point(152 + sway * 0.35, 62 + sway);

    ctx.strokeStyle = css(p.fur);
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();

    if (this.coat.stripes) {
      ctx.strokeStyle = css(withAlpha(p.furDark, 0.75));
      for (const t of [0.62, 0.82]) {
        const a = onCurve(p0, p1, p2, p3, t);
        const b = onCurve(p0, p1, p2, p3, t + 0.07);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = width;
        ctx.lineCap = "butt";
        ctx.stroke();
      }
    }
    if (this.coat.patches) {
      // One dark patch near the tip — calico tails are blotched, not ringed.
      ctx.strokeStyle = css(withAlpha(p.furDark, 0.9));
      const a = onCurve(p0, p1, p2, p3, 0.66);
      const b = onCurve(p0, p1, p2, p3, 0.88);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    if (this.coat.socks) {
      // White tail tip.
      ctx.strokeStyle = css(p.furLight);
      const a = onCurve(p0, p1, p2, p3, 0.88);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;

    // Haunches.
    fillOval(ctx, rect(26, 14, 48, 38), p.fur);
    fillOval(ctx, rect(96, 14, 48, 38), p.fur);
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.35));
    for (const cx of [38, 132]) {
      line(ctx, point(cx, 17), point(cx, 23), 1.4);
    }

    // Torso.
    ctx.fillStyle = css(p.fur);
    ctx.beginPath();
    ctx.moveTo(58, 98);
    ctx.bezierCurveTo(52, 80, 44, 62, 45, 44);
    ctx.bezierCurveTo(46, 24, 62, 14, 85, 14);
    ctx.bezierCurveTo(108, 14, 124, 24, 125, 44);
    ctx.bezierCurveTo(126, 62, 118, 80, 112, 98);
    ctx.closePath();
    ctx.fill();

    if (this.coat.patches) this.drawCalicoPatches(ctx);
    if (this.coat.rosettes) this.drawRosettes(ctx);

    if (this.coat.bib) {
      fillOval(ctx, rect(63, 24, 44, 62), withAlpha(p.furLight, 0.85));
    }
    if (this.coat.socks) {
      // A desi cat's white chest flash is a wedge, not a full bib.
      ctx.fillStyle = css(p.furLight);
      ctx.beginPath();
      ctx.moveTo(85, 92);
      ctx.bezierCurveTo(74, 76, 72, 50, 74, 30);
      ctx.bezierCurveTo(82, 22, 88, 22, 96, 30);
      ctx.bezierCurveTo(98, 50, 96, 76, 85, 92);
      ctx.closePath();
      ctx.fill();
    }

    if (this.coat.stripes) {
      const bar = withAlpha(p.furDark, 0.65);
      for (const [x, y] of [
        [47, 50],
        [50, 64],
        [108, 50],
        [105, 64],
      ] as const) {
        fillRounded(ctx, rect(x, y, 15, 4.5), 2.2, bar);
      }
    }

    // Front legs and paws.
    fillRounded(ctx, rect(66, 16, 15, 42), 7.5, p.fur);
    fillRounded(ctx, rect(89, 16, 15, 42), 7.5, p.fur);
    if (this.coat.socks) {
      // White socks stop partway up the leg, which is the whole look.
      fillRounded(ctx, rect(66, 16, 15, 22), 7.5, p.furLight);
      fillRounded(ctx, rect(89, 16, 15, 22), 7.5, p.furLight);
    }
    const pawFill = this.coat.socks ? p.furLight : p.fur;
    for (const x of [61, 84]) {
      fillOval(ctx, rect(x, 13, 25, 15), pawFill);
    }
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.4));
    for (const cx of [69.5, 77, 92.5, 100]) {
      line(ctx, point(cx, 15), point(cx, 21), 1.4);
    }

    if (this.coat.longHair) this.drawRuff(ctx);
  }

  /**
   * Calico blotches: hard-edged, asymmetric, and never mirrored — a symmetrical
   * calico reads as a pattern rather than an animal.
   */
  private drawCalicoPatches(ctx: Ctx2D): void {
    const ginger = hex(0xe79a4f);
    const ink = this.palette.furDark;
    const blotches: ReadonlyArray<readonly [Rect, Color]> = [
      [rect(44, 52, 34, 40), ginger],
      [rect(100, 30, 28, 34), ink],
      [rect(96, 66, 30, 28), ginger],
      [rect(48, 22, 24, 22), ink],
    ];
    for (const [r, colour] of blotches) {
      fillOval(ctx, r, colour);
    }
  }

  /**
   * Bengal rosettes: a dark ring with a warmer centre, scattered on a rough grid
   * with deliberate jitter so it doesn't read as polka dots.
   */
  private drawRosettes(ctx: Ctx2D): void {
    const spots: ReadonlyArray<readonly [number, number, number]> = [
      [56, 74, 9],
      [72, 60, 8],
      [98, 70, 9],
      [114, 56, 8],
      [62, 40, 7],
      [88, 34, 8],
      [110, 34, 7],
      [50, 58, 7],
      [104, 88, 7],
    ];
    const ring = withAlpha(this.palette.furDark, 0.85);
    const centre = hex(0xb9803f);
    for (const [x, y, r] of spots) {
      fillOval(ctx, rect(x - r, y - r * 0.8, r * 2, r * 1.6), ring);
      fillOval(ctx, rect(x - r * 0.5, y - r * 0.4, r, r * 0.8), centre);
    }
  }

  /**
   * The long-hair neck ruff.
   *
   * Overlapping soft lobes, not points: fur drawn as triangles reads as a lace
   * collar, which is the opposite of "this cat is mostly floof". Each lobe is a
   * circle big enough to merge with its neighbours, so the outline comes out as
   * a continuous scalloped cloud rather than teeth.
   */
  private drawRuff(ctx: Ctx2D): void {
    const p = this.palette;
    // A soft under-layer first, so the scallops sit on mass rather than floating.
    fillOval(ctx, rect(40, 74, 90, 40), p.furLight);
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (1.02 + (0.96 * i) / 8.0);
      const cx = 85 + Math.cos(a) * 45;
      const cy = 97 + Math.sin(a) * 24;
      // Lobes fatten toward the bottom of the arc, where a real ruff is deepest.
      const r = 11 - 3 * Math.cos(a) * Math.cos(a);
      fillOval(ctx, rect(cx - r, cy - r, r * 2, r * 2), p.furLight);
    }
    // A few soft shadow strokes so the mass has some internal structure.
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.22));
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (1.12 + (0.76 * i) / 4.0);
      const cx = 85 + Math.cos(a) * 40;
      const cy = 97 + Math.sin(a) * 20;
      line(ctx, point(cx, cy), point(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7), 1.6);
    }
  }

  // --- Head ---

  drawHead(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const k = this.coat.earScale;
    const lean = s.mood === "tantrum" ? -6 : s.mood === "scrolling" ? 3 : 0;

    // Highest raw y whose scaled result still clears the reserved badge strip.
    // The ear is scaled about its base (y=124), so the ceiling depends on the
    // coat's earScale: a bigger ear reaches the strip from a lower raw value.
    const maxRawY = 124 + (BADGE_STRIP_Y - 124) / k;

    for (const flip of [false, true]) {
      // Scale the ear about its own base so a bigger ear grows upward rather
      // than detaching from the skull.
      const e = (x: number, y: number): Point => {
        const sx = 85 + (x - 85) * (0.82 + 0.18 * k);
        const sy = 124 + (y - 124) * k;
        return point(flip ? 170 - sx : sx, sy);
      };

      const outer0 = e(56, 124);
      const outerC1 = e(52, 140);
      const outerC2 = e(50, 152);
      // The scrolling pose leans the ears UP, which on the tallest coat (indie,
      // earScale 1.16) pushed the tip to y=169.24 — inside the strip reserved
      // for the tab badge. Clamping only the height keeps the lean's sideways
      // gesture intact: the ear still tips forward, it just stops growing.
      const outer1 = e(51 - lean * 0.6, Math.min(160 + lean, maxRawY));
      const outerC3 = e(60 - lean, 162 + lean);
      const outerC4 = e(74, 152);
      const outer2 = e(84, 138);

      ctx.fillStyle = css(p.fur);
      ctx.beginPath();
      ctx.moveTo(outer0.x, outer0.y);
      ctx.bezierCurveTo(outerC1.x, outerC1.y, outerC2.x, outerC2.y, outer1.x, outer1.y);
      ctx.bezierCurveTo(outerC3.x, outerC3.y, outerC4.x, outerC4.y, outer2.x, outer2.y);
      ctx.closePath();
      ctx.fill();

      const in0 = e(61, 128);
      const inC1 = e(58, 138);
      const inC2 = e(56, 146);
      const in1 = e(57 - lean * 0.5, 152 + lean * 0.8);
      const inC3 = e(63 - lean, 153 + lean);
      const inC4 = e(70, 147);
      const in2 = e(77, 138);

      ctx.fillStyle = css(p.inner);
      ctx.beginPath();
      ctx.moveTo(in0.x, in0.y);
      ctx.bezierCurveTo(inC1.x, inC1.y, inC2.x, inC2.y, in1.x, in1.y);
      ctx.bezierCurveTo(inC3.x, inC3.y, inC4.x, inC4.y, in2.x, in2.y);
      ctx.closePath();
      ctx.fill();
    }

    fillOval(ctx, this.headEllipse, p.fur);

    // Cheek floof. A persian's is wide and low, which is what flattens the face.
    if (this.coat.flatFace) {
      fillOval(ctx, rect(44, 92, 40, 28), p.fur);
      fillOval(ctx, rect(86, 92, 40, 28), p.fur);
    } else {
      fillOval(ctx, rect(49, 94, 32, 24), p.fur);
      fillOval(ctx, rect(89, 94, 32, 24), p.fur);
    }

    if (this.coat.socks) {
      // White muzzle and chin, the giveaway of a desi cat.
      fillOval(ctx, rect(62, 92, 46, 26), p.furLight);
    }
    if (this.coat.patches) {
      // One patch over an eye — the single most calico thing there is.
      fillOval(ctx, rect(88, 112, 34, 32), hex(0xe79a4f));
      fillOval(ctx, rect(50, 122, 26, 24), p.furDark);
    }

    if (this.coat.stripes) {
      // The forehead M.
      const bar = withAlpha(p.furDark, 0.8);
      for (const [x, h] of [
        [76, 11],
        [83, 15],
        [90, 11],
      ] as const) {
        fillRounded(ctx, rect(x, 147 - h, 4.5, h + 2), 2.2, bar);
      }
    }
    if (this.coat.rosettes) {
      const bar = withAlpha(p.furDark, 0.8);
      for (const [x, y, w] of [
        [72, 140, 4],
        [85, 144, 4.5],
        [98, 140, 4],
      ] as const) {
        fillRounded(ctx, rect(x, y - 10, w, 12), 2, bar);
      }
    }
  }

  // --- Muzzle ---

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // A flat face sits the nose lower and closer to the mouth.
    const noseY = this.coat.flatFace ? 105 : 108;

    ctx.fillStyle = css(p.nose);
    ctx.beginPath();
    ctx.moveTo(81, noseY);
    ctx.lineTo(89, noseY);
    ctx.lineTo(85, noseY - 4.5);
    ctx.closePath();
    ctx.fill();

    const mouthY = noseY - 5;
    ctx.strokeStyle = css(withAlpha(p.ink, 0.85));
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (s.mood === "tantrum") {
      // A jagged, cross mouth.
      ctx.moveTo(74, mouthY - 1);
      let i = 0;
      for (let x = 78; x <= 96 + 1e-9; x += 4.5) {
        ctx.lineTo(x, i % 2 === 0 ? mouthY - 6 : mouthY - 1);
        i++;
      }
    } else {
      ctx.moveTo(85, mouthY);
      ctx.bezierCurveTo(84, mouthY - 6, 78, mouthY - 6, 76, mouthY - 2);
      ctx.moveTo(85, mouthY);
      ctx.bezierCurveTo(86, mouthY - 6, 92, mouthY - 6, 94, mouthY - 2);
    }
    ctx.stroke();

    // Whiskers.
    const whisker = withAlpha(p.ink, 0.4);
    const inset = this.coat.flatFace ? 47 : 52;
    const pairs: ReadonlyArray<readonly [Point, Point]> = [
      [point(inset, 111), point(26, 115)],
      [point(inset, 105), point(27, 103)],
      [point(170 - inset, 111), point(144, 115)],
      [point(170 - inset, 105), point(143, 103)],
    ];
    for (const [a, b] of pairs) {
      strokeLine(ctx, a, b, 1.2, whisker);
    }
  }
}
