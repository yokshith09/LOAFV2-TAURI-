import type { CompanionPalette } from "../core/types";
import { hex, rgba, LOAF_INK, LOAF_BLUSH } from "../core/color";

/**
 * A cat's coat, and the handful of anatomy tweaks that come with a breed.
 *
 * Ported from `CatBreeds.swift`. Every cat in the closet is this struct plus one
 * shared drawing engine, not its own file. Six near-identical hand-drawn cats
 * would drift apart and all be mediocre; one engine means work spent on the
 * anatomy improves all of them, and a new breed is about eight lines of data.
 */
export interface CatCoat {
  readonly id: string;
  readonly defaultName: string;
  readonly breed: string;
  readonly blurb: string;
  readonly palette: CompanionPalette;

  /** Tabby banding: the forehead M, flank bars, tail rings. */
  readonly stripes: boolean;
  /** Bengal rosettes — scattered two-tone spots. */
  readonly rosettes: boolean;
  /** Calico's irregular colour patches over a pale base. */
  readonly patches: boolean;
  /** The pale chest bib. Off for solid-colour cats, which have none. */
  readonly bib: boolean;
  /** White paws and chest flash, the classic Indian street-cat markings. */
  readonly socks: boolean;
  /** Long-haired: adds a neck ruff and a plume tail. */
  readonly longHair: boolean;
  /** Persian's flat, wide face and short muzzle. */
  readonly flatFace: boolean;
  /** Ears run bigger on a desi cat, smaller on a persian. */
  readonly earScale: number;
}

/** Coat defaults, so each breed only states what makes it different. */
const BASE = {
  stripes: false,
  rosettes: false,
  patches: false,
  bib: true,
  socks: false,
  longHair: false,
  flatFace: false,
  earScale: 1.0,
} as const;

export const CAT_COATS: readonly CatCoat[] = [
  {
    ...BASE,
    id: "cat-ginger",
    defaultName: "Loaf",
    breed: "Ginger tabby",
    blurb: "The original. Counts everything, asks for nothing.",
    palette: {
      fur: hex(0xf6c177),
      furDark: hex(0xdd9a4e),
      furLight: hex(0xfee7c4),
      inner: hex(0xf2a2a2),
      ink: LOAF_INK,
      nose: hex(0xc97b63),
      blush: LOAF_BLUSH,
      iris: hex(0x6fa85c),
    },
    stripes: true,
  },
  {
    ...BASE,
    id: "cat-bengal",
    defaultName: "Croissant",
    breed: "Bengal",
    blurb: "Expensive-looking. Behaves like a raccoon.",
    palette: {
      fur: hex(0xd9a05b),
      furDark: hex(0x54401f),
      furLight: hex(0xf3dcb4),
      inner: hex(0xe3a9a0),
      ink: LOAF_INK,
      nose: hex(0xb86a55),
      blush: LOAF_BLUSH,
      iris: hex(0x5fa37a),
    },
    rosettes: true,
  },
  {
    ...BASE,
    id: "cat-indie",
    defaultName: "Pav",
    breed: "Indie",
    blurb: "Street-smart. Has survived worse than your inbox.",
    palette: {
      fur: hex(0xb9a184),
      furDark: hex(0x6e5c48),
      furLight: hex(0xfbf3e6),
      inner: hex(0xe0a9a4),
      ink: LOAF_INK,
      nose: hex(0xa9756a),
      blush: LOAF_BLUSH,
      iris: hex(0xc9a227),
    },
    stripes: true,
    socks: true,
    earScale: 1.16,
  },
  {
    ...BASE,
    id: "cat-black",
    defaultName: "Poppy",
    breed: "Black cat",
    blurb: "Bad luck for your tabs, specifically.",
    palette: {
      fur: hex(0x4a4453),
      furDark: hex(0x322d3b),
      furLight: hex(0x6a6275),
      inner: hex(0x8a6c78),
      ink: hex(0x1b1720),
      nose: hex(0x6e5a66),
      blush: rgba(
        Math.round(0.85 * 255),
        Math.round(0.5 * 255),
        Math.round(0.55 * 255),
        0.35,
      ),
      iris: hex(0xf2c14e),
    },
    bib: false,
  },
  {
    ...BASE,
    id: "cat-calico",
    defaultName: "Muffin",
    breed: "Calico",
    blurb: "Three colours, one opinion.",
    palette: {
      fur: hex(0xf7ede0),
      furDark: hex(0x4a4048),
      furLight: hex(0xfffbf4),
      inner: hex(0xf2a2a2),
      ink: LOAF_INK,
      nose: hex(0xd08c7a),
      blush: LOAF_BLUSH,
      iris: hex(0x7fa8c9),
    },
    patches: true,
  },
  {
    ...BASE,
    id: "cat-persian",
    defaultName: "Brioche",
    breed: "Persian",
    blurb: "Permanently unimpressed. Cannot be rushed.",
    palette: {
      fur: hex(0xeddcc6),
      furDark: hex(0xc9b49a),
      furLight: hex(0xfff8ed),
      inner: hex(0xe9afaf),
      ink: LOAF_INK,
      nose: hex(0xc98f82),
      blush: LOAF_BLUSH,
      iris: hex(0xd4762f),
    },
    bib: false,
    longHair: true,
    flatFace: true,
    earScale: 0.82,
  },
];

/** The ginger tabby the product is named after. Default and fallback. */
export const DEFAULT_CAT_ID = "cat-ginger";

export function findCoat(id: string): CatCoat {
  return CAT_COATS.find((c) => c.id === id) ?? CAT_COATS[0]!;
}
