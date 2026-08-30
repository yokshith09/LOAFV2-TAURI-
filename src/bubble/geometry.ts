/**
 * Where the bubble goes. Ported from the framing in `BubbleWindow.show` and
 * `HoverDashboardWindow.userContentController`.
 *
 * COORDINATES ARE Y-DOWN HERE. The reference works in AppKit's y-up screen
 * space, so its "above the companion" is `parent.frame.maxY + 2` — a larger y.
 * Tauri's `PhysicalPosition` is y-down on both platforms, so the same intent is
 * a *smaller* y, and every comparison against the screen edge flips with it.
 * Getting this backwards puts the bubble under the character's feet, which is
 * exactly the sort of thing that looks like a rendering bug rather than a
 * coordinate bug.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Kept clear of the screen edge, so the shadow is not clipped to a hard line. */
const EDGE_MARGIN = 8;
/** Between the bubble's tail and the top of the companion. */
const DEFAULT_GAP = 4;

export type BubbleSide = "above" | "below";

export interface Placement {
  readonly origin: Point;
  /**
   * Which side of the companion it ended up on. The page needs this to put the
   * tail on the correct edge — a bubble below the character with a tail on its
   * underside points at nothing.
   */
  readonly side: BubbleSide;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

/**
 * Centre the bubble over the companion and keep it on screen.
 *
 * Prefers to sit above. If there is no room — the companion is parked near the
 * top of the screen — it goes *below* rather than being pushed down over the
 * character's face, which is what clamping alone would do. That is a deviation
 * from the reference, which only clamps; the reference gets away with it
 * because a Mac's menu bar keeps a window off the very top edge, and Windows
 * has no such guarantee.
 */
export function placeBubble(
  companion: Rect,
  size: Size,
  workArea: Rect,
  gap: number = DEFAULT_GAP,
): Placement {
  const minX = workArea.x + EDGE_MARGIN;
  // max() guards the case where the bubble is wider than the screen: without it
  // the clamp range inverts and the bubble lands off the left edge.
  const maxX = Math.max(minX, workArea.x + workArea.width - size.width - EDGE_MARGIN);
  const x = clamp(companion.x + companion.width / 2 - size.width / 2, minX, maxX);

  const above = companion.y - size.height - gap;
  const below = companion.y + companion.height + gap;
  const top = workArea.y + EDGE_MARGIN;
  const bottom = workArea.y + workArea.height - size.height - EDGE_MARGIN;

  if (above >= top) return { origin: { x, y: above }, side: "above" };
  if (below <= bottom) return { origin: { x, y: below }, side: "below" };

  // Neither side fits — a very small screen, or a very tall bubble. Stay on
  // screen and accept the overlap; an unreadable bubble is worse than a rude one.
  return { origin: { x, y: clamp(above, top, Math.max(top, bottom)) }, side: "above" };
}

/**
 * Where the tail should sit along the bubble's own width, in pixels from its
 * left edge.
 *
 * The bubble is centred on the companion until it hits a screen edge, and after
 * that it stops moving while the companion keeps going — so a tail fixed at 50%
 * drifts off the character. This tracks the companion instead and stays inside
 * the rounded corners.
 */
export function tailOffset(
  companion: Rect,
  origin: Point,
  size: Size,
  cornerInset = 18,
): number {
  const centre = companion.x + companion.width / 2 - origin.x;
  return clamp(centre, cornerInset, Math.max(cornerInset, size.width - cornerInset));
}
