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
import { ALL_MOODS, GROUND_Y, type SceneState } from "../src/core/types";

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
      for (const mood of ALL_MOODS) {
        const ctx = new RecordingCtx();
        drawCompanion(ctx, c, state({ mood, phase: 0.7 }));
        expect(ctx.bounds().minY, `${c.id}/${mood}`).toBeGreaterThanOrEqual(
          GROUND_Y - 0.001,
        );
      }
    }
  });

  it("clears the tab-badge strip while cross, when the badge is showing", () => {
    for (const c of COMPANIONS) {
      const ctx = new RecordingCtx();
      drawCompanion(ctx, c, state({ mood: "tantrum", phase: 1.3 }));
      expect(ctx.bounds().maxY, `${c.id} intruded on the badge strip`).toBeLessThanOrEqual(
        166,
      );
    }
  });
});
