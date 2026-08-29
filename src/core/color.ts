import type { Color } from "./types";

/**
 * Colour helpers.
 *
 * Ported from the `hex()` helper and `withAlphaComponent` calls scattered
 * through the Swift reference. Keeping alpha as a separate operation (rather
 * than baking it into every literal) preserves the original call sites
 * one-for-one, which makes the port auditable against the Swift.
 */

/** 0xRRGGBB -> Color, fully opaque. */
export function hex(v: number): Color {
  return {
    r: (v >> 16) & 0xff,
    g: (v >> 8) & 0xff,
    b: v & 0xff,
    a: 1,
  };
}

/** `NSColor.withAlphaComponent` equivalent. */
export function withAlpha(c: Color, a: number): Color {
  return { r: c.r, g: c.g, b: c.b, a };
}

export function rgba(r: number, g: number, b: number, a = 1): Color {
  return { r, g, b, a };
}

/**
 * `NSColor.blended(withFraction:of:)` equivalent: mix `fraction` of `other`
 * into `base`. The dog breeds lean on this for ear leather, which sits partway
 * between the coat and its shadow rather than being a colour of its own.
 */
export function blend(base: Color, fraction: number, other: Color): Color {
  const f = Math.max(0, Math.min(1, fraction));
  return {
    r: base.r * (1 - f) + other.r * f,
    g: base.g * (1 - f) + other.g * f,
    b: base.b * (1 - f) + other.b * f,
    a: base.a,
  };
}

export const BLACK: Color = rgba(0, 0, 0, 1);

/** Render a Color as a CSS string for canvas fill/stroke. */
export function css(c: Color): string {
  // Round channels so the output is stable and diffable in tests.
  const r = Math.round(c.r);
  const g = Math.round(c.g);
  const b = Math.round(c.b);
  if (c.a >= 1) return `rgb(${r}, ${g}, ${b})`;
  // Trim trailing zeros so `0.5` doesn't serialise as `0.500000001`.
  const a = Math.round(c.a * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const WHITE: Color = rgba(255, 255, 255, 1);

/** Loaf's house ink and blush, shared across every warm-coated character. */
export const LOAF_INK: Color = rgba(
  Math.round(0.29 * 255),
  Math.round(0.208 * 255),
  Math.round(0.153 * 255),
  1,
);

export const LOAF_BLUSH: Color = rgba(
  Math.round(0.957 * 255),
  Math.round(0.608 * 255),
  Math.round(0.627 * 255),
  0.65,
);
