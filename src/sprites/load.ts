import { parsePack, type PackError } from "./manifest";
import { SpriteCompanion } from "./companion";
import type { Companion } from "../core/types";

/**
 * Turning what Rust read off disk into companions the closet can show.
 *
 * Every failure here is per-pack and silent to the app: a half-finished
 * character must not stop Loaf starting, and it must not cost the user the
 * packs that were fine. What it does get is a console line naming the folder
 * and the reason, because someone drawing a character needs to know why it did
 * not appear.
 */

export interface RawPack {
  readonly folder: string;
  readonly manifest: string;
  /** The sheet, already a data URI. */
  readonly sheet: string;
}

export interface LoadFailure {
  readonly folder: string;
  readonly reason: PackError | "bad-json" | "bad-image";
}

export interface LoadResult {
  readonly companions: Companion[];
  readonly failures: LoadFailure[];
}

/** Why a pack did not load, in words the person who drew it can act on. */
export const FAILURE_NOTES: Readonly<Record<LoadFailure["reason"], string>> = {
  "bad-json": "character.json isn't valid JSON",
  "not-an-object": "character.json isn't an object",
  "no-id": 'no "id" — every character needs one, and it must not change later',
  "no-name": 'no "name"',
  "no-sheet": 'no "sheet" section',
  "bad-grid":
    'the "sheet" section needs file, scale, frameWidth, frameHeight, columns and rows',
  "no-idle": 'no "idle" mood — a character needs something to show at rest',
  "bad-image": "the sheet image could not be decoded",
};

/**
 * Decode one sheet.
 *
 * Injected so the whole loader can be tested in Node, where there is no
 * `Image`. The real one resolves when the browser has the pixels.
 */
export type ImageLoader = (dataUri: string) => Promise<{ width: number; height: number }>;

export function browserImageLoader(): ImageLoader {
  return (dataUri) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not decode the sheet"));
      img.src = dataUri;
    });
}

export async function loadPacks(
  raw: readonly RawPack[],
  loadImage: ImageLoader,
): Promise<LoadResult> {
  const companions: Companion[] = [];
  const failures: LoadFailure[] = [];

  for (const entry of raw) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(entry.manifest);
    } catch {
      failures.push({ folder: entry.folder, reason: "bad-json" });
      continue;
    }

    const parsed = parsePack(manifest);
    if (!parsed.ok) {
      failures.push({ folder: entry.folder, reason: parsed.error });
      continue;
    }

    let sheet: { width: number; height: number };
    try {
      sheet = await loadImage(entry.sheet);
    } catch {
      failures.push({ folder: entry.folder, reason: "bad-image" });
      continue;
    }

    companions.push(new SpriteCompanion(parsed.pack, sheet));
  }

  return { companions, failures };
}

/**
 * Merge packs into the shipped list, letting a pack replace a built-in by id.
 *
 * Replacement rather than a duplicate: two characters with the same id would
 * make "which one is on duty" unanswerable, and someone who names their pack
 * after a shipped cat has almost certainly done it on purpose.
 */
export function mergeCompanions(
  builtIn: readonly Companion[],
  packs: readonly Companion[],
): Companion[] {
  const byId = new Map(builtIn.map((c) => [c.id, c]));
  for (const pack of packs) byId.set(pack.id, pack);
  return [...byId.values()];
}
