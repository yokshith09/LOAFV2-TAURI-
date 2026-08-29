import type { CompanionPalette } from "../core/types";
import { hex, LOAF_INK, LOAF_BLUSH } from "../core/color";

/**
 * A dog breed, as data.
 *
 * Ported from `DogBreeds.swift`. Same reasoning as `CatCoat`: what actually
 * separates a labrador from a bulldog is ear carriage, muzzle length, tail and
 * bulk — not four different drawings of a dog. Parameterising those four axes
 * gets genuinely distinct silhouettes out of one engine.
 *
 * The shiba stays in its own file: its curled tail is a swept tapered ribbon
 * with bespoke geometry that a shared `Tail` union would only flatten.
 */

export type DogEars = "drop" | "erect" | "rose";
export type DogMuzzle = "square" | "short" | "buried";
export type DogTail = "otter" | "plume" | "stub" | "brush";
export type DogBuild = "standard" | "stocky" | "small";

export interface DogBreed {
  readonly id: string;
  readonly defaultName: string;
  readonly breed: string;
  readonly blurb: string;
  readonly palette: CompanionPalette;

  readonly ears: DogEars;
  readonly muzzle: DogMuzzle;
  readonly tail: DogTail;
  readonly build: DogBuild;
  /** Husky's dark cap and pale brow spots. */
  readonly mask: boolean;
  /** Bulldog's hanging cheeks and underbite. */
  readonly jowls: boolean;
  /** Shih tzu's curtain of hair and topknot. */
  readonly longHair: boolean;
  /** Irregular white/dark patches (bulldog). */
  readonly patches: boolean;
  readonly bib: boolean;
  readonly socks: boolean;
}

const BASE = {
  ears: "drop",
  muzzle: "square",
  tail: "otter",
  build: "standard",
  mask: false,
  jowls: false,
  longHair: false,
  patches: false,
  bib: true,
  socks: false,
} as const;

export const DOG_BREEDS: readonly DogBreed[] = [
  {
    ...BASE,
    id: "dog-labrador",
    defaultName: "Ozzy",
    breed: "Labrador",
    blurb: "Delighted by everything. Including your 60 tabs.",
    palette: {
      fur: hex(0xe8c489),
      furDark: hex(0xc79e5f),
      furLight: hex(0xfbefd8),
      inner: hex(0xd79a92),
      ink: LOAF_INK,
      nose: hex(0x33261d),
      blush: LOAF_BLUSH,
      iris: hex(0x8a5a33),
    },
    ears: "drop",
    muzzle: "square",
    tail: "otter",
    build: "standard",
  },
  {
    ...BASE,
    id: "dog-shihtzu",
    defaultName: "Bun",
    breed: "Shih Tzu",
    blurb: "Mostly hair. Opinions somewhere inside.",
    palette: {
      fur: hex(0xd8b98c),
      furDark: hex(0xa98c63),
      furLight: hex(0xfbf4e8),
      inner: hex(0xe3a9a4),
      ink: LOAF_INK,
      nose: hex(0x33261d),
      blush: LOAF_BLUSH,
      iris: hex(0x5a4433),
    },
    ears: "drop",
    muzzle: "buried",
    tail: "plume",
    build: "small",
    longHair: true,
    socks: true,
  },
  {
    ...BASE,
    id: "dog-bulldog",
    defaultName: "Scone",
    breed: "Bulldog",
    blurb: "Built like a doorstop. Sighs a lot.",
    palette: {
      fur: hex(0xd9a46b),
      furDark: hex(0x9c6f40),
      furLight: hex(0xfbf2e4),
      inner: hex(0xd79a92),
      ink: LOAF_INK,
      nose: hex(0x33261d),
      blush: LOAF_BLUSH,
      iris: hex(0x6b4a2e),
    },
    ears: "rose",
    muzzle: "short",
    tail: "stub",
    build: "stocky",
    jowls: true,
    patches: true,
  },
  {
    ...BASE,
    id: "dog-husky",
    defaultName: "Bao",
    breed: "Husky",
    blurb: "Will argue. About everything. At length.",
    palette: {
      fur: hex(0x6e6a73),
      furDark: hex(0x3a363f),
      furLight: hex(0xfbf7f2),
      inner: hex(0xc99a98),
      ink: LOAF_INK,
      nose: hex(0x2a2530),
      blush: LOAF_BLUSH,
      iris: hex(0x6fb6d8),
    },
    ears: "erect",
    muzzle: "square",
    tail: "brush",
    build: "standard",
    mask: true,
    socks: true,
  },
];

export function findBreed(id: string): DogBreed {
  return DOG_BREEDS.find((b) => b.id === id) ?? DOG_BREEDS[0]!;
}
