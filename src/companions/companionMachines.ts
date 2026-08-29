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
import { insetBy, point, rect } from "../core/types";
import { css, hex, rgba, withAlpha, WHITE, LOAF_BLUSH } from "../core/color";
import { fillOval, fillRounded, line, roundedRectPath } from "../core/draw";

/**
 * The machines shelf. Ported from `CompanionMachines.swift`.
 *
 * All three reuse the shared eye system rather than inventing single cyclops
 * lenses: two lights behind a visor still get closed lids when asleep, angry
 * brows when cross and arcs when pleased, so a machine gets the whole mood
 * vocabulary for free instead of needing its own.
 */

/** The alarm red every machine turns when cross. */
const ALARM = hex(0xe5544b);

// ---------------------------------------------------------------------------

/** Orbit — a hovering courier droid. */
export class DroidCompanion implements Companion {
  readonly id = "droid";
  readonly defaultName = "Orbit";
  readonly species = "Courier droid";
  readonly blurb = "Hovers. Observes. Files a report.";
  readonly group: CompanionGroup = "machines";
  /** It floats. A hard contact shadow would nail it to the floor. */
  readonly castsShadow = false;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  readonly palette: CompanionPalette = {
    fur: hex(0xe6e1da),
    furDark: hex(0x9aa2ac),
    furLight: hex(0xfbf9f6),
    inner: hex(0x6fd3e0),
    ink: hex(0x2b2c33),
    nose: hex(0x6fd3e0),
    blush: rgba(Math.round(0.44 * 255), Math.round(0.83 * 255), Math.round(0.88 * 255), 0.45),
    iris: hex(0x6fd3e0),
  };

  readonly headEllipse: Rect = rect(47, 84, 76, 68);
  readonly eyeLeft: Point = point(73, 118);
  readonly eyeRight: Point = point(97, 118);
  readonly eyeScale = 0.95;
  readonly hatAnchor: Point = point(85, 150);
  readonly neckY = 78;
  readonly handLeft: Point = point(50, 46);
  readonly handRight: Point = point(120, 46);
  get handFill(): Color {
    return this.palette.furDark;
  }

  /** A hover ring instead of a shadow: the thruster wash on the floor below. */
  drawBehind(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    const pulse = 0.55 + 0.45 * Math.sin(s.phase * (s.mood === "tantrum" ? 9 : 2.4));
    [34, 24, 15].forEach((r, i) => {
      const a = (0.1 - i * 0.025) * pulse;
      fillOval(ctx, rect(85 - r, 12 - 3, r * 2, 12), withAlpha(p.inner, a));
    });
    // Antenna with a blinking tip.
    //
    // Shortened from the reference, which ran the stalk to y=168 and put the
    // 7pt tip at y 165..172 — inside the strip reserved for the tab badge, in
    // every mood. The badge would have covered the blinking light exactly when
    // the droid was trying to get your attention with it. The stalk keeps its
    // lean; only its length changed.
    ctx.strokeStyle = css(p.furDark);
    line(ctx, point(85, 150), point(90, 161), 2.4);
    const blink =
      s.mood === "tantrum"
        ? Math.sin(s.phase * 14) > 0
          ? 1.0
          : 0.15
        : 0.55 + 0.45 * Math.sin(s.phase * 3);
    fillOval(
      ctx,
      rect(87, 158, 7, 7),
      withAlpha(s.mood === "tantrum" ? ALARM : p.inner, blink),
    );
  }

  drawBody(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // Chassis: a rounded capsule, narrower at the base so it reads as airborne.
    fillRounded(ctx, rect(55, 34, 60, 56), 22, p.fur);
    fillRounded(ctx, rect(62, 30, 46, 20), 10, p.furDark);
    // Side thruster pods.
    for (const x of [36, 116]) {
      fillRounded(ctx, rect(x, 44, 18, 34), 9, p.furDark);
      fillOval(ctx, rect(x + 3, 46, 12, 10), withAlpha(p.inner, 0.75));
    }
    // Chest panel with a status bar.
    fillRounded(ctx, rect(68, 52, 34, 24), 6, withAlpha(p.ink, 0.85));
    const bars = s.mood === "tantrum" ? 4 : 2;
    for (let i = 0; i < 4; i++) {
      const on = i < bars;
      const fill = on
        ? s.mood === "tantrum"
          ? ALARM
          : p.inner
        : withAlpha(p.furDark, 0.5);
      fillRounded(ctx, rect(72 + i * 7, 58, 5, 12), 2, fill);
    }
  }

  drawHead(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;
    fillOval(ctx, this.headEllipse, p.fur);
    // Visor: a dark band across the face, which the eyes sit on.
    fillRounded(ctx, rect(55, 104, 60, 30), 15, p.ink);
    // Panel seam and rivets, so it reads machined rather than moulded.
    ctx.strokeStyle = css(withAlpha(p.furDark, 0.6));
    line(ctx, point(56, 140), point(114, 140), 1.4);
    for (const x of [60, 110]) {
      fillOval(ctx, rect(x - 2, 144, 4, 4), p.furDark);
    }
  }

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    // Speaker grille standing in for a mouth.
    const p = this.palette;
    const w = s.mood === "tantrum" ? 30 : 20;
    fillRounded(ctx, rect(85 - w / 2, 92, w, 9), 4.5, withAlpha(p.ink, 0.8));
    ctx.strokeStyle = css(withAlpha(s.mood === "tantrum" ? ALARM : p.inner, 0.9));
    for (let i = 0; i < 4; i++) {
      const x = 85 - w / 2 + 4 + (i * (w - 8)) / 3;
      line(ctx, point(x, 94), point(x, 99), 1.6);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Tin — a boxy desk robot. Where the droid floats, this one sits, and it is
 * built out of straight lines on purpose: the only companion with corners.
 */
export class RobotCompanion implements Companion {
  readonly id = "robot";
  readonly defaultName = "Tin";
  readonly species = "Desk robot";
  readonly blurb = "Was built to count things. Finally useful.";
  readonly group: CompanionGroup = "machines";
  readonly castsShadow = true;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  readonly palette: CompanionPalette = {
    fur: hex(0xe9c9a0),
    furDark: hex(0xb08a63),
    furLight: hex(0xfbf0de),
    inner: hex(0x8a5080),
    ink: hex(0x33261d),
    nose: hex(0x8a5080),
    blush: rgba(Math.round(0.85 * 255), Math.round(0.5 * 255), Math.round(0.6 * 255), 0.4),
    iris: hex(0xffb25e),
  };

  readonly headEllipse: Rect = rect(48, 88, 74, 62);
  readonly eyeLeft: Point = point(72, 120);
  readonly eyeRight: Point = point(98, 120);
  readonly eyeScale = 1.0;
  readonly hatAnchor: Point = point(85, 152);
  readonly neckY = 84;
  readonly handLeft: Point = point(48, 46);
  readonly handRight: Point = point(122, 46);
  get handFill(): Color {
    return this.palette.furDark;
  }

  drawBehind(ctx: Ctx2D, s: SceneState): void {
    // Two aerials that droop when asleep and stand up when cross.
    const p = this.palette;
    const lean = s.mood === "sleeping" ? 14 : s.mood === "tantrum" ? -6 : 0;
    ctx.strokeStyle = css(p.furDark);
    // Lowered from the reference, which put the tip bulb at y 166..174 at rest
    // and 172..180 when cross — deepest into the reserved badge strip of any
    // character, and worst in exactly the mood the badge appears in. The
    // dimensions are unchanged; the whole assembly sits 14pt lower, which is
    // what the cross pose (lean = -6, the tallest case) needs to clear 166.
    for (const dir of [-1, 1]) {
      line(
        ctx,
        point(85 + dir * 20, 148),
        point(85 + dir * (28 + lean), 156 - lean),
        2.6,
      );
      fillOval(
        ctx,
        rect(85 + dir * (28 + lean) - 4, 152 - lean, 8, 8),
        s.mood === "tantrum" ? ALARM : p.inner,
      );
    }
  }

  drawBody(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // Boxy torso with a bevel, plus riveted shoulder plates.
    fillRounded(ctx, rect(48, 18, 74, 68), 10, p.fur);
    fillRounded(ctx, rect(40, 56, 18, 26), 7, p.furDark);
    fillRounded(ctx, rect(112, 56, 18, 26), 7, p.furDark);
    // Segmented arms hanging at the sides.
    for (const x of [38, 118]) {
      fillRounded(ctx, rect(x, 32, 14, 26), 6, p.fur);
      fillOval(ctx, rect(x - 2, 26, 18, 14), p.furDark);
    }
    // Chest plate with a dial that swings with the mood.
    fillRounded(ctx, rect(62, 32, 46, 38), 8, p.furLight);
    fillOval(ctx, rect(74, 40, 22, 22), withAlpha(p.ink, 0.12));
    let sweep: number;
    switch (s.mood) {
      case "tantrum":
        sweep = 1.05;
        break;
      case "happy":
      case "proud":
        sweep = -0.9;
        break;
      case "sleeping":
        sweep = 0.2;
        break;
      default:
        sweep = Math.sin(s.phase * 0.8) * 0.35;
    }
    ctx.strokeStyle = css(s.mood === "tantrum" ? ALARM : p.inner);
    line(
      ctx,
      point(85, 51),
      point(85 + Math.sin(sweep) * 9, 51 + Math.cos(sweep) * 9),
      2.2,
    );
    // Feet.
    fillRounded(ctx, rect(54, 12, 26, 12), 5, p.furDark);
    fillRounded(ctx, rect(90, 12, 26, 12), 5, p.furDark);
  }

  drawHead(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;
    fillRounded(ctx, this.headEllipse, 14, p.fur);
    // Screen face — the eyes are drawn onto this.
    fillRounded(ctx, rect(56, 100, 58, 38), 9, p.ink);
    // Side ear-cans.
    for (const x of [42, 122]) {
      fillRounded(ctx, rect(x, 108, 8, 20), 4, p.furDark);
    }
    // Bolt heads along the top edge.
    for (let i = 0; i < 3; i++) {
      fillOval(ctx, rect(70 + i * 15 - 2.5, 142, 5, 5), p.furDark);
    }
  }

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    // A little scrolling readout under the eyes, on the screen.
    const p = this.palette;
    const text = s.mood === "tantrum" ? ALARM : (p.iris ?? p.inner);
    const widths = [14, 9, 18, 7, 12];
    const shift = (s.phase * 6) % 34;

    ctx.save();
    // Clip to the readout window so the marquee scrolls off rather than
    // spilling across the screen bezel.
    roundedRectPath(ctx, rect(60, 102, 50, 9), 0);
    ctx.clip();
    for (let i = 0; i < 5; i++) {
      const x = 60 + i * 26 - shift;
      fillRounded(ctx, rect(x, 105, widths[i]!, 3), 1.5, withAlpha(text, 0.9));
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------

/**
 * Amelia — a little propeller plane, seen head-on. The propeller is the
 * animation: it idles, races when cross, and windmills to a stop when asleep.
 */
export class PlaneCompanion implements Companion {
  readonly id = "plane";
  readonly defaultName = "Amelia";
  readonly species = "Paper-route plane";
  readonly blurb = "Logs the hours. Never lands.";
  readonly group: CompanionGroup = "machines";
  /** In flight — no ground to cast onto. */
  readonly castsShadow = false;
  readonly drawsOwnFace = false;
  readonly isPreRendered = false;
  readonly drifts = false;

  readonly palette: CompanionPalette = {
    fur: hex(0xef9e5c),
    furDark: hex(0xc2724a),
    furLight: hex(0xfbf3e6),
    inner: hex(0x8fc7de),
    ink: hex(0x33261d),
    nose: hex(0xc2402c),
    blush: LOAF_BLUSH,
    iris: hex(0x4e7c94),
  };

  /** The cockpit glass, which is where the "head" is for hats and blush. */
  readonly headEllipse: Rect = rect(56, 86, 58, 52);
  readonly eyeLeft: Point = point(74, 112);
  readonly eyeRight: Point = point(96, 112);
  readonly eyeScale = 0.9;
  readonly hatAnchor: Point = point(85, 138);
  readonly neckY = 80;
  readonly handLeft: Point = point(46, 50);
  readonly handRight: Point = point(124, 50);
  get handFill(): Color {
    return this.palette.fur;
  }

  drawBehind(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;
    // Wings, swept slightly back so the head-on read is unmistakable. The Swift
    // mirrors the path with an affine transform; an x-flip helper is cheaper.
    ctx.fillStyle = css(p.fur);
    for (const flip of [false, true]) {
      const fx = (v: number): number => (flip ? 170 - v : v);
      ctx.beginPath();
      ctx.moveTo(fx(85), 56);
      ctx.lineTo(fx(14), 44);
      ctx.lineTo(fx(14), 34);
      ctx.lineTo(fx(85), 40);
      ctx.closePath();
      ctx.fill();
    }
    // Wing stripes.
    ctx.fillStyle = css(p.furDark);
    for (const x of [20, 138]) {
      ctx.beginPath();
      ctx.moveTo(x, 36);
      ctx.lineTo(x + 12, 36);
      ctx.lineTo(x + 12, 43);
      ctx.lineTo(x, 43);
      ctx.closePath();
      ctx.fill();
    }
    // Tail fin peeking above the fuselage.
    fillRounded(ctx, rect(80, 132, 10, 26), 4, p.furDark);
  }

  drawBody(ctx: Ctx2D, s: SceneState): void {
    const p = this.palette;
    // Fuselage.
    fillRounded(ctx, rect(60, 26, 50, 84), 25, p.fur);
    // Engine cowl.
    fillOval(ctx, rect(56, 22, 58, 34), p.furDark);
    fillOval(ctx, rect(66, 28, 38, 22), withAlpha(p.ink, 0.25));

    // Propeller. Speed carries the mood — this is the plane's tail-wag.
    let spin: number;
    switch (s.mood) {
      case "tantrum":
        spin = 26;
        break;
      case "sleeping":
        spin = 0.6;
        break;
      case "happy":
      case "proud":
        spin = 16;
        break;
      default:
        spin = 9;
    }
    const a = s.phase * spin;
    ctx.save();
    ctx.translate(85, 39);
    ctx.rotate(a);
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate((i * 120 * Math.PI) / 180);
      fillRounded(ctx, rect(-3.5, 0, 7, 36), 3.5, withAlpha(p.furLight, 0.9));
      ctx.restore();
    }
    ctx.restore();

    // Spinner hub over the blades.
    fillOval(ctx, rect(78, 32, 14, 14), p.nose);

    // Landing wheels tucked under.
    for (const x of [52, 108]) {
      fillOval(ctx, rect(x, 14, 12, 12), withAlpha(p.ink, 0.75));
    }
  }

  drawHead(ctx: Ctx2D, s: SceneState): void {
    void s;
    const p = this.palette;
    // Cockpit glass and its frame.
    fillRounded(ctx, insetBy(this.headEllipse, -4, -4), 22, p.furDark);
    fillRounded(ctx, this.headEllipse, 20, p.inner);
    // Glare streak, so it reads as glass rather than a painted panel.
    ctx.fillStyle = css(withAlpha(WHITE, 0.35));
    ctx.beginPath();
    ctx.moveTo(64, 118);
    ctx.lineTo(78, 134);
    ctx.lineTo(86, 134);
    ctx.lineTo(72, 118);
    ctx.closePath();
    ctx.fill();
  }

  drawMuzzle(ctx: Ctx2D, s: SceneState): void {
    // A smile stencilled on the nose cone, shark-mouth style.
    const p = this.palette;
    ctx.strokeStyle = css(withAlpha(p.ink, 0.7));
    ctx.beginPath();
    if (s.mood === "tantrum") {
      ctx.moveTo(72, 78);
      let i = 0;
      for (let x = 76; x <= 98 + 1e-9; x += 5.5) {
        ctx.lineTo(x, i % 2 === 0 ? 72 : 78);
        i++;
      }
    } else {
      ctx.moveTo(73, 80);
      ctx.bezierCurveTo(79, 70, 91, 70, 97, 80);
    }
    ctx.lineWidth = 2.0;
    ctx.lineCap = "round";
    ctx.stroke();
  }
}
