/**
 * Where the window is allowed to walk to, and the walk itself.
 *
 * Ported from `Wander` and `WanderController` in `CompanionBehaviour.swift`.
 *
 * The geometry half is PURE — no screen API, no window handle, no clock. Every
 * input that can put a window somewhere illegal (a second display, a taller
 * dock, a window bigger than the screen it is on) is a value passed in, which
 * is what lets a test hammer this with a few hundred silly screen layouts
 * instead of someone finding out on their desk.
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rect given by its origin and size, matching the window APIs on both OSes. */
export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenInfo {
  /** The whole display. */
  readonly frame: Frame;
  /** Minus the menu bar, dock or taskbar. */
  readonly visible: Frame;
}

const minX = (r: Frame): number => r.x;
const minY = (r: Frame): number => r.y;
const maxX = (r: Frame): number => r.x + r.width;
const maxY = (r: Frame): number => r.y + r.height;
const midX = (r: Frame): number => r.x + r.width / 2;
const midY = (r: Frame): number => r.y + r.height / 2;

function contains(r: Frame, p: Pt): boolean {
  return p.x >= minX(r) && p.x <= maxX(r) && p.y >= minY(r) && p.y <= maxY(r);
}

function intersectionArea(a: Frame, b: Frame): number {
  const w = Math.min(maxX(a), maxX(b)) - Math.max(minX(a), minX(b));
  const h = Math.min(maxY(a), maxY(b)) - Math.max(minY(a), minY(b));
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The rect of origins that keep the whole window inside `visible`.
 *
 * Collapses to zero width/height when the window is bigger than the screen it
 * is on. Clamping then pins it to the bottom-left of the visible frame:
 * something has to give, and a pet hanging off the top edge is a pet hidden
 * under the menu bar.
 */
export function legalOrigins(size: Size, visible: Frame): Frame {
  return {
    x: visible.x,
    y: visible.y,
    width: Math.max(0, visible.width - size.width),
    height: Math.max(0, visible.height - size.height),
  };
}

export function clampPoint(p: Pt, bounds: Frame): Pt {
  return {
    x: Math.min(Math.max(p.x, minX(bounds)), maxX(bounds)),
    y: Math.min(Math.max(p.y, minY(bounds)), maxY(bounds)),
  };
}

/**
 * The visible frame of the screen the window is actually on: the one holding
 * most of it, with the window's centre as the tie-break.
 *
 * Never "the main screen" — that is the one with keyboard focus, which on a
 * two-display desk is routinely not the one the pet is sitting on, and walking
 * a window into another display's coordinates is how you lose it.
 */
export function hostVisibleFrame(
  frame: Frame,
  screens: readonly ScreenInfo[],
): Frame | null {
  if (screens.length === 0) return null;

  // Whichever screen the middle of the window is on wins outright.
  const centre = { x: midX(frame), y: midY(frame) };
  const holding = screens.find((s) => contains(s.frame, centre));
  if (holding) return holding.visible;

  // Straddling two displays: the one holding most of him. Landing entirely in
  // the dead space between two displays, or on a screen that was just
  // unplugged, falls through to the first — whose visible frame the caller
  // clamps into, which is how he gets rescued rather than stranded.
  let best = screens[0]!;
  let bestArea = -1;
  for (const s of screens) {
    const area = intersectionArea(s.frame, frame);
    if (area > bestArea) {
      bestArea = area;
      best = s;
    }
  }
  return best.visible;
}

/** Injected randomness, so a few hundred layouts can be replayed exactly. */
export type Random = () => number;

/**
 * The next place the companion should stand, as a window origin.
 *
 * Guarantees, for any inputs:
 *  - the origin is inside the legal-origin box;
 *  - the whole window ends up inside `visible` whenever it fits at all — so
 *    never under the menu bar, never over the dock, never on another display;
 *  - the result is never further than `leash` from `home` (itself first pulled
 *    into range), so he stays in the neighbourhood the user put him in.
 */
export function nextOrigin(opts: {
  frame: Frame;
  home: Pt;
  visible: Frame;
  leash: number;
  goHome: boolean;
  rng: Random;
}): Pt {
  const { frame, home, visible, goHome, rng } = opts;
  const bounds = legalOrigins(frame, visible);
  // Home itself can be out of range — the display changed, or the dock grew —
  // so it is pulled in before anything is measured against it.
  const anchor = clampPoint(home, bounds);
  if (goHome) return anchor;

  const leash = Math.max(0, opts.leash);
  // A step, not a jitter: at least a third of the leash, so the caller is not
  // forever rejecting four-point twitches as not worth animating.
  const step = (span: number): number => {
    const m = (0.35 + 0.65 * rng()) * span;
    return rng() < 0.5 ? m : -m;
  };
  // Mostly sideways. He walks along the desk; something that drifts vertically
  // as freely as it does horizontally reads as floating, not walking.
  const dx = step(leash);
  const dy = step(leash * 0.38);
  let target: Pt = { x: frame.x + dx, y: frame.y + dy };

  const offX = target.x - anchor.x;
  const offY = target.y - anchor.y;
  const d = Math.hypot(offX, offY);
  if (d > leash && d > 0) {
    target = { x: anchor.x + (offX / d) * leash, y: anchor.y + (offY / d) * leash };
  }
  // Clamping into an axis-aligned box is a projection onto a convex set, so it
  // can only SHORTEN the distance to `anchor` — which is already inside the
  // box. That is why the leash survives the clamp, and the clamp is what keeps
  // him on this screen.
  return clampPoint(target, bounds);
}

/** Ease in and out; no sudden starts. */
export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * The window the walk moves. An interface rather than a Tauri type so the
 * controller is testable without a window, and so the same code drives the
 * preview harness.
 */
export interface MovableWindow {
  getFrame(): Frame;
  setOrigin(p: Pt): void;
  screens(): readonly ScreenInfo[];
}

/**
 * Moves the window, slowly, and never anywhere it should not be.
 *
 * The animation is hand-rolled on the existing frame tick rather than handed to
 * a platform animator, for one reason: it has to be abortable *this frame*. A
 * tantrum starting, or the user grabbing the window, has to stop the walk dead,
 * and an animation already in flight would keep sliding the window out from
 * under the drag.
 */
export class WanderController {
  /** Where the user actually put him. Every walk is measured against this. */
  private homeValue: Pt | null = null;
  private movingValue = false;

  private from: Pt = { x: 0, y: 0 };
  private to: Pt = { x: 0, y: 0 };
  private elapsed = 0;
  private duration = 1;
  /**
   * Forces a trip home after a couple of hops away, so he cannot ratchet
   * outward and settle in a far corner.
   */
  private hopsAway = 0;

  /**
   * Linear legs instead of eased ones. Easing in *and* out is right for a
   * walker taking a few steps, but drift runs the legs back to back — easing
   * every join turns continuous motion into a visible stop-start pulse.
   */
  linear = false;

  private readonly rng: Random;

  constructor(rng: Random = Math.random) {
    this.rng = rng;
  }

  get home(): Pt | null {
    return this.homeValue;
  }
  get isMoving(): boolean {
    return this.movingValue;
  }

  /** Call whenever the user finishes dragging: that is the new home. */
  noteUserPlaced(origin: Pt): void {
    this.homeValue = origin;
    this.hopsAway = 0;
  }

  abort(): void {
    this.movingValue = false;
  }

  /** Pick somewhere to go. Returns false if there is nowhere sensible. */
  begin(window: MovableWindow, leash: number, speed: number): boolean {
    const frame = window.getFrame();
    const visible = hostVisibleFrame(frame, window.screens());
    if (!visible) return false;
    if (this.homeValue === null) this.homeValue = { x: frame.x, y: frame.y };

    // Two hops out is enough of a stroll; the third is a walk back.
    const goHome = this.hopsAway >= 2 || this.rng() < 0.5;
    const target = nextOrigin({
      frame,
      home: this.homeValue,
      visible,
      leash,
      goHome,
      rng: this.rng,
    });

    const distance = Math.hypot(target.x - frame.x, target.y - frame.y);
    // Not worth the animation, and a two-point twitch looks like a rendering
    // bug. Drift accepts shorter legs: it runs them continuously, so a short
    // one is a gentle change of direction rather than a jerk.
    if (distance <= (this.linear ? 8 : 24)) return false;

    this.hopsAway = goHome ? 0 : this.hopsAway + 1;
    this.from = { x: frame.x, y: frame.y };
    this.to = target;
    this.elapsed = 0;
    this.duration = Math.min(9, Math.max(1.2, distance / Math.max(4, speed)));
    this.movingValue = true;
    return true;
  }

  /**
   * Advance the walk. Clamps every single frame against the screen the window
   * is *currently* on, so unplugging a display mid-stroll cannot strand it
   * off-screen.
   */
  step(dt: number, window: MovableWindow): void {
    if (!this.movingValue) return;
    this.elapsed += dt;
    const t = Math.min(1, this.elapsed / this.duration);
    const e = this.linear ? t : smoothstep(t);
    let p: Pt = {
      x: this.from.x + (this.to.x - this.from.x) * e,
      y: this.from.y + (this.to.y - this.from.y) * e,
    };
    const frame = window.getFrame();
    const visible = hostVisibleFrame(frame, window.screens());
    if (visible) {
      p = clampPoint(p, legalOrigins(frame, visible));
    }
    window.setOrigin(p);
    if (t >= 1) this.movingValue = false;
  }
}
