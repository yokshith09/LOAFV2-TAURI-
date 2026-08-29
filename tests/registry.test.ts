import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import {
  COMPANIONS,
  DEFAULT_COMPANION_ID,
  findCompanion,
  grouped,
  GROUP_NOTES,
} from "../src/companions/registry";
import { drawCompanion } from "../src/render/scene";
import {
  ALL_MOODS,
  BADGE_STRIP_Y,
  GROUND_Y,
  type SceneState,
} from "../src/core/types";

const state = (over: Partial<SceneState> = {}): SceneState => ({
  mood: "idle",
  phase: 0,
  blinking: false,
  ...over,
});

/**
 * Contract tests that every companion must satisfy, whatever it is.
 *
 * This is the file that keeps "a new character is one file plus a registry
 * line" honest: anything added to the registry is held to the same rules as
 * everything already there, automatically.
 */
describe("the registry as a whole", () => {
  it("has no duplicate ids — they are persisted in preferences", () => {
    const ids = COMPANIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults to a companion that actually exists", () => {
    expect(COMPANIONS.some((c) => c.id === DEFAULT_COMPANION_ID)).toBe(true);
    expect(findCompanion(DEFAULT_COMPANION_ID).id).toBe(DEFAULT_COMPANION_ID);
  });

  it("falls back rather than throwing for an unknown id", () => {
    // An uninstalled pack or a renamed id must not be fatal on launch.
    expect(findCompanion("no-such-companion").id).toBe(COMPANIONS[0]!.id);
  });

  it("gives every companion the metadata the closet card needs", () => {
    for (const c of COMPANIONS) {
      expect(c.id.length, `${c.id}`).toBeGreaterThan(0);
      expect(c.defaultName.length, `${c.id}`).toBeGreaterThan(0);
      expect(c.species.length, `${c.id}`).toBeGreaterThan(0);
      expect(c.blurb.length, `${c.id}`).toBeGreaterThan(0);
    }
  });

  it("puts every companion on a shelf that has a note", () => {
    for (const c of COMPANIONS) {
      expect(GROUP_NOTES[c.group], `${c.id}`).toBeDefined();
    }
  });

  it("groups without losing anyone", () => {
    const total = grouped().reduce((n, g) => n + g.members.length, 0);
    expect(total).toBe(COMPANIONS.length);
  });

  it("skips shelves that are still empty", () => {
    // machines is not ported yet; it must not show as an empty shelf.
    for (const g of grouped()) {
      expect(g.members.length).toBeGreaterThan(0);
    }
  });
});

describe("every companion honours the shared contract", () => {
  it("places both eyes inside its own head box", () => {
    for (const c of COMPANIONS) {
      const h = c.headEllipse;
      for (const eye of [c.eyeLeft, c.eyeRight]) {
        expect(eye.x, `${c.id}`).toBeGreaterThan(h.x);
        expect(eye.x, `${c.id}`).toBeLessThan(h.x + h.width);
        expect(eye.y, `${c.id}`).toBeGreaterThan(h.y);
        expect(eye.y, `${c.id}`).toBeLessThan(h.y + h.height);
      }
    }
  });

  it("keeps eyes level and centred, so shared outfits line up", () => {
    for (const c of COMPANIONS) {
      expect(c.eyeLeft.y, `${c.id}`).toBe(c.eyeRight.y);
      expect((c.eyeLeft.x + c.eyeRight.x) / 2, `${c.id}`).toBeCloseTo(85, 0);
    }
  });

  it("puts the hat anchor above the eyes", () => {
    for (const c of COMPANIONS) {
      expect(c.hatAnchor.y, `${c.id}`).toBeGreaterThan(c.eyeLeft.y);
    }
  });

  it("uses a sane eye scale", () => {
    for (const c of COMPANIONS) {
      expect(c.eyeScale, `${c.id}`).toBeGreaterThan(0.5);
      expect(c.eyeScale, `${c.id}`).toBeLessThan(2);
    }
  });

  it("renders in every mood without throwing or emitting NaN", () => {
    for (const c of COMPANIONS) {
      for (const mood of ALL_MOODS) {
        const ctx = new RecordingCtx();
        expect(
          () => drawCompanion(ctx, c, state({ mood, phase: 2.2 })),
          `${c.id}/${mood}`,
        ).not.toThrow();
        expect(ctx.hasNonFiniteArgs(), `${c.id}/${mood}`).toBe(false);
      }
    }
  });

  it("actually paints something in every mood", () => {
    // A companion that silently draws nothing would pass every other test here.
    for (const c of COMPANIONS) {
      for (const mood of ALL_MOODS) {
        const ctx = new RecordingCtx();
        drawCompanion(ctx, c, state({ mood }));
        expect(
          ctx.count("fill") + ctx.count("stroke"),
          `${c.id}/${mood} painted nothing`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("balances save and restore, so clipping cannot leak between characters", () => {
    // The ghost clips to shade its sheet. An unbalanced restore there would
    // silently clip whatever is drawn next.
    for (const c of COMPANIONS) {
      const ctx = new RecordingCtx();
      drawCompanion(ctx, c, state());
      expect(ctx.count("save"), `${c.id}`).toBe(ctx.count("restore"));
    }
  });

  it("keeps a floating companion off the ground plane rule", () => {
    // Characters that opt out of the shadow are hovering; the floor contract
    // applies to the ones standing on it.
    for (const c of COMPANIONS) {
      if (!c.castsShadow) continue;
      // The robot's feet sit at y=12, one point under the plane, in the Swift
      // original. Left alone: a single point of overlap with the floor reads as
      // contact rather than as a mistake, and unlike the badge-strip cases
      // nothing is competing for that space.
      if (c.id === "robot") continue;
      for (const mood of ALL_MOODS) {
        const ctx = new RecordingCtx();
        drawCompanion(ctx, c, state({ mood, phase: 0.7 }));
        expect(ctx.bounds().minY, `${c.id}/${mood}`).toBeGreaterThanOrEqual(
          GROUND_Y - 0.001,
        );
      }
    }
  });

  it("clears the tab-badge strip — every companion, every mood", () => {
    // No exemptions. All five overshoots inherited from the Swift reference
    // have been fixed, so this is now a plain contract rather than a contract
    // with a footnote.
    for (const c of COMPANIONS) {
      for (const mood of ALL_MOODS) {
        for (const phase of [0, 0.7, 1.3, 2.9, 11.4]) {
          const ctx = new RecordingCtx();
          drawCompanion(ctx, c, state({ mood, phase }));
          expect(
            ctx.bounds().maxY,
            `${c.id} / ${mood} / phase ${phase} intruded on the badge strip`,
          ).toBeLessThanOrEqual(BADGE_STRIP_Y);
        }
      }
    }
  });
});

/**
 * Regression cover for the five badge-strip overshoots inherited from the Swift
 * reference and since fixed.
 *
 * Each was fixed differently, according to what the shape was doing:
 *
 * - The cat and dog ears are CLAMPED. Their overshoot came from the scrolling
 *   pose leaning the ears upward, so capping the height preserves the lean's
 *   sideways gesture — the ear still tips forward, it just stops growing.
 * - The droid's antenna, the robot's aerials and the fairy's horns are
 *   SHORTENED. Theirs were structural rather than pose-driven; a clamp would
 *   have flattened the tip into a chord.
 *
 * These tests assert the fix from the direction the bug came from, so a future
 * change to any of the underlying numbers is caught here specifically rather
 * than only by the blanket contract test above.
 */
describe("badge-strip overshoots, fixed", () => {
  it("cat: the tallest ears clear the strip while scrolling", () => {
    // Was y=169.24 for cat-indie (earScale 1.16).
    const ctx = new RecordingCtx();
    drawCompanion(ctx, findCompanion("cat-indie"), state({ mood: "scrolling" }));
    expect(ctx.bounds().maxY).toBeLessThanOrEqual(BADGE_STRIP_Y);
  });

  it("cat: clamping the height did not flatten the lean", () => {
    // The point of clamping rather than reducing the lean: the scrolling pose
    // must still look different from the idle one.
    const scrolling = new RecordingCtx();
    drawCompanion(scrolling, findCompanion("cat-indie"), state({ mood: "scrolling" }));
    const idle = new RecordingCtx();
    drawCompanion(idle, findCompanion("cat-indie"), state({ mood: "idle" }));
    expect(scrolling.signature()).not.toBe(idle.signature());
  });

  it("dog: the husky's erect ears clear the strip while scrolling", () => {
    // Was y=170.
    const ctx = new RecordingCtx();
    drawCompanion(ctx, findCompanion("dog-husky"), state({ mood: "scrolling" }));
    expect(ctx.bounds().maxY).toBeLessThanOrEqual(BADGE_STRIP_Y);
  });

  it("droid: the antenna tip clears the strip in every mood", () => {
    // Was y=172 always — the badge would have covered the blinking light in
    // exactly the mood the droid uses it to get your attention.
    for (const mood of ALL_MOODS) {
      const ctx = new RecordingCtx();
      drawCompanion(ctx, findCompanion("droid"), state({ mood }));
      expect(ctx.bounds().maxY, mood).toBeLessThanOrEqual(BADGE_STRIP_Y);
    }
  });

  it("robot: the aerials clear the strip in every mood, including cross", () => {
    // Was y=174 at rest and y=180 when cross — the deepest intrusion of any
    // character, and worst in the mood the badge appears in.
    for (const mood of ALL_MOODS) {
      const ctx = new RecordingCtx();
      drawCompanion(ctx, findCompanion("robot"), state({ mood }));
      expect(ctx.bounds().maxY, mood).toBeLessThanOrEqual(BADGE_STRIP_Y);
    }
  });

  it("fairy: the demon horns clear the strip", () => {
    // Was y=178, and uniquely bad because the horns exist ONLY in the tantrum
    // pose — the same pose that summons the badge.
    const ctx = new RecordingCtx();
    drawCompanion(ctx, findCompanion("fairy"), state({ mood: "tantrum" }));
    expect(ctx.bounds().maxY).toBeLessThanOrEqual(BADGE_STRIP_Y);
  });

  it("fairy: shortening the horns did not remove them", () => {
    // Squashed toward the base, not truncated — she must still visibly grow
    // horns when she turns.
    const cross = new RecordingCtx();
    drawCompanion(cross, findCompanion("fairy"), state({ mood: "tantrum" }));
    const calm = new RecordingCtx();
    drawCompanion(calm, findCompanion("fairy"), state({ mood: "idle" }));
    expect(cross.bounds().maxY).toBeGreaterThan(calm.bounds().maxY);
  });

  it("robot: feet still rest a point under the plane, which is left alone", () => {
    // Not a badge-strip case. A single point of overlap with the floor reads as
    // contact, and nothing competes for that space.
    const ctx = new RecordingCtx();
    drawCompanion(ctx, findCompanion("robot"), state());
    expect(ctx.bounds().minY).toBeCloseTo(12, 2);
    expect(GROUND_Y).toBe(13);
  });
});
