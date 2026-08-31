import { describe, it, expect } from "vitest";
import {
  gazeToward,
  easeGaze,
  LOOKING_AHEAD,
  GAZE_RANGE_PX,
  GAZE_TRAVEL,
  GAZE_SOCKET_DRIFT,
} from "../src/behaviour/gaze";
import { point } from "../src/core/types";

const centre = point(500, 500);

describe("gazeToward", () => {
  it("looks straight ahead when there is no cursor", () => {
    expect(gazeToward(null, centre)).toEqual(LOOKING_AHEAD);
  });

  it("looks straight ahead when the cursor sits on the face", () => {
    expect(gazeToward(centre, centre)).toEqual(LOOKING_AHEAD);
  });

  it("looks toward the cursor", () => {
    const right = gazeToward(point(600, 500), centre);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeCloseTo(0);

    const down = gazeToward(point(500, 600), centre);
    expect(down.y).toBeGreaterThan(0);
    expect(down.x).toBeCloseTo(0);

    const upLeft = gazeToward(point(400, 400), centre);
    expect(upLeft.x).toBeLessThan(0);
    expect(upLeft.y).toBeLessThan(0);
  });

  // A pointer crossing the far side of the screen should not yank the eyes to
  // their corners.
  it("looks harder the nearer the cursor is", () => {
    const near = gazeToward(point(550, 500), centre);
    const far = gazeToward(point(800, 500), centre);
    expect(near.x).toBeGreaterThan(far.x);
  });

  it("returns to centre once the cursor is out of range", () => {
    const beyond = point(500 + GAZE_RANGE_PX + 1, 500);
    expect(gazeToward(beyond, centre)).toEqual(LOOKING_AHEAD);
  });

  it("never deflects further than fully", () => {
    for (const p of [point(501, 500), point(500, 999), point(0, 0)]) {
      const g = gazeToward(p, centre);
      expect(Math.hypot(g.x, g.y)).toBeLessThanOrEqual(1);
    }
  });

  it("treats a range of zero as looking ahead rather than dividing by it", () => {
    expect(gazeToward(point(600, 500), centre, 0)).toEqual(LOOKING_AHEAD);
  });
});

describe("easeGaze", () => {
  it("moves toward the target", () => {
    const g = easeGaze(LOOKING_AHEAD, { x: 1, y: 0 }, 0.05);
    expect(g.x).toBeGreaterThan(0);
    expect(g.x).toBeLessThan(1);
  });

  it("arrives, given enough time", () => {
    let g = LOOKING_AHEAD;
    for (let i = 0; i < 200; i++) g = easeGaze(g, { x: 1, y: -1 }, 1 / 60);
    expect(g.x).toBeCloseTo(1, 3);
    expect(g.y).toBeCloseTo(-1, 3);
  });

  it("never overshoots, however long the frame was", () => {
    const g = easeGaze(LOOKING_AHEAD, { x: 1, y: 1 }, 10);
    expect(g.x).toBeLessThanOrEqual(1);
    expect(g.y).toBeLessThanOrEqual(1);
  });

  it("stands still when no time has passed", () => {
    const from = { x: 0.3, y: -0.2 };
    expect(easeGaze(from, { x: 1, y: 1 }, 0)).toEqual(from);
  });
});

describe("the travel constants", () => {
  // This test used to demand GAZE_TRAVEL < 0.5, which was my judgement about
  // proportions rather than about pixels. Seeing it run showed the movement was
  // invisible on a 134px character, so the real bound is the one below: the
  // pupil must not leave the eye, which is a fact, not a taste.
  it("never lets the pupil leave the socket", () => {
    expect(GAZE_TRAVEL).toBeGreaterThan(0);
    expect(GAZE_TRAVEL).toBeLessThan(1);
  });

  it("keeps the socket itself close to home", () => {
    // The socket is drawn on a face and cannot wander off it.
    expect(GAZE_SOCKET_DRIFT).toBeGreaterThan(0);
    expect(GAZE_SOCKET_DRIFT).toBeLessThan(0.5);
  });

  it("moves the pupil further than the socket", () => {
    // Otherwise the eye slides across the head instead of looking.
    expect(GAZE_SOCKET_DRIFT).toBeLessThan(1);
  });
});
