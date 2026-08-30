import { describe, it, expect } from "vitest";
import {
  ScrollEnergy,
  SCROLL_TRIGGER,
  SCROLL_CEILING,
  SCROLL_RECENT,
} from "../src/behaviour/scroll";

/** Run `seconds` of ticks at 60fps with a constant report from the platform. */
const run = (e: ScrollEnergy, secondsSince: number | null, seconds: number): void => {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.tick(secondsSince, dt);
};

describe("striking the scrolling pose", () => {
  it("does not strike it for a single stray notch", () => {
    // One accidental touch of a trackpad must not yank him into the pose. This
    // is the whole reason there is an energy model rather than a flag.
    const e = new ScrollEnergy();
    e.tick(0, 1 / 60);
    expect(e.isScrolling).toBe(false);
  });

  it("strikes it for a real scroll, quickly enough to feel connected", () => {
    const e = new ScrollEnergy();
    run(e, 0, 0.5);
    expect(e.isScrolling).toBe(true);
  });

  it("holds it briefly after you stop, rather than snapping back", () => {
    const e = new ScrollEnergy();
    run(e, 0, 1);
    run(e, 5, 0.1);
    expect(e.isScrolling).toBe(true);
  });

  it("lets go once you have properly stopped", () => {
    const e = new ScrollEnergy();
    run(e, 0, 1);
    run(e, 5, 2);
    expect(e.isScrolling).toBe(false);
    expect(e.energy).toBe(0);
  });

  it("caps the energy, so a long scroll does not take a long time to end", () => {
    const e = new ScrollEnergy();
    run(e, 0, 30);
    expect(e.energy).toBeLessThanOrEqual(SCROLL_CEILING);
    run(e, 5, 2);
    expect(e.isScrolling).toBe(false);
  });

  it("treats a scroll older than the window as no scroll", () => {
    const e = new ScrollEnergy();
    run(e, SCROLL_RECENT + 0.1, 1);
    expect(e.energy).toBe(0);
  });

  it("decays to nothing where the platform cannot answer", () => {
    // Loaf without a scroll pose is a small loss. Loaf stuck reading an
    // imaginary scroll is a bug.
    const e = new ScrollEnergy();
    run(e, 0, 1);
    expect(e.isScrolling).toBe(true);
    run(e, null, 2);
    expect(e.isScrolling).toBe(false);
  });

  it("ignores a frame that took no time", () => {
    const e = new ScrollEnergy();
    run(e, 0, 1);
    const before = e.energy;
    e.tick(0, 0);
    e.tick(0, -1);
    expect(e.energy).toBe(before);
  });

  it("never goes negative", () => {
    const e = new ScrollEnergy();
    run(e, 5, 5);
    expect(e.energy).toBe(0);
  });

  it("needs more than the trigger, not merely as much", () => {
    // The reference compares with `>`, so sitting exactly on the threshold is
    // not scrolling. Worth pinning: this is the boundary a refactor flips.
    const e = new ScrollEnergy();
    while (e.energy < SCROLL_TRIGGER) e.tick(0, 1 / 60);
    expect(e.energy).toBe(SCROLL_TRIGGER);
    expect(e.isScrolling).toBe(false);

    e.tick(0, 1 / 60);
    expect(e.isScrolling).toBe(true);
  });
});
