import type {
  Color,
  Companion,
  CompanionGroup,
  CompanionPalette,
  Ctx2D,
  Mood,
  Point,
  Rect,
  SceneState,
} from "../core/types";
import { point, rect } from "../core/types";
import { css, rgba, withAlpha, LOAF_INK, LOAF_BLUSH } from "../core/color";
import { fillOval, fillRounded, line } from "../core/draw";

/**
 * Biscuit — the watchdog of the closet. Ported from `CompanionShiba.swift`.
 *
 * A sitting shiba inu: small erect triangular ears, a broad cream mask, and the
 * tail ringing up over the hip. The cream markings do most of the identifying
 * work — a plain tan animal of this shape is a fox, and it is the white that
 * makes it a shiba.
 *
 * He keeps his own file rather than joining the DogBreed engine because the
 * curled tail is a swept tapered ribbon with bespoke geometry that a shared
 * tail union would only flatten.
 */
export class ShibaCompanion implements Companion {
  readonly id = "shiba";
  readonly defaultName = "Biscuit";
  readonly species = "Shiba Inu";
  readonly group: CompanionGroup = "dogs";
  readonly blurb = "The watchdog. Takes the tab situation personally.";
  readonly castsShadow = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  readonly palette: CompanionPalette = {
    fur: rgba(Math.round(0.878 * 255), Math.round(0.663 * 255), Math.round(0.427 * 255), 1),
    furDark: rgba(
      Math.round(0.753 * 255),
      Math.round(0.541 * 255),
      Math.round(0.306 * 255),
      1,
    ),
    furLight: rgba(255, Math.round(0.953 * 255), Math.round(0.878 * 255), 1),
    inner: rgba(Math.round(0.949 * 255), Math.round(0.635 * 255), Math.round(0.635 * 255), 1),
    ink: LOAF_INK,
    nose: rgba(Math.round(0.29 * 255), Math.round(0.208 * 255), Math.round(0.153 * 255), 1),
    blush: LOAF_BLUSH,
  };

  /**
   * Broader and shallower than the cat's head — a shiba's skull reads wide, and
   * that width is what leaves room for cream cheeks either side of the muzzle.
   */
  readonly headEllipse: Rect = rect(44, 80, 82, 68);
  readonly eyeLeft: Point = point(68, 119);
  readonly eyeRight: Point = point(102, 119);
  /** Beadier than the cat: a shiba's eyes are small, dark and set wide. */
  readonly eyeScale = 0.9;
  readonly hatAnchor: Point = point(85, 148);
  /**
   * Low — on the chest rather than under the chin. His cream muzzle hangs
   * *below* the head ellipse and the mouth sits at y 87–96, so a scarf placed
   * by the usual "just under the skull" rule wraps across his face and gags
   * him.
   */
  readonly neckY = 74;
  readonly handLeft: Point = point(56, 44);
  readonly handRight: Point = point(114, 44);
  /** A shiba's front paws are cream socks, not tan. */
  get handFill(): Color {
    return this.palette.furLight;
  }

  // --- Behind: the curl ---

  /**
   * The curl — the one shiba feature nobody mistakes for another breed.
   *
   * A tapered ribbon swept along an inward spiral rather than a stroked path,
   * because a stroke can only be one width: constant width gives a door handle,
   * and the taper is what gives the ring a thick base and a slim top. The body
   * is drawn over both ends afterwards, so the tail comes out from behind the
   * hip and goes back in behind the shoulder.
   */
  drawBehind(ctx: Ctx2D, s: SceneState): void {
    const sway = this.tailSway(s);

    ctx.fillStyle = css(this.palette.fur);
    this.tailRibbon(ctx, 0, 1, sway, 1, 0);
    ctx.fill();
    // The ribbon strip ends on a flat chord across its own width. A chord is
    // never the right way to finish a tail, so both ends get a disc of the
    // local width. The tan one goes down first so the cream physically cannot
    // escape past it.
    this.roundOff(ctx, 1, sway, 1, 0, this.palette.fur);

    // Cream underside, lining the inside of the loop. A pale blob on the end
    // instead reads as a bone; running the cream along the underside is both
    // what a shiba's tail does and what tells you the ring is a furry thing
    // curled over rather than a flat washer stuck to his hip.
    ctx.fillStyle = css(this.palette.furLight);
    this.tailRibbon(ctx, 0.1, 0.94, sway, 0.42, -0.28);
    ctx.fill();
    this.roundOff(ctx, 0.94, sway, 0.42, -0.28, this.palette.furLight);
  }

  /** Caps one end of a tail band with a disc of its own width. */
  private roundOff(
    ctx: Ctx2D,
    t: number,
    sway: number,
    widthScale: number,
    offset: number,
    fill: Color,
  ): void {
    const { p, n, w } = this.tailSample(t, sway);
    const cx = p.x + n.x * w * offset;
    const cy = p.y + n.y * w * offset;
    const d = w * widthScale;
    fillOval(ctx, rect(cx - d / 2, cy - d / 2, d, d), fill);
  }

  /**
   * How hard the curl is swinging. He wags when pleased — that is most of what
   * separates a dog from the cat — and buzzes when cross.
   */
  private tailSway(s: SceneState): number {
    let speed: number;
    let amp: number;
    switch (s.mood) {
      case "happy":
      case "proud":
        speed = 8.0;
        amp = 0.3;
        break;
      case "tantrum":
        speed = 12.0;
        amp = 0.2;
        break;
      case "sleeping":
        speed = 0.9;
        amp = 0.05;
        break;
      case "scrolling":
        speed = 2.4;
        amp = 0.09;
        break;
      default:
        speed = 1.6;
        amp = 0.11;
    }
    return Math.sin(s.phase * speed) * amp;
  }

  /**
   * One point on the curl: `t` = 0 is the root buried in the hip, 1 is the tip.
   * Both ends are hidden inside the body, and the sway is weighted to vanish at
   * both — a tail that pivots at the root looks detached, and one whose tip
   * swings out from behind the back keeps sprouting a stub mid-wag. The weight
   * peaks at t = 2/3, so what you see swinging is the free part of the ring.
   */
  private tailSample(
    t: number,
    sway: number,
  ): { p: Point; n: Point; w: number } {
    // Placed in the one window of clear space he has: outboard of the torso and
    // above the haunch. It carries far enough round — 131 degrees, past
    // vertical — that the tip comes back down BEHIND the shoulder and is
    // covered by the body, which is what a real curl does.
    const centre = point(123, 66);
    const a = -2.531 + (2.3 + 2.531) * t + sway * 6.75 * t * t * (1 - t);
    const r = 16 - 4 * t;
    const n = point(Math.cos(a), Math.sin(a));
    return {
      p: point(centre.x + r * n.x, centre.y + r * n.y),
      n,
      w: 14 - 6 * t,
    };
  }

  /**
   * `widthScale` and `offset` (in multiples of the full width, positive =
   * outward) carve a narrower band out of the same sweep, which is how the
   * cream underside is drawn without a second set of geometry to keep in sync.
   *
   * Leaves the path current so the caller fills it.
   */
  private tailRibbon(
    ctx: Ctx2D,
    tA: number,
    tB: number,
    sway: number,
    widthScale: number,
    offset: number,
  ): void {
    const innerEdge: Point[] = [];
    const steps = 28;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = tA + ((tB - tA) * i) / steps;
      const { p: raw, n, w: fullW } = this.tailSample(t, sway);
      const px = raw.x + n.x * fullW * offset;
      const py = raw.y + n.y * fullW * offset;
      const w = fullW * widthScale;
      const ox = px + (n.x * w) / 2;
      const oy = py + (n.y * w) / 2;
      innerEdge.push(point(px - (n.x * w) / 2, py - (n.y * w) / 2));
      if (i === 0) ctx.moveTo(ox, oy);
      else ctx.lineTo(ox, oy);
    }
    for (let i = innerEdge.length - 1; i >= 0; i--) {
      ctx.lineTo(innerEdge[i]!.x, innerEdge[i]!.y);
    }
    ctx.closePath();
  }

  // --- Body ---

  drawBody(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;

    // Haunches, tucked out to the sides the way a sitting dog folds them.
    fillOval(ctx, rect(30, 14, 45, 37), p.fur);
    fillOval(ctx, rect(95, 14, 45, 37), p.fur);
    // Cream hind feet poking out from under them.
    fillOval(ctx, rect(31, 13, 26, 14), p.furLight);
    fillOval(ctx, rect(113, 13, 26, 14), p.furLight);

    // Shoulders. Narrow and set low on purpose: the cheek ruff has to overhang
    // something for the outline to pinch at the neck. The gap between the top
    // corner (y 102) and the bottom of the ruff (y 89) is where it bites in.
    ctx.fillStyle = css(p.fur);
    ctx.beginPath();
    ctx.moveTo(60, 102);
    ctx.bezierCurveTo(53, 86, 46, 64, 48, 48);
    ctx.bezierCurveTo(50, 28, 64, 16, 85, 16);
    ctx.bezierCurveTo(106, 16, 120, 28, 122, 48);
    ctx.bezierCurveTo(122, 64, 117, 86, 110, 102);
    ctx.closePath();
    ctx.fill();

    // The bib. Runs to a point low on the belly and flares wide at the top; the
    // top edge deliberately overshoots into the head so the head covers the
    // seam instead of leaving a tan gap under the chin.
    ctx.fillStyle = css(p.furLight);
    ctx.beginPath();
    ctx.moveTo(55, 93);
    ctx.bezierCurveTo(57, 55, 70, 26, 85, 19);
    ctx.bezierCurveTo(100, 26, 113, 55, 115, 93);
    ctx.bezierCurveTo(110, 112, 60, 112, 55, 93);
    ctx.closePath();
    ctx.fill();

    // Front legs: tan at the shoulder, cream from the knee down. Shibas wear
    // socks, and the split gives the legs a joint without drawing an outline.
    fillRounded(ctx, rect(65, 16, 16, 44), 8, p.fur);
    fillRounded(ctx, rect(89, 16, 16, 44), 8, p.fur);
    for (const x of [65, 89]) {
      fillRounded(ctx, rect(x, 14, 16, 22), 8, p.furLight);
    }
    fillOval(ctx, rect(59, 13, 26, 15), p.furLight);
    fillOval(ctx, rect(85, 13, 26, 15), p.furLight);

    ctx.strokeStyle = css(withAlpha(p.furDark, 0.45));
    for (const cx of [68, 76, 94, 102]) {
      line(ctx, point(cx, 15), point(cx, 21), 1.4);
    }
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.35));
    for (const cx of [40, 48, 122, 130]) {
      line(ctx, point(cx, 15), point(cx, 20), 1.3);
    }
  }

  // --- Head ---

  drawHead(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const tilt = this.earTilt(s.mood);

    for (const flip of [false, true]) {
      const pivot = point(flip ? 110 : 60, 136);
      const spin = tilt * (flip ? -1 : 1);
      // Ears are authored once, upright, and rotated about their own base —
      // pinning them back for the bark is then one number instead of a second
      // set of curves.
      const pt = (x: number, y: number): Point => {
        const dx = (flip ? 170 - x : x) - pivot.x;
        const dy = y - pivot.y;
        return point(
          pivot.x + dx * Math.cos(spin) - dy * Math.sin(spin),
          pivot.y + dx * Math.sin(spin) + dy * Math.cos(spin),
        );
      };

      const e0 = pt(48, 126);
      const e1 = pt(48, 140);
      const e2 = pt(51, 150);
      const e3 = pt(56, 157);
      const e4 = pt(63, 155);
      const e5 = pt(72, 150);
      const e6 = pt(78, 143);
      ctx.fillStyle = css(p.fur);
      ctx.beginPath();
      ctx.moveTo(e0.x, e0.y);
      ctx.bezierCurveTo(e1.x, e1.y, e2.x, e2.y, e3.x, e3.y);
      ctx.bezierCurveTo(e4.x, e4.y, e5.x, e5.y, e6.x, e6.y);
      ctx.closePath();
      ctx.fill();

      const i0 = pt(55, 131);
      const i1 = pt(55, 139);
      const i2 = pt(55.5, 145);
      const i3 = pt(57.5, 150);
      const i4 = pt(63, 148);
      const i5 = pt(68, 145);
      const i6 = pt(72, 141);
      ctx.fillStyle = css(p.inner);
      ctx.beginPath();
      ctx.moveTo(i0.x, i0.y);
      ctx.bezierCurveTo(i1.x, i1.y, i2.x, i2.y, i3.x, i3.y);
      ctx.bezierCurveTo(i4.x, i4.y, i5.x, i5.y, i6.x, i6.y);
      ctx.closePath();
      ctx.fill();
    }

    fillOval(ctx, this.headEllipse, p.fur);
    // Cheek floof. A shiba's face is a wide wedge, not a circle, and these two
    // ovals stop the head reading as a ball with ears on it.
    fillOval(ctx, rect(41, 89, 36, 31), p.fur);
    fillOval(ctx, rect(93, 89, 36, 31), p.fur);

    // The cream mask: muzzle plus both cheeks, as overlapping ovals so the top
    // edge waves the way real markings do instead of cutting a straight line.
    fillOval(ctx, rect(60, 78, 50, 35), p.furLight);
    fillOval(ctx, rect(43.5, 91, 31, 26), p.furLight);
    fillOval(ctx, rect(95.5, 91, 31, 26), p.furLight);

    // Brow spots. Small and slightly oval — round and large enough and they
    // stop reading as markings and start reading as a second pair of eyes. Set
    // high on purpose: the shared worried/tantrum brows occupy the band just
    // above the eyes, topping out at y ~136, so these start at 137.
    for (const x of [this.eyeLeft.x - 1, this.eyeRight.x + 1]) {
      fillOval(ctx, rect(x - 3.5, 137, 7, 5.5), p.furLight);
    }
  }

  /** Ear angle in radians, positive = swung outward and down. */
  private earTilt(mood: Mood): number {
    switch (mood) {
      case "tantrum":
        return 0.78; // pinned flat back — this is a bark, not a sulk
      case "scrolling":
        return -0.17; // tipped forward, reading over your shoulder
      case "worried":
        return 0.28;
      case "sleeping":
        return 0.2;
      default:
        return 0;
    }
  }

  // --- Muzzle ---

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;

    // A big dark button nose. The loudest "this is a dog" signal available at
    // this size, so it gets to be oversized.
    ctx.fillStyle = css(p.nose);
    ctx.beginPath();
    ctx.moveTo(76.5, 105);
    ctx.bezierCurveTo(78, 112, 92, 112, 93.5, 105);
    ctx.bezierCurveTo(93.5, 100.5, 89.5, 97, 85, 96.5);
    ctx.bezierCurveTo(80.5, 97, 76.5, 100.5, 76.5, 105);
    ctx.closePath();
    ctx.fill();

    if (s.mood === "tantrum") {
      this.drawBark(ctx, s);
    } else if (s.mood === "happy" || s.mood === "proud") {
      this.drawPant(ctx, s);
    } else {
      ctx.beginPath();
      ctx.moveTo(85, 96);
      ctx.lineTo(85, 92);
      ctx.moveTo(85, 92);
      ctx.bezierCurveTo(84, 87, 78, 87.5, 75, 94.5);
      ctx.moveTo(85, 92);
      ctx.bezierCurveTo(86, 87, 92, 87.5, 95, 94.5);
      ctx.lineWidth = 1.9;
      ctx.lineCap = "round";
      ctx.strokeStyle = css(withAlpha(p.ink, 0.9));
      ctx.stroke();
    }

    // Whisker pads. Dogs get dots rather than the cat's long whiskers — the
    // stubble keeps the cream muzzle from looking blank.
    const stubble = withAlpha(p.furDark, 0.6);
    for (const [x, y] of [
      [67, 99],
      [64, 93.5],
      [70, 89],
      [103, 99],
      [106, 93.5],
      [100, 89],
    ] as const) {
      fillOval(ctx, rect(x - 1.2, y - 1.2, 2.4, 2.4), stubble);
    }
  }

  /**
   * The tantrum bark. The jaw snaps on the same beat as the shared tantrum bob
   * (phase x 7), so the whole body looks like it is driving the noise rather
   * than bouncing next to it.
   */
  private drawBark(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // The top lip sits clear of the nose on purpose — butted against it the two
    // dark shapes merge into one blob and the bark stops reading as a mouth.
    const open = 7 + 7.5 * Math.abs(Math.sin(s.phase * 7));

    const jaw = (): void => {
      ctx.beginPath();
      ctx.moveTo(70, 92.5);
      ctx.bezierCurveTo(79, 95.5, 91, 95.5, 100, 92.5);
      ctx.bezierCurveTo(98, 92.5 - open * 1.9, 72, 92.5 - open * 1.9, 70, 92.5);
      ctx.closePath();
    };

    jaw();
    ctx.fillStyle = css(p.ink);
    ctx.fill();

    // Tongue and fangs live inside the jaw, so they are clipped to it and stay
    // put however wide the mouth is on this frame. The fangs stay small and in
    // the corners — filling the gap with teeth turns a bark into a horror-film
    // grin, and he is meant to be annoying, not frightening.
    ctx.save();
    jaw();
    ctx.clip();
    fillOval(ctx, rect(77, 92.5 - open * 1.75, 16, open * 1.1), p.inner);
    ctx.fillStyle = css(p.furLight);
    for (const x of [72.5, 93.5]) {
      ctx.beginPath();
      ctx.moveTo(x, 94.5);
      ctx.lineTo(x + 4, 94.5);
      ctx.lineTo(x + 2, 89.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Pleased shiba: open mouth, tongue out. The pant is the whole expression —
   * a dog that is not panting does not look happy, it looks patient.
   */
  private drawPant(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    ctx.fillStyle = css(p.ink);
    ctx.beginPath();
    ctx.moveTo(74, 93);
    ctx.bezierCurveTo(80, 95, 90, 95, 96, 93);
    ctx.bezierCurveTo(93, 82, 77, 82, 74, 93);
    ctx.closePath();
    ctx.fill();

    const loll = Math.sin(s.phase * 4) * 1.3;
    fillRounded(ctx, rect(79, 75 + loll, 13, 15), 6.5, p.inner);
    ctx.strokeStyle = css(withAlpha(p.nose, 0.25));
    line(ctx, point(85.5, 78 + loll), point(85.5, 84 + loll), 1.3);
  }
}
