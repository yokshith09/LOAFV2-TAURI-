/**
 * Core contract for a desktop companion.
 *
 * Ported from `app-plus/Sources/LoafPlus/Companion.swift` in the Swift reference.
 * The architecture is deliberately unchanged: everything species-specific lives
 * behind the `Companion` interface, and the shared scene — moods, eyes, outfits,
 * the tab badge — is drawn against that interface's *anchors* and never learns
 * which animal it is looking at.
 *
 * COORDINATE SPACE — read this before touching any drawing code.
 * All art is authored in a fixed 170 x 190 design space with **y pointing up**
 * (AppKit convention, inherited from the Swift original so the ported bezier
 * numbers stay literally identical). Canvas 2D is y-down, so the renderer
 * installs a flip transform once; see `render/scene.ts`. Ground plane sits at
 * y = 13. The strip y 166..190 belongs to the floating tab badge — nothing else
 * may draw there.
 */

export const DESIGN_WIDTH = 170;
export const DESIGN_HEIGHT = 190;
/** Ground plane. Feet rest here. */
export const GROUND_Y = 13;
/** Bottom of the reserved tab-badge strip. Nothing but the badge draws above this. */
export const BADGE_STRIP_Y = 166;

/** What the companion is currently doing. */
export type Mood =
  | "idle"
  | "happy"
  | "sleeping"
  | "worried"
  /** You're scrolling, so he pulls out a scroll. (Yes, that's the joke.) */
  | "scrolling"
  /** Too many browser tabs open. He has opinions about it. */
  | "tantrum"
  /** You just closed enough tabs to calm him down. Credit where it's due. */
  | "proud";

export const ALL_MOODS: readonly Mood[] = [
  "idle",
  "happy",
  "sleeping",
  "worried",
  "scrolling",
  "tantrum",
  "proud",
] as const;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Rect in design space. `y` is the BOTTOM edge, because the space is y-up. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function point(x: number, y: number): Point {
  return { x, y };
}

export const rectMinX = (r: Rect): number => r.x;
export const rectMaxX = (r: Rect): number => r.x + r.width;
export const rectMinY = (r: Rect): number => r.y;
export const rectMaxY = (r: Rect): number => r.y + r.height;
export const rectMidX = (r: Rect): number => r.x + r.width / 2;
export const rectMidY = (r: Rect): number => r.y + r.height / 2;

/** Shrink (or grow, with negatives) a rect about its centre. */
export function insetBy(r: Rect, dx: number, dy: number): Rect {
  return {
    x: r.x + dx,
    y: r.y + dy,
    width: r.width - dx * 2,
    height: r.height - dy * 2,
  };
}

/** A colour. Channels are 0..255, alpha 0..1 — mirrors how the Swift side reads. */
export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface CompanionPalette {
  readonly fur: Color;
  readonly furDark: Color;
  readonly furLight: Color;
  /** Inner ear, bill, or whatever the species' warm accent is. */
  readonly inner: Color;
  readonly ink: Color;
  readonly nose: Color;
  readonly blush: Color;
  /**
   * Iris colour. When set, the eye gets a coloured ring around a dark pupil
   * instead of a flat dot — a black cat with gold eyes and a bengal with green
   * ones stop being the same animal in two coats.
   */
  readonly iris?: Color;
}

/** Everything the shared scene needs to know about the current frame. */
export interface SceneState {
  readonly mood: Mood;
  readonly phase: number;
  readonly blinking: boolean;
}

/** Which shelf of the closet a companion sits on. */
export type CompanionGroup = "cats" | "dogs" | "machines" | "elsewhere";

/**
 * The minimal 2D drawing surface the companions need.
 *
 * Deliberately a narrow structural subset of `CanvasRenderingContext2D` rather
 * than the real type: it lets the whole drawing layer be unit-tested in Node
 * against a recording stub, with no native canvas dependency and no browser.
 */
export interface Ctx2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "round" | "bevel" | "miter";
  globalAlpha: number;

  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  fill(): void;
  stroke(): void;
  /**
   * Confine subsequent drawing to the current path. Only the ghost uses it, to
   * shade one side of its sheet without adding a second colour to the
   * silhouette — the `NSGraphicsContext.saveGraphicsState` + `addClip` pair in
   * the Swift. Always pair with save/restore.
   */
  clip(): void;
  /**
   * Text support. Only the focus pill and the tab badge need it.
   *
   * BEWARE: the render context is flipped to y-up, so calling `fillText`
   * directly draws the glyphs upside down. Always go through `drawFlippedText`
   * in `render/text.ts`, which un-flips locally.
   */
  font: string;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };

  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  /**
   * Rotate by radians. Only the plane needs it, for its propeller — the one
   * moving part in the closet that genuinely spins rather than swaying.
   * Always pair with save/restore.
   */
  rotate(angle: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

/**
 * A desktop companion.
 *
 * A new character is one file plus a registry entry — never a new renderer.
 */
export interface Companion {
  /** Stable identifier, persisted in preferences. Never change one in place. */
  readonly id: string;
  /** The name this character ships with, before any user rename. */
  readonly defaultName: string;
  readonly species: string;
  /** One deadpan line for the closet card. */
  readonly blurb: string;
  readonly group: CompanionGroup;
  readonly palette: CompanionPalette;

  /** Companions that replace the whole scene (a plane, a hovering droid) opt out. */
  readonly castsShadow: boolean;
  /** True when the art already has a face and the shared eye system must not run. */
  readonly drawsOwnFace: boolean;
  /** True for finished artwork (a sprite pack) rather than beziers assembled here. */
  readonly isPreRendered: boolean;
  /** True for characters that move by nature rather than by user setting. */
  readonly drifts: boolean;

  // --- Anchors: where the shared scene attaches things ---

  /** The head's bounding box. Drives fur spikes, hats and blush placement. */
  readonly headEllipse: Rect;
  readonly eyeLeft: Point;
  readonly eyeRight: Point;
  /** Multiplier on the shared eye size, for beadier or wider faces. */
  readonly eyeScale: number;
  /** Where a hat sits — top of the skull, between the ears if there are ears. */
  readonly hatAnchor: Point;
  /** The y a scarf wraps around. */
  readonly neckY: number;
  /** Centres of the two paws/wings when holding the scroll. */
  readonly handLeft: Point;
  readonly handRight: Point;
  /** Fill for those paws. Defaults to body fur. */
  readonly handFill: Color;

  // --- Drawing, back to front ---

  /** Tail, wings — anything behind the body. */
  drawBehind(ctx: Ctx2D, s: SceneState): void;
  /** Body, legs, haunches. */
  drawBody(ctx: Ctx2D, s: SceneState): void;
  /** Head and ears. Eyes are drawn for you, right after this. */
  drawHead(ctx: Ctx2D, s: SceneState): void;
  /** Nose, mouth, whiskers, bill — the bit that makes it that animal. */
  drawMuzzle(ctx: Ctx2D, s: SceneState): void;
}

/**
 * Something the companion wears.
 *
 * Drawn after the face, in the same design space, positioned from the
 * companion's anchors (`hatAnchor`, `headEllipse`, `eyeLeft/Right`, `neckY`)
 * rather than from hardcoded coordinates — that is what lets one outfit fit
 * every species instead of needing a cat version and a duck version.
 */
export interface Outfit {
  /** Stable identifier, persisted in preferences. */
  readonly id: string;
  readonly name: string;
  /** Shown on the closet chip. */
  readonly glyph: string;
  /**
   * Months (1–12) this belongs to, for "dress for the season".
   * Empty means it is never auto-picked.
   */
  readonly months: ReadonlySet<number>;
  draw(ctx: Ctx2D, companion: Companion, s: SceneState): void;
}

/**
 * Blush sits under the outer corner of each eye, derived from the head box so
 * species don't each have to hand-place it.
 */
export function blushLeft(c: Companion): Rect {
  return rect(rectMinX(c.headEllipse) + 5, c.eyeLeft.y - 14, 15, 8);
}

export function blushRight(c: Companion): Rect {
  return rect(rectMaxX(c.headEllipse) - 20, c.eyeRight.y - 14, 15, 8);
}
