import { describe, it, expect } from "vitest";
import { hex, withAlpha, css, rgba, LOAF_INK } from "../src/core/color";

describe("hex", () => {
  it("decodes 0xRRGGBB into channels", () => {
    expect(hex(0xf6c177)).toEqual({ r: 0xf6, g: 0xc1, b: 0x77, a: 1 });
  });

  it("handles black and white ends without sign errors", () => {
    expect(hex(0x000000)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(hex(0xffffff)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("does not let the red channel bleed into green", () => {
    // 0xFF0000 must not produce g=255 — a shift/mask mistake would.
    expect(hex(0xff0000)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
});

describe("withAlpha", () => {
  it("changes only alpha and does not mutate the source", () => {
    const base = hex(0x4a3527);
    const faded = withAlpha(base, 0.4);
    expect(faded).toEqual({ r: 0x4a, g: 0x35, b: 0x27, a: 0.4 });
    expect(base.a).toBe(1);
  });
});

describe("css", () => {
  it("emits rgb() when fully opaque", () => {
    expect(css(hex(0xf6c177))).toBe("rgb(246, 193, 119)");
  });

  it("emits rgba() when translucent", () => {
    expect(css(withAlpha(hex(0xf6c177), 0.5))).toBe("rgba(246, 193, 119, 0.5)");
  });

  it("rounds fractional channels so output is stable", () => {
    expect(css(rgba(0.4, 0.6, 1.5, 1))).toBe("rgb(0, 1, 2)");
  });

  it("does not emit long floating point tails in alpha", () => {
    const out = css(withAlpha(hex(0x000000), 1 / 3));
    expect(out).toBe("rgba(0, 0, 0, 0.333)");
    expect(out).not.toMatch(/\d{5,}/);
  });
});

describe("LOAF_INK", () => {
  it("matches the Swift reference #4A3527 after rounding", () => {
    // Swift stores it as 0.290/0.208/0.153 floats; rounding must land on 4A3527.
    expect(css(LOAF_INK)).toBe("rgb(74, 53, 39)");
  });
});
