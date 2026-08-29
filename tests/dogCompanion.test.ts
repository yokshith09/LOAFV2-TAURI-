import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { DogCompanion } from "../src/companions/dogCompanion";
import { DOG_BREEDS, findBreed } from "../src/companions/dogBreeds";
import { drawCompanion } from "../src/render/scene";
import {
  ALL_MOODS,
  GROUND_Y,
  rectMaxX,
  rectMinX,
  type SceneState,
} from "../src/core/types";

const state = (over: Partial<SceneState> = {}): SceneState => ({
  mood: "idle",
  phase: 0,
  blinking: false,
  ...over,
});

const render = (id: string, over: Partial<SceneState> = {}): RecordingCtx => {
  const ctx = new RecordingCtx();
  drawCompanion(ctx, new DogCompanion(findBreed(id)), state(over));
  return ctx;
};

describe("breed registry", () => {
  it("ships the four breeds from the Swift reference", () => {
    expect(DOG_BREEDS.map((b) => b.id)).toEqual([
      "dog-labrador",
      "dog-shihtzu",
      "dog-bulldog",
      "dog-husky",
    ]);
  });

  it("has no duplicate ids", () => {
    expect(new Set(DOG_BREEDS.map((b) => b.id)).size).toBe(DOG_BREEDS.length);
  });

  it("falls back rather than throwing on an unknown id", () => {
    expect(findBreed("dog-nope").id).toBe("dog-labrador");
    expect(DogCompanion.byId("nonsense").id).toBe("dog-labrador");
  });

  it("gives every breed a distinct combination of the four shape axes", () => {
    // The whole premise is that ears/muzzle/tail/build produce different
    // silhouettes. Two breeds sharing all four would be the same dog twice.
    const shapes = DOG_BREEDS.map((b) =>
      [b.ears, b.muzzle, b.tail, b.build].join("/"),
    );
    expect(new Set(shapes).size).toBe(DOG_BREEDS.length);
  });

  it("reports itself on the dogs shelf", () => {
    for (const b of DOG_BREEDS) {
      expect(new DogCompanion(b).group).toBe("dogs");
    }
  });
});

describe("anchors", () => {
  it("places both eyes inside the head box for every breed", () => {
    for (const b of DOG_BREEDS) {
      const d = new DogCompanion(b);
      const h = d.headEllipse;
      for (const eye of [d.eyeLeft, d.eyeRight]) {
        expect(eye.x, `${b.id}`).toBeGreaterThan(rectMinX(h));
        expect(eye.x, `${b.id}`).toBeLessThan(rectMaxX(h));
        expect(eye.y, `${b.id}`).toBeGreaterThan(h.y);
        expect(eye.y, `${b.id}`).toBeLessThan(h.y + h.height);
      }
    }
  });

  it("keeps eyes symmetric about the centre line", () => {
    for (const b of DOG_BREEDS) {
      const d = new DogCompanion(b);
      expect(d.eyeLeft.y).toBe(d.eyeRight.y);
      expect((d.eyeLeft.x + d.eyeRight.x) / 2).toBeCloseTo(85, 6);
    }
  });

  it("makes the bulldog widest and the shih tzu smallest", () => {
    const bulldog = new DogCompanion(findBreed("dog-bulldog"));
    const shihtzu = new DogCompanion(findBreed("dog-shihtzu"));
    const lab = new DogCompanion(findBreed("dog-labrador"));
    expect(bulldog.headEllipse.width).toBeGreaterThan(lab.headEllipse.width);
    expect(shihtzu.headEllipse.width).toBeLessThan(lab.headEllipse.width);
    // Girth shows up in how far the paws sit from the centre line.
    expect(bulldog.handRight.x).toBeGreaterThan(lab.handRight.x);
    expect(shihtzu.handRight.x).toBeLessThan(lab.handRight.x);
  });

  it("raises the hat anchor for erect ears so a hat clears them", () => {
    const husky = new DogCompanion(findBreed("dog-husky")); // erect
    const lab = new DogCompanion(findBreed("dog-labrador")); // drop
    expect(husky.hatAnchor.y).toBeGreaterThan(lab.hatAnchor.y);
  });

  it("puts the scarf line low, where a dog's neck actually is", () => {
    // Placed under the skull it lands across the muzzle — the reason this is 74
    // rather than just below headEllipse.
    for (const b of DOG_BREEDS) {
      const d = new DogCompanion(b);
      expect(d.neckY).toBeLessThan(d.headEllipse.y);
    }
  });

  it("gives socked breeds a pale hand fill", () => {
    expect(new DogCompanion(findBreed("dog-husky")).handFill).toEqual(
      findBreed("dog-husky").palette.furLight,
    );
    expect(new DogCompanion(findBreed("dog-labrador")).handFill).toEqual(
      findBreed("dog-labrador").palette.fur,
    );
  });
});

describe("breed features change the drawing", () => {
  it("draws a different silhouette for every breed", () => {
    const sigs = DOG_BREEDS.map((b) => render(b.id).signature());
    expect(new Set(sigs).size).toBe(DOG_BREEDS.length);
  });

  it("gives the husky a two-tone tail the labrador does not have", () => {
    // brush = dark stroke + pale underside; otter = one stroke.
    expect(strokeCount(render("dog-husky"))).toBeGreaterThan(
      strokeCount(render("dog-labrador")),
    );
  });

  it("adds the shih tzu's coat curtain and face hair", () => {
    // 9 strands + 10 fringe lobes + 2 curtains + topknot + 3 bow pieces.
    expect(render("dog-shihtzu").count("fill")).toBeGreaterThan(
      render("dog-labrador").count("fill") + 20,
    );
  });

  it("draws the bulldog's brow wrinkles as strokes", () => {
    expect(strokeCount(render("dog-bulldog"))).toBeGreaterThan(
      strokeCount(render("dog-labrador")),
    );
  });

  it("uses distinct palettes so no two breeds paint identically", () => {
    const palettes = DOG_BREEDS.map((b) =>
      [...render(b.id).paintedColours()].sort().join(","),
    );
    expect(new Set(palettes).size).toBe(DOG_BREEDS.length);
  });
});

describe("dogs wag — the tail is their loudest mood signal", () => {
  it("moves the tail differently for happy, cross and asleep", () => {
    const happy = render("dog-labrador", { mood: "happy", phase: 1 }).signature();
    const cross = render("dog-labrador", { mood: "tantrum", phase: 1 }).signature();
    const asleep = render("dog-labrador", { mood: "sleeping", phase: 1 }).signature();
    expect(new Set([happy, cross, asleep]).size).toBe(3);
  });

  it("wags widest when happy", () => {
    // amp 15 for happy vs 7 for idle — the tail tip must travel further.
    const reach = (mood: SceneState["mood"]): number => {
      const ctx = new RecordingCtx();
      new DogCompanion().drawBehind(ctx, state({ mood, phase: Math.PI / 2 / 9 }));
      return ctx.bounds().maxY;
    };
    expect(reach("happy")).toBeGreaterThan(reach("idle"));
  });
});

describe("mood reaches the muzzle", () => {
  it("bares teeth in a tantrum", () => {
    // Two white triangles, an ink mouth and a tongue-coloured inner.
    expect(render("dog-labrador", { mood: "tantrum" }).count("fill")).toBeGreaterThan(
      render("dog-labrador", { mood: "idle" }).count("fill"),
    );
  });

  it("shows a tongue when happy or proud", () => {
    const happy = render("dog-labrador", { mood: "happy" }).paintedColours();
    const idle = render("dog-labrador", { mood: "idle" }).paintedColours();
    const tongue = "rgb(237, 133, 140)";
    expect(happy).toContain(tongue);
    expect(idle).not.toContain(tongue);
  });

  it("gives the bulldog an underbite only at rest, not mid-bark", () => {
    const idle = render("dog-bulldog", { mood: "idle" }).count("fill");
    const barking = render("dog-bulldog", { mood: "tantrum" }).count("fill");
    expect(idle).not.toBe(barking);
  });
});

describe("design-space contract", () => {
  it("no breed intrudes on the badge strip in tantrum — the only mood it shows in", () => {
    // A tab alert forces the mood to `tantrum` (CompanionView.swift:113), so
    // tantrum is the only mood that can co-occur with the badge. This is the
    // assertion that actually protects badge legibility.
    for (const b of DOG_BREEDS) {
      const ctx = render(b.id, { mood: "tantrum", phase: 1.3 });
      expect(
        ctx.bounds().maxY,
        `${b.id} intruded on the badge strip while cross`,
      ).toBeLessThanOrEqual(166);
    }
  });

  it("documents the husky's latent ear overshoot, matching the cat's", () => {
    // SAME KNOWN DEVIATION AS cat-indie, inherited from the Swift reference —
    // which makes it a pattern rather than a one-off: neither drawing engine
    // bounds-checks the scrolling lean.
    //
    // Scrolling leans ears UP (dogs: lean = +4), tantrum leans them DOWN
    // (lean = -7). The husky's erect ears sit at headEllipse.maxY + 18 + lean:
    //     scrolling -> 148 + 18 + 4 = 170   (inside the badge strip)
    //     tantrum   -> 148 + 18 - 7 = 159   (clear)
    //
    // Harmless today because a badge forces tantrum. Pinned so that if the
    // lean, the ear geometry or the head box changes, it stops being harmless
    // and we hear about it immediately.
    expect(render("dog-husky", { mood: "scrolling" }).bounds().maxY).toBeCloseTo(170, 2);
    expect(
      render("dog-husky", { mood: "tantrum" }).bounds().maxY,
    ).toBeLessThanOrEqual(166);
  });

  it("keeps every other breed clear of the badge strip in every mood", () => {
    for (const b of DOG_BREEDS) {
      if (b.id === "dog-husky") continue; // covered by the deviation test above
      for (const mood of ALL_MOODS) {
        const ctx = render(b.id, { mood, phase: 1.3 });
        expect(
          ctx.bounds().maxY,
          `${b.id} / ${mood} drew above the badge strip`,
        ).toBeLessThanOrEqual(166);
      }
    }
  });

  it("no breed in any mood falls through the floor", () => {
    for (const b of DOG_BREEDS) {
      for (const mood of ALL_MOODS) {
        const ctx = render(b.id, { mood, phase: 0.7 });
        expect(
          ctx.bounds().minY,
          `${b.id} / ${mood} drew below the ground plane`,
        ).toBeGreaterThanOrEqual(GROUND_Y - 0.001);
      }
    }
  });

  it("never emits a non-finite coordinate", () => {
    for (const b of DOG_BREEDS) {
      for (const mood of ALL_MOODS) {
        for (const phase of [0, 0.5, 1.7, 3.14159, 42.5, 1000]) {
          expect(
            render(b.id, { mood, phase }).hasNonFiniteArgs(),
            `${b.id} / ${mood} / ${phase}`,
          ).toBe(false);
        }
      }
    }
  });

  it("renders every breed in every mood without throwing", () => {
    for (const b of DOG_BREEDS) {
      for (const mood of ALL_MOODS) {
        expect(() => render(b.id, { mood, phase: 2.2 }), `${b.id}/${mood}`).not.toThrow();
      }
    }
  });
});

function strokeCount(ctx: RecordingCtx): number {
  return ctx.count("stroke");
}
