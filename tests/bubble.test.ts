import { describe, it, expect } from "vitest";
import { placeBubble, tailOffset, type Rect } from "../src/bubble/geometry";
import {
  speechBubbleHTML,
  BUBBLE_CSS,
  TEXT_WIDTH,
} from "../src/bubble/render";
import {
  PromptRotation,
  BREAK_PROMPTS,
  mayNudge,
  HOVER_DWELL_MS,
  BREAK_BUBBLE_SECONDS,
} from "../src/bubble/prompts";

/** A 1920x1080 screen at the origin. */
const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
/** The companion parked bottom-right, where it launches. */
const PARKED: Rect = { x: 1762, y: 858, width: 134, height: 150 };
const SIZE = { width: 236, height: 74 };

describe("placing the bubble", () => {
  it("sits above the companion by default", () => {
    // y-DOWN here: above means a SMALLER y. The reference is y-up and adds.
    const { origin, side } = placeBubble(PARKED, SIZE, SCREEN);
    expect(side).toBe("above");
    expect(origin.y).toBeLessThan(PARKED.y);
    expect(origin.y + SIZE.height).toBeLessThanOrEqual(PARKED.y);
  });

  it("centres on the companion when there is room", () => {
    const middle: Rect = { x: 800, y: 500, width: 134, height: 150 };
    const { origin } = placeBubble(middle, SIZE, SCREEN);
    expect(origin.x + SIZE.width / 2).toBeCloseTo(middle.x + middle.width / 2, 6);
  });

  it("stays on screen when the companion is against the right edge", () => {
    const { origin } = placeBubble(PARKED, SIZE, SCREEN);
    expect(origin.x + SIZE.width).toBeLessThanOrEqual(SCREEN.width);
  });

  it("stays on screen when the companion is against the left edge", () => {
    const left: Rect = { x: 0, y: 500, width: 134, height: 150 };
    const { origin } = placeBubble(left, SIZE, SCREEN);
    expect(origin.x).toBeGreaterThanOrEqual(SCREEN.x);
  });

  it("drops below when there is no room above", () => {
    // Clamping alone would push the bubble down over the character's face. A
    // Mac's menu bar keeps a window off the very top; Windows does not.
    const high: Rect = { x: 800, y: 4, width: 134, height: 150 };
    const { origin, side } = placeBubble(high, SIZE, SCREEN);
    expect(side).toBe("below");
    expect(origin.y).toBeGreaterThanOrEqual(high.y + high.height);
  });

  it("stays on screen when neither side fits", () => {
    // A very tall bubble on a very short screen. Rude beats unreadable.
    const tiny: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const tall = { width: 236, height: 300 };
    const { origin } = placeBubble({ x: 0, y: 40, width: 100, height: 60 }, tall, tiny);
    expect(origin.y).toBeGreaterThanOrEqual(tiny.y);
  });

  it("does not fly off the left when the bubble is wider than the screen", () => {
    // The clamp range inverts here, and Math.min/max in the wrong order lands
    // the bubble at a negative x.
    const narrow: Rect = { x: 0, y: 0, width: 200, height: 800 };
    const { origin } = placeBubble(
      { x: 20, y: 400, width: 134, height: 150 },
      { width: 400, height: 74 },
      narrow,
    );
    expect(origin.x).toBeGreaterThanOrEqual(narrow.x);
  });

  it("respects a monitor that does not start at the origin", () => {
    // A second screen to the right of the first. Treating positions as though
    // every monitor began at 0,0 puts the bubble on the wrong display.
    const second: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };
    const onSecond: Rect = { x: 2400, y: 500, width: 134, height: 150 };
    const { origin } = placeBubble(onSecond, SIZE, second);
    expect(origin.x).toBeGreaterThanOrEqual(second.x);
    expect(origin.x + SIZE.width).toBeLessThanOrEqual(second.x + second.width);
  });
});

describe("the tail", () => {
  it("points at the companion's centre", () => {
    const middle: Rect = { x: 800, y: 500, width: 134, height: 150 };
    const { origin } = placeBubble(middle, SIZE, SCREEN);
    const tail = tailOffset(middle, origin, SIZE);
    expect(origin.x + tail).toBeCloseTo(middle.x + middle.width / 2, 6);
  });

  it("keeps tracking the companion after the bubble stops at an edge", () => {
    // The bubble stops moving at the screen edge while the companion keeps
    // going, so a tail fixed at 50% drifts off the character.
    const { origin } = placeBubble(PARKED, SIZE, SCREEN);
    const tail = tailOffset(PARKED, origin, SIZE);
    expect(tail).not.toBeCloseTo(SIZE.width / 2, 1);
    expect(origin.x + tail).toBeCloseTo(PARKED.x + PARKED.width / 2, 6);
  });

  it("stays inside the rounded corners", () => {
    const farRight: Rect = { x: 1900, y: 500, width: 134, height: 150 };
    const tail = tailOffset(farRight, { x: 1676, y: 400 }, SIZE);
    expect(tail).toBeGreaterThanOrEqual(18);
    expect(tail).toBeLessThanOrEqual(SIZE.width - 18);
  });
});

describe("the speech bubble's markup", () => {
  it("escapes what it is told to say", () => {
    // Prompts are ours, but app names reach bubbles elsewhere in the reference
    // and this is the function they would go through.
    const html = speechBubbleHTML("<b>hi</b>", "above", 100);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("centres a single line and left-aligns several", () => {
    // Centred reads as a greeting; left-aligned reads as a list. A stats
    // readout centred line-by-line looks ragged rather than deliberate.
    expect(speechBubbleHTML("Hello", "above", 100)).toContain("centre");
    expect(speechBubbleHTML("Today\n1. Xcode", "above", 100)).not.toContain("centre");
  });

  it("hangs the tail from the side it was placed on", () => {
    expect(speechBubbleHTML("hi", "below", 100)).toContain('class="below"');
    expect(speechBubbleHTML("hi", "above", 100)).toContain('class="above"');
  });

  it("puts the tail where the geometry asked", () => {
    // Offset by half the tail box so the arrow's point, not its corner, lands
    // on the companion's centre.
    expect(speechBubbleHTML("hi", "above", 100)).toContain("left:94px");
  });

  it("styles both tail directions, so a bubble below is not tail-less", () => {
    expect(BUBBLE_CSS).toContain("#bubble.below .tail");
  });

  it("casts its own shadow, because the window has none", () => {
    // The window is transparent and shadowless; without this the card reads as
    // a sticker pasted on the wallpaper.
    expect(BUBBLE_CSS).toContain("box-shadow");
  });

  it("keeps a long line inside the text column", () => {
    const html = speechBubbleHTML("x".repeat(400), "above", 100);
    expect(html).toContain(`max-width:${TEXT_WIDTH + 28}px`);
  });
});

describe("what it says and when", () => {
  it("rotates the break prompts rather than picking at random", () => {
    // Random repeats: a four-item table draws the same line twice in a row
    // often enough to notice, and the second time reads as the app being stuck.
    const r = new PromptRotation(BREAK_PROMPTS);
    const drawn = BREAK_PROMPTS.map(() => r.next());
    expect(new Set(drawn).size).toBe(BREAK_PROMPTS.length);
  });

  it("wraps back to the start", () => {
    const r = new PromptRotation(BREAK_PROMPTS);
    for (const _ of BREAK_PROMPTS) r.next();
    expect(r.next()).toBe(BREAK_PROMPTS[0]);
  });

  it("refuses to be built with nothing to say", () => {
    expect(() => new PromptRotation([])).toThrow();
  });

  it("stands down during a focus session", () => {
    // Otherwise a 90-minute session collects five interruptions from the very
    // app you told to leave you alone.
    expect(mayNudge(true)).toBe(false);
    expect(mayNudge(false)).toBe(true);
  });

  it("waits long enough that crossing the pet is not a hover", () => {
    // The cursor crosses the companion on its way to everything in that corner
    // of the screen.
    expect(HOVER_DWELL_MS).toBeGreaterThanOrEqual(250);
  });

  it("leaves a nudge up long enough to read", () => {
    expect(BREAK_BUBBLE_SECONDS).toBeGreaterThanOrEqual(8);
  });
});
