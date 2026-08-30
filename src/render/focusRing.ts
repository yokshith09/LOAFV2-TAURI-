import type { Ctx2D } from "../core/types";
import { rect } from "../core/types";
import { css, rgba, withAlpha } from "../core/color";
import { fillRounded, roundedRectPath } from "../core/draw";
import { drawFlippedText, measureFlippedText } from "./text";
import { formatClock } from "../focus/timer";

/**
 * The focus session, drawn on the companion. Ported from `drawFocusRing`,
 * `focusArc` and `drawFocusPill` in `CompanionView.swift`.
 */

/**
 * Concentric with the ground shadow, so it reads as something chalked on the
 * floor around his feet rather than a HUD pinned to the character. Wider than
 * the shadow by a clear margin, not a hair: the body hides the back of the
 * ellipse, and it is those extra points of half-width that push the left and
 * right tips clear of the widest haunches in the closet — otherwise a third of
 * every sweep is behind fur.
 */
const RING_CENTRE = { x: 85, y: 14.5 } as const;
const RING_RADII = { x: 58, y: 9.5 } as const;

const INK = rgba(51, 38, 29, 1);
const INK_SOFT = rgba(120, 108, 96, 1);
const AMBER = rgba(255, 178, 94, 1);
const AMBER_DEEP = rgba(214, 132, 46, 1);
const PAPER = rgba(255, 249, 242, 1);
const PAPER_EDGE = rgba(211, 189, 163, 1);

export interface FocusDisplay {
  readonly remaining: number;
  readonly paused: boolean;
  /** 0..1 elapsed. */
  readonly progress: number;
}

/**
 * Authored directly on the shadow's ellipse rather than as a unit circle under
 * a scaled context. Scaling the context by (58, 9.5) would pinch the stroke to
 * a hair down the sides; giving the ellipse primitive its own radii keeps the
 * weight even, which is the same point the Swift makes about transforming the
 * path instead of the context.
 *
 * It winds from six o'clock, not twelve, because six o'clock is the front of
 * the floor ellipse and twelve is behind his backside. Anchored at the top, the
 * first and last minutes of every session would drain where you cannot see them.
 */
function focusArc(ctx: Ctx2D, fraction: number): void {
  const start = -Math.PI / 2; // six o'clock in this y-up space
  const end = start - Math.PI * 2 * fraction;
  ctx.beginPath();
  ctx.ellipse(
    RING_CENTRE.x,
    RING_CENTRE.y,
    RING_RADII.x,
    RING_RADII.y,
    0,
    start,
    end,
    true,
  );
}

/**
 * Time draining out from under him: a full ellipse of spent track with the
 * *remaining* fraction inked in amber.
 *
 * Nothing here reads the animation phase. This is on screen for forty-five
 * minutes at a stretch — a pulse or a shimmer would be unbearable by minute
 * three, and the whole point of putting it on the character is that you can
 * ignore it.
 */
export function drawFocusRing(
  ctx: Ctx2D,
  f: FocusDisplay,
  pixelated = false,
): void {
  // The pixel pass rasterises at 56x63 with antialiasing off, about a third of
  // a grid pixel per design point — a hairline there lands under one pixel and
  // breaks into dashes, so the ring is drawn heavier for that grid.
  const weight = pixelated ? 5.5 : 3.0;

  focusArc(ctx, 1);
  ctx.lineWidth = weight;
  ctx.lineCap = "butt";
  ctx.strokeStyle = css(withAlpha(INK, 0.2));
  ctx.stroke();

  const left = 1 - Math.min(1, Math.max(0, f.progress));
  // Below this the arc is shorter than its own round cap, so it draws as a blob
  // that looks like a bug rather than the last few seconds.
  if (left <= 0.004) return;

  focusArc(ctx, left);
  ctx.lineWidth = weight;
  ctx.lineCap = "round";
  // Paused is dimmer, but not so dim it is mistaken for spent track — the arc
  // still has to say "this much is left", just quietly.
  ctx.strokeStyle = css(f.paused ? withAlpha(AMBER_DEEP, 0.62) : AMBER);
  ctx.stroke();
}

/**
 * The countdown, in the badge's slot. Paper-and-ink rather than another
 * coloured pill: it sits over whatever wallpaper you have, and a second
 * saturated capsule would compete with the tantrum's for the same headroom.
 */
export function drawFocusPill(ctx: Ctx2D, f: FocusDisplay): void {
  const text = formatClock(f.remaining);
  // Monospaced digits: with proportional ones the pill twitches a fraction of a
  // point every second, which is exactly the fidget this is meant to avoid.
  const font = "600 12px ui-monospace, 'JetBrains Mono', Menlo, monospace";
  const textWidth = measureFlippedText(ctx, text, font);

  const gap = f.paused ? 11 : 0; // room for the pause bars
  const width = textWidth + 22 + gap;
  const pill = rect(85 - width / 2, 168, width, 20);

  fillRounded(ctx, pill, 10, withAlpha(PAPER, 0.95));
  roundedRectPath(
    ctx,
    rect(pill.x + 0.75, pill.y + 0.75, pill.width - 1.5, pill.height - 1.5),
    10,
  );
  ctx.strokeStyle = css(f.paused ? PAPER_EDGE : AMBER_DEEP);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Two bars, because a dimmer pill alone reads as "low contrast", not
  // "stopped".
  if (f.paused) {
    ctx.fillStyle = css(INK_SOFT);
    for (const dx of [0, 4.5]) {
      const bx = pill.x + 9 + dx;
      const by = pill.y + 6;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + 2.2, by);
      ctx.lineTo(bx + 2.2, by + 8);
      ctx.lineTo(bx, by + 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawFlippedText(ctx, text, pill.x + 11 + gap, pill.y + 5.5, {
    font,
    colour: f.paused ? INK_SOFT : INK,
  });
}
