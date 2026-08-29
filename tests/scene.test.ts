import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import {
  computeFit,
  designToCanvas,
  drawCompanion,
  renderScene,
} from "../src/render/scene";
import { CatCompanion } from "../src/companions/catCompanion";
import { CAT_COATS } from "../src/companions/catBreeds";
import {
  ALL_MOODS,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  GROUND_Y,
  type SceneState,
} from "../src/core/types";

const state = (over: Partial<SceneState> = {}): SceneState => ({
  mood: "idle",
  phase: 0,
  blinking: false,
  ...over,
});

describe("computeFit", () => {
  it("uses scale 1 when the view matches the design space exactly", () => {
    const f = computeFit(DESIGN_WIDTH, DESIGN_HEIGHT);
    expect(f.scale).toBe(1);
    expect(f.tx).toBe(0);
    // Origin is pushed to the bottom of the drawn area.
    expect(f.ty).toBe(DESIGN_HEIGHT);
  });

  it("scales uniformly and never distorts aspect ratio", () => {
    // A very wide view must letterbox horizontally, not stretch.
    const f = computeFit(DESIGN_WIDTH * 4, DESIGN_HEIGHT);
    expect(f.scale).toBe(1);
    expect(f.tx).toBeCloseTo((DESIGN_WIDTH * 4 - DESIGN_WIDTH) / 2, 6);
  });

  it("is limited by the tighter axis", () => {
    // Tall and narrow: width is the constraint.
    const f = computeFit(85, 1000);
    expect(f.scale).toBeCloseTo(0.5, 6);
  });

  it("centres the drawn area in both axes", () => {
    const f = computeFit(340, 570); // scale limited by width -> 2
    expect(f.scale).toBe(2);
    const drawnH = DESIGN_HEIGHT * 2;
    expect(f.tx).toBe(0);
    expect(f.ty).toBeCloseTo((570 - drawnH) / 2 + drawnH, 6);
  });
});

describe("designToCanvas — the y-up to y-down flip", () => {
  const fit = computeFit(DESIGN_WIDTH, DESIGN_HEIGHT);

  it("puts the ground plane near the BOTTOM of the canvas", () => {
    const p = designToCanvas(fit, 85, GROUND_Y);
    expect(p.y).toBeCloseTo(DESIGN_HEIGHT - GROUND_Y, 6);
    expect(p.y).toBeGreaterThan(DESIGN_HEIGHT * 0.8);
  });

  it("puts the top of the design space at canvas y = 0", () => {
    const p = designToCanvas(fit, 85, DESIGN_HEIGHT);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it("inverts y — a higher design point draws higher on screen", () => {
    const low = designToCanvas(fit, 85, 20);
    const high = designToCanvas(fit, 85, 150);
    // "Higher up" in design space means a SMALLER canvas y.
    expect(high.y).toBeLessThan(low.y);
  });

  it("does not invert x", () => {
    const left = designToCanvas(fit, 10, 50);
    const right = designToCanvas(fit, 160, 50);
    expect(right.x).toBeGreaterThan(left.x);
  });

  it("scales offsets as well as positions", () => {
    const f2 = computeFit(DESIGN_WIDTH * 2, DESIGN_HEIGHT * 2);
    const a = designToCanvas(f2, 0, 0);
    const b = designToCanvas(f2, 10, 0);
    expect(b.x - a.x).toBeCloseTo(20, 6);
  });
});

describe("renderScene", () => {
  it("clears, saves, transforms and restores exactly once", () => {
    const ctx = new RecordingCtx();
    renderScene(ctx, new CatCompanion(), state(), 134, 150);
    const ops = ctx.ops();
    expect(ops[0]).toBe("clearRect");
    expect(ctx.count("save")).toBe(1);
    expect(ctx.count("restore")).toBe(1);
    expect(ops[ops.length - 1]).toBe("restore");
  });

  it("applies translate before scale so the flip lands correctly", () => {
    const ctx = new RecordingCtx();
    renderScene(ctx, new CatCompanion(), state(), DESIGN_WIDTH, DESIGN_HEIGHT);
    const t = ctx.calls.findIndex((c) => c.op === "translate");
    const s = ctx.calls.findIndex((c) => c.op === "scale");
    expect(t).toBeGreaterThan(-1);
    expect(s).toBeGreaterThan(t);
    // The scale must be negative on y — that IS the flip.
    expect(ctx.calls[s]!.args[1]).toBeLessThan(0);
    expect(ctx.calls[s]!.args[0]).toBeGreaterThan(0);
  });
});

describe("drawCompanion — layer order", () => {
  it("draws back to front: behind, body, head, face", () => {
    // We can't name the layers directly, but the first paint must come from
    // drawBehind (a stroke, the tail) and the last from drawMuzzle (whiskers).
    const ctx = new RecordingCtx();
    drawCompanion(ctx, new CatCompanion(), state());
    const paints = ctx.calls.filter((c) => c.op === "fill" || c.op === "stroke");
    expect(paints.length).toBeGreaterThan(10);
    expect(paints[0]!.op).toBe("stroke"); // the tail
    expect(paints[paints.length - 1]!.op).toBe("stroke"); // last whisker
  });

  it("adds exactly thirteen fur spikes in tantrum and none otherwise", () => {
    const calm = new RecordingCtx();
    drawCompanion(calm, new CatCompanion(), state({ mood: "idle" }));
    const cross = new RecordingCtx();
    drawCompanion(cross, new CatCompanion(), state({ mood: "tantrum" }));

    // Count closed subpaths rather than fills: the tantrum face also swaps the
    // irises for plain eyes, which REMOVES two fills and would otherwise mask
    // the thirteen spikes being added. Each spike is one closed triangle, and
    // nothing else differs in closePath count between the two moods.
    expect(cross.count("closePath") - calm.count("closePath")).toBe(13);
  });

  it("skips the shared eyes when the companion draws its own face", () => {
    const cat = new CatCompanion();
    const faked = Object.create(cat) as typeof cat & { drawsOwnFace: boolean };
    Object.defineProperty(faked, "drawsOwnFace", { value: true });

    const withEyes = new RecordingCtx();
    drawCompanion(withEyes, cat, state());
    const withoutEyes = new RecordingCtx();
    drawCompanion(withoutEyes, faked, state());

    expect(withoutEyes.calls.length).toBeLessThan(withEyes.calls.length);
  });
});

describe("design-space contract", () => {
  it("no coat intrudes on the badge strip in tantrum — the only mood it shows in", () => {
    // y 166..190 belongs to the floating tab badge. In the reference,
    // CompanionView.swift:113 forces the mood to `tantrum` whenever a tab alert
    // exists, so tantrum is the ONLY mood that can co-occur with the badge.
    // This is the assertion that actually protects badge legibility.
    for (const coat of CAT_COATS) {
      const ctx = new RecordingCtx();
      drawCompanion(ctx, new CatCompanion(coat), state({ mood: "tantrum", phase: 1.3 }));
      expect(
        ctx.bounds().maxY,
        `${coat.id} intruded on the badge strip while cross`,
      ).toBeLessThanOrEqual(166);
    }
  });

  it("documents the latent ear overshoot inherited from the Swift reference", () => {
    // KNOWN DEVIATION, ported faithfully rather than silently corrected.
    //
    // The scrolling pose leans the ears UP (lean = +3), while tantrum leans them
    // DOWN (lean = -6). For the tallest ears in the roster — the indie cat at
    // earScale 1.16 — the scrolling tip reaches y = 169.24, which is inside the
    // reserved badge strip:
    //     124 + (160 + 3 - 124) * 1.16 = 169.24
    //
    // It is currently unreachable: a badge forces tantrum, and tantrum pulls the
    // same ear down to 158.8. So this is latent, not a visible artefact. The test
    // pins the exact value so that if either the lean or the ear scale changes,
    // this stops being harmless and we find out immediately.
    const ctx = new RecordingCtx();
    drawCompanion(
      ctx,
      new CatCompanion(CAT_COATS.find((c) => c.id === "cat-indie")!),
      state({ mood: "scrolling" }),
    );
    expect(ctx.bounds().maxY).toBeCloseTo(169.24, 2);

    // The same ear while cross must stay clear, which is what makes it harmless.
    const cross = new RecordingCtx();
    drawCompanion(
      cross,
      new CatCompanion(CAT_COATS.find((c) => c.id === "cat-indie")!),
      state({ mood: "tantrum" }),
    );
    expect(cross.bounds().maxY).toBeLessThanOrEqual(166);
  });

  it("keeps every other coat clear of the badge strip in every mood", () => {
    for (const coat of CAT_COATS) {
      if (coat.id === "cat-indie") continue; // covered by the deviation test above
      for (const mood of ALL_MOODS) {
        const ctx = new RecordingCtx();
        drawCompanion(ctx, new CatCompanion(coat), state({ mood, phase: 1.3 }));
        expect(
          ctx.bounds().maxY,
          `${coat.id} / ${mood} drew above the badge strip`,
        ).toBeLessThanOrEqual(166);
      }
    }
  });

  it("no coat in any mood falls through the floor", () => {
    for (const coat of CAT_COATS) {
      for (const mood of ALL_MOODS) {
        const ctx = new RecordingCtx();
        drawCompanion(ctx, new CatCompanion(coat), state({ mood, phase: 0.7 }));
        // Paw ovals legitimately start at y=13; nothing should go below.
        expect(
          ctx.bounds().minY,
          `${coat.id} / ${mood} drew below the ground plane`,
        ).toBeGreaterThanOrEqual(GROUND_Y - 0.001);
      }
    }
  });

  it("never emits a non-finite coordinate across every coat, mood and phase", () => {
    for (const coat of CAT_COATS) {
      for (const mood of ALL_MOODS) {
        for (const phase of [0, 0.5, 1.7, 3.14159, 42.5, 1000]) {
          const ctx = new RecordingCtx();
          drawCompanion(ctx, new CatCompanion(coat), state({ mood, phase }));
          expect(
            ctx.hasNonFiniteArgs(),
            `${coat.id} / ${mood} / phase ${phase} produced NaN`,
          ).toBe(false);
        }
      }
    }
  });
});
