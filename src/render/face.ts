import type { Color, Companion, Ctx2D, Point, SceneState } from "../core/types";
import { blushLeft, blushRight, point, rect, insetBy, rectMidX, rectMidY } from "../core/types";
import { css, withAlpha, WHITE } from "../core/color";
import { GAZE_TRAVEL, GAZE_SOCKET_DRIFT } from "../behaviour/gaze";
import { fillOval, line } from "../core/draw";

/**
 * The shared face: eyes for every species, placed from the companion's anchors.
 *
 * Ported from `drawEyes` / `drawClosedLids` / `drawFurSpikes` in
 * `CompanionView.swift`. The muzzle — the bit that makes it a cat or a duck —
 * is the companion's own business; this file never learns which animal it is
 * drawing, which is what lets one eye system serve every character.
 */

export function drawEyes(ctx: Ctx2D, c: Companion, s: SceneState): void {
  const p = c.palette;
  const k = c.eyeScale;
  const eyes: readonly Point[] = [c.eyeLeft, c.eyeRight];

  if (s.blinking) {
    drawClosedLids(ctx, eyes, k, p.ink);
    return;
  }

  switch (s.mood) {
    case "idle": {
      // The socket stays put and only what is inside it moves. An eye that
      // slid around the face would deform the head; a pupil that drifts inside
      // a fixed socket is what looking actually is.
      const gx = (s.gaze?.x ?? 0) * 4.5 * k * GAZE_TRAVEL;
      const gy = (s.gaze?.y ?? 0) * 6 * k * GAZE_TRAVEL;
      // The socket comes along for part of the ride. See GAZE_SOCKET_DRIFT:
      // the pupil alone was correct anatomy and an invisible effect at 134px.
      const sx = gx * GAZE_SOCKET_DRIFT;
      const sy = gy * GAZE_SOCKET_DRIFT;
      for (const e of eyes) {
        const socket = rect(e.x - 4.5 * k + sx, e.y - 6 * k + sy, 9 * k, 12 * k);
        if (p.iris) {
          // Coloured iris with a slit pupil down its middle. This is most of
          // what stops six coats of the same cat reading as one animal.
          fillOval(ctx, socket, p.iris);
          const pupil = rect(
            socket.x + gx,
            socket.y + gy,
            socket.width,
            socket.height,
          );
          fillOval(ctx, insetBy(pupil, pupil.width * 0.28, 0), p.ink);
        } else {
          fillOval(ctx, rect(socket.x + gx, socket.y + gy, socket.width, socket.height), p.ink);
        }
        // Catchlight. Travels with the pupil, because a highlight that stayed
        // still while the eye moved reads as a smudge on the screen.
        fillOval(
          ctx,
          rect(e.x - 0.5 * k + gx, e.y + 1.5 * k + gy, 3.4 * k, 3.4 * k),
          withAlpha(WHITE, 0.9),
        );
      }
      break;
    }

    case "happy":
    case "proud": {
      ctx.strokeStyle = css(p.ink);
      for (const e of eyes) {
        ctx.beginPath();
        ctx.moveTo(e.x - 6 * k, e.y - 2 * k);
        ctx.bezierCurveTo(
          e.x - 4 * k,
          e.y + 6 * k,
          e.x + 4 * k,
          e.y + 6 * k,
          e.x + 6 * k,
          e.y - 2 * k,
        );
        ctx.lineWidth = 2.6;
        ctx.lineCap = "round";
        ctx.stroke();
      }
      fillOval(ctx, blushLeft(c), p.blush);
      fillOval(ctx, blushRight(c), p.blush);
      break;
    }

    case "sleeping": {
      drawClosedLids(ctx, eyes, k, p.ink);
      break;
    }

    case "worried": {
      for (const e of eyes) {
        fillOval(ctx, rect(e.x - 3.5 * k, e.y - 4 * k, 7 * k, 8 * k), p.ink);
      }
      // Short brows slanting up toward the middle — worried, not cross.
      ctx.strokeStyle = css(p.ink);
      eyes.forEach((e, i) => {
        const dir = i === 0 ? 1 : -1;
        line(ctx, point(e.x - 7 * dir, e.y + 9), point(e.x + 5 * dir, e.y + 16), 2.2);
      });
      break;
    }

    case "typing": {
      // Sibling of `scrolling`, and the difference is where the eyes go. A
      // reader's eyes sweep sideways across a page; a typist's flick DOWN to
      // the keys and back up to the screen. Same absorbed face, different
      // errand, and the vertical beat is what tells them apart at 134px.
      const glance = Math.abs(Math.sin(s.phase * 4.6)) * 2.2;
      for (const e of eyes) {
        fillOval(
          ctx,
          rect(e.x - 4.4 * k, e.y - 7 * k + glance, 8.8 * k, 10.4 * k),
          p.ink,
        );
        fillOval(
          ctx,
          rect(e.x - 0.6 * k, e.y - 4.2 * k + glance, 3 * k, 3 * k),
          withAlpha(WHITE, 0.9),
        );
      }
      break;
    }

    case "working": {
      // Waiting, not working. He is not doing the job — your machine is — so
      // this is the face of someone watching a progress bar: eyes wide and
      // still, lifted slightly, blinking on the shared rhythm rather than
      // animating. Stillness is the read here; a busy face next to a busy
      // computer is two things competing for the same attention.
      const lift = 1.2 * k;
      for (const e of eyes) {
        const socket = rect(e.x - 4.8 * k, e.y - 5.4 * k - lift, 9.6 * k, 11.4 * k);
        if (p.iris) {
          fillOval(ctx, socket, p.iris);
          fillOval(ctx, insetBy(socket, socket.width * 0.3, 0), p.ink);
        } else {
          fillOval(ctx, socket, p.ink);
        }
        fillOval(
          ctx,
          rect(e.x - 1.1 * k, e.y + 1.2 * k - lift, 3.8 * k, 3.8 * k),
          withAlpha(WHITE, 0.92),
        );
      }
      break;
    }

    case "scrolling": {
      // Reading eyes: sitting low in the socket and tracking across the page.
      // Deliberately no lid line above them — a straight stroke there reads as
      // an eyebrow, which makes him look skeptical instead of absorbed.
      const track = Math.sin(s.phase * 3.4) * 1.4;
      for (const e of eyes) {
        fillOval(
          ctx,
          rect(e.x - 4.6 * k + track, e.y - 7 * k, 9.2 * k, 11 * k),
          p.ink,
        );
        fillOval(
          ctx,
          rect(e.x - 0.6 * k + track, e.y - 4 * k, 3.2 * k, 3.2 * k),
          withAlpha(WHITE, 0.9),
        );
      }
      break;
    }

    case "tantrum": {
      // One eye twitches on a beat of its own.
      const twitch = Math.sin(s.phase * 11) > 0.82;
      eyes.forEach((e, i) => {
        const squint = i === 0 && twitch ? 0.35 : 1.0;
        fillOval(
          ctx,
          rect(e.x - 5.4 * k, e.y - 6 * k * squint, 10.8 * k, 13 * k * squint),
          p.ink,
        );
        if (squint > 0.5) {
          fillOval(
            ctx,
            rect(e.x + 1 * k, e.y + 2 * k, 2.6 * k, 2.6 * k),
            withAlpha(WHITE, 0.9),
          );
        }
      });
      // Brows down toward the middle — the universal cross face.
      ctx.strokeStyle = css(p.ink);
      eyes.forEach((e, i) => {
        const dir = i === 0 ? 1 : -1;
        line(ctx, point(e.x - 11 * dir, e.y + 15), point(e.x + 8 * dir, e.y + 8), 3.0);
      });
      break;
    }
  }
}

export function drawClosedLids(
  ctx: Ctx2D,
  eyes: readonly Point[],
  k: number,
  ink: Color,
): void {
  ctx.strokeStyle = css(ink);
  for (const e of eyes) {
    ctx.beginPath();
    ctx.moveTo(e.x - 5.5 * k, e.y);
    ctx.bezierCurveTo(
      e.x - 3 * k,
      e.y - 4 * k,
      e.x + 3 * k,
      e.y - 4 * k,
      e.x + 5.5 * k,
      e.y,
    );
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

/**
 * Ruffled fur for the tab tantrum, pushed out along the top of whatever head
 * the current companion has.
 */
export function drawFurSpikes(ctx: Ctx2D, c: Companion, phase: number): void {
  const head = c.headEllipse;
  const cx = rectMidX(head);
  const cy = rectMidY(head);
  const rx = head.width / 2;
  const ry = head.height / 2;

  ctx.fillStyle = css(c.palette.fur);
  for (let i = 0; i < 13; i++) {
    const a = Math.PI * (-0.12 + (1.24 * i) / 12.0);
    const len = 5.5 + 4.0 * Math.abs(Math.sin(phase * 19 + i * 1.7));
    const tipX = cx + (rx + len) * Math.cos(a);
    const tipY = cy + (ry + len) * Math.sin(a);
    const b1x = cx + rx * Math.cos(a - 0.13);
    const b1y = cy + ry * Math.sin(a - 0.13);
    const b2x = cx + rx * Math.cos(a + 0.13);
    const b2y = cy + ry * Math.sin(a + 0.13);

    ctx.beginPath();
    ctx.moveTo(b1x, b1y);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(b2x, b2y);
    ctx.closePath();
    ctx.fill();
  }
}
