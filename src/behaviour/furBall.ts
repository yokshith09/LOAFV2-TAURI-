import type { Companion, Ctx2D } from "../core/types";
import { DESIGN_WIDTH, point, rect } from "../core/types";
import { css, rgba, withAlpha, BLACK, WHITE } from "../core/color";
import { fillOval, line, ovalPath } from "../core/draw";

/**
 * A ball of yarn with just enough physics to be worth batting.
 *
 * Ported from `FurBall` and `PlayArt` in `CompanionBehaviour.swift`.
 *
 * It lives in the 170x190 design space, which is also the window — so the walls
 * it bounces off are the window's own edges and the game can never wander out
 * of the frame it is drawn in.
 */
export class FurBall {
  static readonly radius = 12;
  /**
   * The contact plane, chosen to sit inside the ground shadow so the ball and
   * the feet look like they are on the same floor.
   */
  static readonly floor = 15;
  static get wallLeft(): number {
    return FurBall.radius + 3;
  }
  static get wallRight(): number {
    return DESIGN_WIDTH - FurBall.radius - 3;
  }

  x: number;
  y: number;
  vx: number;
  vy: number;
  /**
   * Winding rotation, radians. Driven by distance covered, not by time — a ball
   * that spins while sliding is a ball on ice.
   */
  spin = 0;
  /**
   * Off while the ball is rolling in or rolling out. A box with no door has no
   * way for the game to start or end.
   */
  walls: boolean;

  constructor(opts: {
    x: number;
    y?: number;
    vx?: number;
    vy?: number;
    walls?: boolean;
  }) {
    this.x = opts.x;
    this.y = opts.y ?? FurBall.floor + FurBall.radius;
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? 0;
    this.walls = opts.walls ?? true;
  }

  get resting(): boolean {
    return (
      this.y <= FurBall.floor + FurBall.radius + 0.75 &&
      Math.abs(this.vy) < 10 &&
      Math.abs(this.vx) < 7
    );
  }

  get gone(): boolean {
    return (
      this.x < -FurBall.radius * 3 || this.x > DESIGN_WIDTH + FurBall.radius * 3
    );
  }

  step(dt: number): void {
    this.vy -= 640 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const rest = FurBall.floor + FurBall.radius;
    if (this.y <= rest) {
      this.y = rest;
      // Below this a "bounce" is a buzz against the floor rather than a hop, so
      // it just settles and starts rolling.
      this.vy = Math.abs(this.vy) < 26 ? 0 : -this.vy * 0.42;
      this.vx *= Math.pow(0.3, dt); // rolling friction
    } else {
      this.vx *= Math.pow(0.88, dt); // air drag
    }

    if (this.walls) {
      if (this.x < FurBall.wallLeft) {
        this.x = FurBall.wallLeft;
        this.vx = Math.abs(this.vx) * 0.62;
      }
      if (this.x > FurBall.wallRight) {
        this.x = FurBall.wallRight;
        this.vx = -Math.abs(this.vx) * 0.62;
      }
    }
    if (Math.abs(this.vx) < 1.5 && this.y <= rest) this.vx = 0;
    this.spin -= (this.vx * dt) / FurBall.radius;
  }
}

/**
 * Plum. The one token that stays legible against every coat in the closet —
 * amber disappears into the ginger cat, and anything pale into the calico.
 */
const YARN = rgba(138, 80, 128, 1);
const YARN_LIGHT = rgba(179, 130, 170, 1);
const YARN_DARK = rgba(97, 53, 90, 1);

/** The ball, drawn in design space. */
export function drawBall(ctx: Ctx2D, b: FurBall): void {
  const r = FurBall.radius;
  const circle = rect(b.x - r, b.y - r, r * 2, r * 2);

  // Contact shadow, shrinking as the ball leaves the floor. Without it a bounce
  // reads as a sticker sliding around the window.
  const lift = Math.max(0, b.y - (FurBall.floor + r));
  const k = Math.max(0.3, 1 - lift / 55);
  fillOval(
    ctx,
    rect(b.x - r * 0.95 * k, FurBall.floor - 3.5, r * 1.9 * k, 6.5 * k),
    withAlpha(BLACK, 0.16 * k),
  );

  drawThread(ctx, b);

  fillOval(ctx, circle, YARN);

  // Windings, clipped to the ball.
  //
  // Drawn with the ellipse primitive's own radii rather than by scaling the
  // context. The Swift makes the same point about transformed paths: squashing
  // the context by 0.34 in x pinches the stroke to a hair down one side.
  ctx.save();
  ovalPath(ctx, circle);
  ctx.clip();
  ctx.strokeStyle = css(YARN_LIGHT);
  ctx.lineWidth = 2.0;
  [0.34, 0.64, 0.46].forEach((squash, i) => {
    ctx.beginPath();
    ctx.ellipse(
      b.x,
      b.y,
      r * 0.92 * squash,
      r * 0.92,
      b.spin + (i * Math.PI) / 3,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  });
  ctx.restore();

  ctx.strokeStyle = css(withAlpha(YARN_DARK, 0.55));
  ovalPath(ctx, rect(circle.x + 0.8, circle.y + 0.8, circle.width - 1.6, circle.height - 1.6));
  ctx.lineWidth = 1.4;
  ctx.stroke();

  fillOval(
    ctx,
    rect(b.x - r * 0.52, b.y + r * 0.24, r * 0.42, r * 0.34),
    withAlpha(WHITE, 0.32),
  );
}

/**
 * A loose end trailing behind the ball. It only exists while the ball is
 * moving, which is exactly when you need something to tell you it is yarn and
 * not a marble.
 */
function drawThread(ctx: Ctx2D, b: FurBall): void {
  const speed = Math.hypot(b.vx, b.vy);
  if (speed <= 14) return;

  const len = Math.min(34, 9 + speed * 0.11);
  const a = Math.atan2(-b.vy, -b.vx);
  const nx = -Math.sin(a);
  const ny = Math.cos(a);

  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const d = FurBall.radius * 0.55 + len * t;
    // The wobble grows along the thread, so it flicks rather than wags.
    const w = Math.sin(t * Math.PI * 2.2 + b.spin * 2) * 3.4 * t;
    const px = b.x + Math.cos(a) * d + nx * w;
    const py = b.y + Math.sin(a) * d + ny * w;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = css(withAlpha(YARN, 0.85));
  ctx.stroke();
}

/**
 * A foreleg reaching out of the body toward the ball, with the paw on the end.
 *
 * Deliberately the same paw the scroll pose grips with — same fill, same two
 * toe lines — so a character that already looks right holding something looks
 * right swatting something. Unlike the scroll, this is drawn *over the
 * character's own body*, where a plain fur-coloured limb on fur-coloured fur is
 * invisible. Hence the outline: it is what makes the reach exist at all.
 */
export function drawSwipe(
  ctx: Ctx2D,
  c: Companion,
  side: number,
  t: number,
  ball: FurBall,
): void {
  // Pre-drawn art is one flat image with no separable limbs. Painting a bezier
  // paw onto someone's sprite in a palette colour they did not choose looks
  // like a rendering fault; those characters lean and nudge instead.
  if (c.isPreRendered) return;

  // Out and back on one arc. It peaks at t = 0.5, which is also the frame the
  // ball is hit on, so contact happens at full extension.
  const reach = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
  const home = side < 0 ? c.handLeft : c.handRight;
  const shoulder = point(home.x, home.y + 11);
  const targetX = ball.x - side * FurBall.radius * 0.45;
  const targetY = ball.y + FurBall.radius * 0.5;
  const paw = point(
    home.x + (targetX - home.x) * reach,
    home.y + (targetY - home.y) * reach,
  );
  const edge = withAlpha(c.palette.furDark, 0.45);

  ctx.strokeStyle = css(edge);
  line(ctx, shoulder, paw, 15.6);
  ctx.strokeStyle = css(c.palette.fur);
  line(ctx, shoulder, paw, 13);

  const pad = rect(paw.x - 11, paw.y - 7.5, 22, 15);
  fillOval(ctx, pad, c.handFill);
  ctx.strokeStyle = css(edge);
  ovalPath(ctx, pad);
  ctx.lineWidth = 1.3;
  ctx.stroke();
  for (const dx of [-3, 3]) {
    line(ctx, point(paw.x + dx, paw.y - 6), point(paw.x + dx, paw.y), 1.3);
  }
}
