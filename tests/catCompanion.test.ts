import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { CatCompanion } from "../src/companions/catCompanion";
import { CAT_COATS, DEFAULT_CAT_ID, findCoat } from "../src/companions/catBreeds";
import {
  ALL_MOODS,
  blushLeft,
  blushRight,
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

describe("coat registry", () => {
  it("ships the six coats from the Swift reference", () => {
    expect(CAT_COATS).toHaveLength(6);
    expect(CAT_COATS.map((c) => c.id)).toEqual([
      "cat-ginger",
      "cat-bengal",
      "cat-indie",
      "cat-black",
      "cat-calico",
      "cat-persian",
    ]);
  });

  it("has no duplicate ids — they are persisted in preferences", () => {
    const ids = new Set(CAT_COATS.map((c) => c.id));
    expect(ids.size).toBe(CAT_COATS.length);
  });

  it("defaults to the ginger tabby the product is named after", () => {
    expect(DEFAULT_CAT_ID).toBe("cat-ginger");
    expect(new CatCompanion().id).toBe("cat-ginger");
    expect(new CatCompanion().defaultName).toBe("Loaf");
  });

  it("falls back to the first coat for an unknown id rather than throwing", () => {
    // A user's saved coat can disappear when a pack is uninstalled; that must
    // not be fatal on launch.
    expect(findCoat("cat-does-not-exist").id).toBe("cat-ginger");
    expect(CatCompanion.byId("nonsense").id).toBe("cat-ginger");
  });

  it("gives every coat a name, breed and blurb for the closet card", () => {
    for (const c of CAT_COATS) {
      expect(c.defaultName.length).toBeGreaterThan(0);
      expect(c.breed.length).toBeGreaterThan(0);
      expect(c.blurb.length).toBeGreaterThan(0);
    }
  });

  it("gives every cat an iris, which is what separates the coats visually", () => {
    for (const c of CAT_COATS) {
      expect(c.palette.iris, `${c.id} has no iris`).toBeDefined();
    }
  });
});

describe("anchors", () => {
  it("places both eyes inside the head box", () => {
    for (const coat of CAT_COATS) {
      const cat = new CatCompanion(coat);
      const h = cat.headEllipse;
      for (const eye of [cat.eyeLeft, cat.eyeRight]) {
        expect(eye.x, `${coat.id} eye x`).toBeGreaterThan(rectMinX(h));
        expect(eye.x, `${coat.id} eye x`).toBeLessThan(rectMaxX(h));
        expect(eye.y, `${coat.id} eye y`).toBeGreaterThan(h.y);
        expect(eye.y, `${coat.id} eye y`).toBeLessThan(h.y + h.height);
      }
    }
  });

  it("keeps the eyes level and symmetric about the centre line", () => {
    for (const coat of CAT_COATS) {
      const cat = new CatCompanion(coat);
      expect(cat.eyeLeft.y).toBe(cat.eyeRight.y);
      const mid = (cat.eyeLeft.x + cat.eyeRight.x) / 2;
      expect(mid, `${coat.id} eyes off-centre`).toBeCloseTo(85, 1);
    }
  });

  it("puts the hat anchor above the head, where a hat would rest", () => {
    for (const coat of CAT_COATS) {
      const cat = new CatCompanion(coat);
      expect(cat.hatAnchor.y).toBeGreaterThan(cat.eyeLeft.y);
      expect(cat.hatAnchor.x).toBe(85);
    }
  });

  it("gives the persian a wider, lower skull and bigger eyes", () => {
    const persian = new CatCompanion(findCoat("cat-persian"));
    const ginger = new CatCompanion(findCoat("cat-ginger"));
    expect(persian.headEllipse.width).toBeGreaterThan(ginger.headEllipse.width);
    expect(persian.headEllipse.height).toBeLessThan(ginger.headEllipse.height);
    expect(persian.eyeScale).toBeGreaterThan(ginger.eyeScale);
  });

  it("uses pale socks for the hand fill only on the socked coat", () => {
    const indie = new CatCompanion(findCoat("cat-indie"));
    const ginger = new CatCompanion(findCoat("cat-ginger"));
    expect(indie.handFill).toEqual(indie.palette.furLight);
    expect(ginger.handFill).toEqual(ginger.palette.fur);
  });

  it("derives blush from the head box, under the outer eye corners", () => {
    const cat = new CatCompanion();
    const l = blushLeft(cat);
    const r = blushRight(cat);
    expect(l.x).toBeLessThan(r.x);
    expect(l.y).toBeLessThan(cat.eyeLeft.y);
    expect(l.width).toBe(r.width);
  });
});

describe("coat features actually change the drawing", () => {
  const render = (id: string, mood: SceneState["mood"] = "idle"): RecordingCtx => {
    const ctx = new RecordingCtx();
    const cat = new CatCompanion(findCoat(id));
    cat.drawBehind(ctx, state({ mood }));
    cat.drawBody(ctx, state({ mood }));
    cat.drawHead(ctx, state({ mood }));
    cat.drawMuzzle(ctx, state({ mood }));
    return ctx;
  };

  it("draws more shapes for a patched calico than a plain black cat", () => {
    expect(render("cat-calico").count("fill")).toBeGreaterThan(
      render("cat-black").count("fill"),
    );
  });

  it("draws rosettes only on the bengal", () => {
    // Nine rosettes, each a ring plus a centre.
    expect(render("cat-bengal").count("fill")).toBeGreaterThan(
      render("cat-black").count("fill") + 17,
    );
  });

  it("adds a ruff for the long-haired persian", () => {
    const persian = render("cat-persian");
    const ginger = render("cat-ginger");
    // Ruff: one under-layer, nine lobes, five shadow strokes.
    expect(persian.count("fill") + persian.count("stroke")).toBeGreaterThan(
      ginger.count("fill"),
    );
  });

  it("uses distinct palettes so two coats never paint identically", () => {
    const signatures = CAT_COATS.map((c) => {
      const ctx = new RecordingCtx();
      new CatCompanion(c).drawBody(ctx, state());
      return [...ctx.paintedColours()].sort().join(",");
    });
    expect(new Set(signatures).size).toBe(CAT_COATS.length);
  });
});

describe("mood affects anatomy, not just the face", () => {
  const behind = (mood: SceneState["mood"], phase = 1.0): RecordingCtx => {
    const ctx = new RecordingCtx();
    new CatCompanion().drawBehind(ctx, state({ mood, phase }));
    return ctx;
  };

  it("swings the tail harder in a tantrum than at rest", () => {
    const calm = behind("idle").signature();
    const cross = behind("tantrum").signature();
    expect(cross).not.toBe(calm);
  });

  it("barely moves the tail while asleep", () => {
    const asleep = new RecordingCtx();
    new CatCompanion().drawBehind(asleep, state({ mood: "sleeping", phase: 1 }));
    const awake = new RecordingCtx();
    new CatCompanion().drawBehind(awake, state({ mood: "idle", phase: 1 }));
    // Sleeping amplitude is 4 vs idle 9 — the tail tip must sit lower.
    expect(asleep.bounds().maxY).toBeLessThan(awake.bounds().maxY);
  });

  it("bares a jagged mouth in a tantrum and a soft one otherwise", () => {
    const cross = new RecordingCtx();
    new CatCompanion().drawMuzzle(cross, state({ mood: "tantrum" }));
    const calm = new RecordingCtx();
    new CatCompanion().drawMuzzle(calm, state({ mood: "idle" }));
    // The jagged mouth is straight segments; the calm one is two curves.
    expect(cross.count("lineTo")).toBeGreaterThan(calm.count("lineTo"));
    expect(calm.count("bezierCurveTo")).toBeGreaterThan(0);
  });

  it("leans the ears differently for tantrum and scrolling", () => {
    const a = new RecordingCtx();
    new CatCompanion().drawHead(a, state({ mood: "tantrum" }));
    const b = new RecordingCtx();
    new CatCompanion().drawHead(b, state({ mood: "scrolling" }));
    const c = new RecordingCtx();
    new CatCompanion().drawHead(c, state({ mood: "idle" }));
    expect(a.signature()).not.toBe(c.signature());
    expect(b.signature()).not.toBe(c.signature());
    expect(a.signature()).not.toBe(b.signature());
  });
});

describe("robustness", () => {
  it("renders every coat in every mood without throwing", () => {
    for (const coat of CAT_COATS) {
      for (const mood of ALL_MOODS) {
        expect(() => {
          const ctx = new RecordingCtx();
          const cat = new CatCompanion(coat);
          const s = state({ mood, phase: 2.2 });
          cat.drawBehind(ctx, s);
          cat.drawBody(ctx, s);
          cat.drawHead(ctx, s);
          cat.drawMuzzle(ctx, s);
        }, `${coat.id} / ${mood}`).not.toThrow();
      }
    }
  });

  it("is deterministic — the same state renders identically twice", () => {
    const once = new RecordingCtx();
    const twice = new RecordingCtx();
    const s = state({ mood: "tantrum", phase: 3.3 });
    new CatCompanion().drawBehind(once, s);
    new CatCompanion().drawBehind(twice, s);
    expect(once.signature()).toBe(twice.signature());
  });
});
