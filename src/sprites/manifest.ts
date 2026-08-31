import {
  DESIGN_HEIGHT,
  type CompanionGroup,
  type CompanionPalette,
  type Mood,
  type Point,
  type Rect,
} from "../core/types";
import { hex } from "../core/color";

/**
 * Hand-drawn characters, dropped in as a folder. Ported from `SpriteCompanion.swift`.
 *
 * Every other companion in the closet is bezier code, which is fine right up
 * until you want a real illustrator involved. This is the other door in: a PNG
 * sheet plus a `character.json` saying what is on it, and the character turns up
 * in the closet beside the ones we drew — same moods, same hats, same focus ring.
 *
 * This file is the validation gate. Almost everything in the manifest is
 * optional because its job is to survive whatever is actually in the folder;
 * the pack is where optionals become real values with real defaults. A pack
 * that cannot be made sense of is SKIPPED, never half-loaded: a character that
 * is wrong in a way nobody asked for is worse than one that did not appear.
 */

export interface SpriteClip {
  /** Real frame indices into the sheet, already bounds-checked. */
  readonly frames: readonly number[];
  readonly fps: number;
  readonly loops: boolean;
}

export interface SpriteSheet {
  readonly file: string;
  /** 2 for an @2x sheet, 3 for @3x, 1 for pixel art authored at unit size. */
  readonly scale: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly rows: number;
}

export interface SpritePack {
  readonly id: string;
  readonly name: string;
  readonly species: string;
  readonly blurb: string;
  readonly group: CompanionGroup;
  readonly sheet: SpriteSheet;
  readonly clips: Readonly<Record<Mood, SpriteClip>>;
  readonly headEllipse: Rect;
  readonly eyeLeft: Point;
  readonly eyeRight: Point;
  readonly eyeScale: number;
  readonly hatAnchor: Point;
  readonly neckY: number;
  readonly handLeft: Point;
  readonly handRight: Point;
  readonly palette: CompanionPalette;
  readonly drawsOwnFace: boolean;
  readonly castsShadow: boolean;
  readonly pixelArt: boolean;
}

export type PackError =
  | "not-an-object"
  | "no-id"
  | "no-name"
  | "no-sheet"
  | "bad-grid"
  | "no-idle";

export type PackResult =
  | { readonly ok: true; readonly pack: SpritePack }
  | { readonly ok: false; readonly error: PackError };

const GROUPS: readonly CompanionGroup[] = ["cats", "dogs", "machines", "elsewhere"];

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const str = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a point, flipping it if the manifest says it was measured downward.
 *
 * The design space is y-up like the rest of the drawing code; design tools are
 * y-down. Rather than make an illustrator subtract six numbers from 190 by hand
 * — silently, with a wrong hat as the only symptom — they say which way up they
 * measured and this does the arithmetic.
 */
function readPoint(v: unknown, topLeft: boolean, fallback: Point): Point {
  if (!isObject(v)) return fallback;
  const x = num(v.x, fallback.x);
  const rawY = num(v.y, topLeft ? DESIGN_HEIGHT - fallback.y : fallback.y);
  return { x, y: topLeft ? DESIGN_HEIGHT - rawY : rawY };
}

function readBox(v: unknown, topLeft: boolean, fallback: Rect): Rect {
  if (!isObject(v)) return fallback;
  const width = num(v.width, fallback.width);
  const height = num(v.height, fallback.height);
  const x = num(v.x, fallback.x);
  const rawY = num(v.y, topLeft ? DESIGN_HEIGHT - fallback.y - height : fallback.y);
  // A box measured from the top is anchored by its top edge, so flipping it has
  // to account for its own height as well.
  return { x, y: topLeft ? DESIGN_HEIGHT - rawY - height : rawY, width, height };
}

/**
 * Turn one declared clip into real frame indices.
 *
 * Anything referring to a frame the sheet does not have is dropped rather than
 * clamped: a clip pointing off the end of the sheet is a mistake in the pack,
 * and drawing the wrong frame silently is the least useful way to report it.
 */
function resolveClip(v: unknown, frameCount: number): SpriteClip | null {
  if (!isObject(v)) return null;

  let frames: number[];
  if (Array.isArray(v.frames) && v.frames.length > 0) {
    frames = v.frames.filter(
      (f): f is number => typeof f === "number" && Number.isInteger(f),
    );
  } else {
    const from = num(v.from, 0);
    const count = num(v.count, 0);
    if (count <= 0) return null;
    frames = Array.from({ length: Math.floor(count) }, (_, i) => Math.floor(from) + i);
  }

  frames = frames.filter((f) => f >= 0 && f < frameCount);
  if (frames.length === 0) return null;

  return {
    frames,
    // A clip with no frame rate is a still, not a fault.
    fps: Math.max(0.1, num(v.fps, 8)),
    loops: bool(v.loop, true),
  };
}

/**
 * Give every mood a clip, so the draw path has no fallback logic in it.
 *
 * `idle` is the only genuinely required one: a pack with nothing to show at rest
 * is not a character. The rest fall back to their nearest sensible neighbour
 * rather than to a blank stare — a pack that drew a tantrum but skipped `proud`
 * should look pleased with its happy face.
 */
const FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  happy: ["proud", "idle"],
  proud: ["happy", "idle"],
  worried: ["tantrum", "idle"],
  tantrum: ["worried", "idle"],
  scrolling: ["idle"],
  sleeping: ["idle"],
  // Both fall back to idle, which is what keeps every sprite pack written
  // before these existed working unchanged: a pack that never drew them gets
  // its idle, not a blank frame.
  typing: ["scrolling", "idle"],
  working: ["idle"],
};

const MOODS: readonly Mood[] = [
  "idle",
  "happy",
  "sleeping",
  "worried",
  "scrolling",
  "typing",
  "working",
  "tantrum",
  "proud",
];

function resolveClips(
  raw: unknown,
  frameCount: number,
): Record<Mood, SpriteClip> | null {
  const declared = new Map<string, SpriteClip>();
  if (isObject(raw)) {
    for (const [name, clip] of Object.entries(raw)) {
      const resolved = resolveClip(clip, frameCount);
      if (resolved) declared.set(name, resolved);
    }
  }
  const idle = declared.get("idle");
  if (!idle) return null;

  const out = {} as Record<Mood, SpriteClip>;
  for (const mood of MOODS) {
    const own = declared.get(mood);
    if (own) {
      out[mood] = own;
      continue;
    }
    const fallback = (FALLBACKS[mood] ?? [])
      .map((n) => declared.get(n))
      .find((c): c is SpriteClip => c !== undefined);
    out[mood] = fallback ?? idle;
  }
  return out;
}

/**
 * The pack's palette.
 *
 * These do NOT colour the artwork — the artwork colours itself. They tint the
 * *shared* pieces drawn around it: the tantrum fur spikes, the paws gripping the
 * scroll, the sleeping z's. A pack that declares none gets a neutral set, which
 * looks deliberate next to almost any art.
 */
function readPalette(v: unknown): CompanionPalette {
  const raw = isObject(v) ? v : {};
  const colour = (key: string, fallback: number) => {
    const written = raw[key];
    if (typeof written !== "string") return hex(fallback);
    const cleaned = written.trim().replace(/^#/, "");
    // Six digits or nothing. A three-digit shorthand or a stray "rgb(...)"
    // would parse to some other colour entirely, and a companion tinted a
    // colour nobody chose is harder to diagnose than one left at the default.
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return hex(fallback);
    return hex(parseInt(cleaned, 16));
  };
  return {
    fur: colour("fur", 0xd8c3a5),
    furDark: colour("furDark", 0xb09a7c),
    furLight: colour("furLight", 0xf0e4d2),
    inner: colour("accent", 0xe8b4a0),
    ink: colour("ink", 0x33261d),
    nose: colour("nose", 0x8a6a55),
    blush: colour("blush", 0xe9a7a0),
  };
}

/** Defaults roughly matching a cat, so a pack that declares no anchors still works. */
const DEFAULT_ANCHORS = {
  head: { x: 55, y: 96, width: 60, height: 52 } as Rect,
  eyeLeft: { x: 73, y: 122 } as Point,
  eyeRight: { x: 97, y: 122 } as Point,
  hat: { x: 85, y: 148 } as Point,
  neckY: 96,
  handLeft: { x: 66, y: 62 } as Point,
  handRight: { x: 104, y: 62 } as Point,
};

export function parsePack(raw: unknown): PackResult {
  if (!isObject(raw)) return { ok: false, error: "not-an-object" };

  const id = str(raw.id, "");
  if (!id) return { ok: false, error: "no-id" };
  const name = str(raw.name, "");
  if (!name) return { ok: false, error: "no-name" };

  const sheetRaw = raw.sheet;
  if (!isObject(sheetRaw)) return { ok: false, error: "no-sheet" };

  // All six are required and none has a default that could be quietly wrong:
  // the grid is what frames are cut with and the scale decides how big the
  // character stands. A sheet missing any of them is a pack nobody finished.
  const file = str(sheetRaw.file, "");
  const scale = num(sheetRaw.scale, 0);
  const frameWidth = num(sheetRaw.frameWidth, 0);
  const frameHeight = num(sheetRaw.frameHeight, 0);
  const columns = Math.floor(num(sheetRaw.columns, 0));
  const rows = Math.floor(num(sheetRaw.rows, 0));
  if (
    !file ||
    scale <= 0 ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    columns <= 0 ||
    rows <= 0
  ) {
    return { ok: false, error: "bad-grid" };
  }

  const clips = resolveClips(raw.moods, columns * rows);
  if (!clips) return { ok: false, error: "no-idle" };

  const anchors = isObject(raw.anchors) ? raw.anchors : {};
  const topLeft = str(anchors.origin, "bottom-left") === "top-left";
  const style = isObject(raw.style) ? raw.style : {};
  const group = GROUPS.includes(str(raw.group, "") as CompanionGroup)
    ? (str(raw.group, "elsewhere") as CompanionGroup)
    : "elsewhere";

  return {
    ok: true,
    pack: {
      id,
      name,
      species: str(raw.species, "Sprite pack"),
      blurb: str(raw.blurb, "Someone drew this one by hand."),
      group,
      sheet: { file, scale, frameWidth, frameHeight, columns, rows },
      clips,
      headEllipse: readBox(anchors.head, topLeft, DEFAULT_ANCHORS.head),
      eyeLeft: readPoint(anchors.eyeLeft, topLeft, DEFAULT_ANCHORS.eyeLeft),
      eyeRight: readPoint(anchors.eyeRight, topLeft, DEFAULT_ANCHORS.eyeRight),
      eyeScale: Math.max(0.1, num(style.eyeScale, 1)),
      hatAnchor: readPoint(anchors.hat, topLeft, DEFAULT_ANCHORS.hat),
      neckY: topLeft
        ? DESIGN_HEIGHT - num(anchors.neckY, DESIGN_HEIGHT - DEFAULT_ANCHORS.neckY)
        : num(anchors.neckY, DEFAULT_ANCHORS.neckY),
      handLeft: readPoint(anchors.handLeft, topLeft, DEFAULT_ANCHORS.handLeft),
      handRight: readPoint(anchors.handRight, topLeft, DEFAULT_ANCHORS.handRight),
      palette: readPalette(raw.palette),
      // A sprite pack draws its own face by default: the art already has one,
      // and the shared eye system drawing a second pair on top of it is the most
      // likely way for a pack to look broken on arrival.
      drawsOwnFace: bool(style.drawsOwnFace, true),
      castsShadow: bool(style.castsShadow, true),
      pixelArt: bool(style.pixelArt, false),
    },
  };
}

/** Which frame of a clip is showing, given how long it has been running. */
export function frameAt(clip: SpriteClip, elapsedSeconds: number): number {
  const n = clip.frames.length;
  // Clamped before flooring: `phase` accumulates from the moment the view was
  // created, and a very large number turns into nonsense rather than an index.
  const ticks = Math.floor(Math.min(Math.max(0, elapsedSeconds), 1e9) * clip.fps);
  const index = clip.loops ? ticks % n : Math.min(ticks, n - 1);
  return clip.frames[index]!;
}

/** Where a frame sits on the sheet, in sheet pixels. */
export function frameRect(sheet: SpriteSheet, index: number): Rect {
  const column = index % sheet.columns;
  const row = Math.floor(index / sheet.columns);
  return {
    x: column * sheet.frameWidth,
    y: row * sheet.frameHeight,
    width: sheet.frameWidth,
    height: sheet.frameHeight,
  };
}
