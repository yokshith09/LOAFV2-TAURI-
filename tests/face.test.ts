import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { drawEyes, drawFurSpikes } from "../src/render/face";
import { CatCompanion } from "../src/companions/catCompanion";
import { findCoat } from "../src/companions/catBreeds";
import { ALL_MOODS, type Mood, type SceneState } from "../src/core/types";

const state = (over: Partial<SceneState> = {}): SceneState => ({
  mood: "idle",
  phase: 0,
  blinking: false,
  ...over,
});

const eyesFor = (mood: Mood, over: Partial<SceneState> = {}): RecordingCtx => {
  const ctx = new RecordingCtx();
  drawEyes(ctx, new CatCompanion(), state({ mood, ...over }));
  return ctx;
};

describe("drawEyes — every mood is visually distinct", () => {
  it("produces a different drawing for each of the seven moods", () => {
    // 'happy' and 'proud' deliberately share a face — the difference between
    // them lives in the body and the bubble, not the eyes.
    const signatures = new Map<string, Mood[]>();
    for (const mood of ALL_MOODS) {
      const sig = eyesFor(mood).signature();
      signatures.set(sig, [...(signatures.get(sig) ?? []), mood]);
    }
    const groups = [...signatures.values()];
    // Exactly one shared pair (happy/proud); everything else unique.
    const shared = groups.filter((g) => g.length > 1);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.sort()).toEqual(["happy", "proud"]);
    expect(groups).toHaveLength(ALL_MOODS.length - 1);
  });

  it("draws a coloured iris with a darker pupil when idle", () => {
    const ctx = eyesFor("idle");
    const colours = ctx.paintedColours();
    const ginger = findCoat("cat-ginger");
    // iris #6FA85C, ink, and a white catchlight must all appear.
    expect(colours).toContain("rgb(111, 168, 92)");
    expect(colours).toContain("rgba(255, 255, 255, 0.9)");
    expect(ginger.palette.iris).toBeDefined();
  });

  it("adds blush only for the happy and proud faces", () => {
    const blushColour = "rgba(244, 155, 160, 0.65)";
    expect(eyesFor("happy").paintedColours()).toContain(blushColour);
    expect(eyesFor("proud").paintedColours()).toContain(blushColour);
    expect(eyesFor("idle").paintedColours()).not.toContain(blushColour);
    expect(eyesFor("tantrum").paintedColours()).not.toContain(blushColour);
  });

  it("draws brows for worried and tantrum but not for idle", () => {
    // Brows are strokes; the idle eye is pure fills.
    expect(eyesFor("worried").count("stroke")).toBeGreaterThan(0);
    expect(eyesFor("tantrum").count("stroke")).toBeGreaterThan(0);
    expect(eyesFor("idle").count("stroke")).toBe(0);
  });

  it("slants worried brows up and tantrum brows down toward the middle", () => {
    const cat = new CatCompanion();
    const worried = eyesFor("worried");
    const tantrum = eyesFor("tantrum");

    // For the left eye the brow runs from (x - 7*dir, y + 9) to (x + 5*dir, y + 16)
    // when worried — rising toward centre — and downward when cross.
    const firstLine = (ctx: RecordingCtx) => {
      const i = ctx.calls.findIndex((c) => c.op === "moveTo" && c.args[1]! > cat.eyeLeft.y);
      return { from: ctx.calls[i]!.args, to: ctx.calls[i + 1]!.args };
    };
    const w = firstLine(worried);
    const t = firstLine(tantrum);
    expect(w.to[1]!).toBeGreaterThan(w.from[1]!); // worried brow rises
    expect(t.to[1]!).toBeLessThan(t.from[1]!); // tantrum brow falls
  });
});

describe("blinking", () => {
  it("overrides every mood with closed lids", () => {
    const closed = eyesFor("sleeping").signature();
    for (const mood of ALL_MOODS) {
      expect(eyesFor(mood, { blinking: true }).signature(), `blink over ${mood}`).toBe(
        closed,
      );
    }
  });

  it("draws exactly two lid strokes and nothing else", () => {
    const ctx = eyesFor("idle", { blinking: true });
    expect(ctx.count("stroke")).toBe(2);
    expect(ctx.count("fill")).toBe(0);
  });
});

describe("animated moods respond to phase", () => {
  it("tracks the scrolling eyes across the page over time", () => {
    const a = eyesFor("scrolling", { phase: 0 }).signature();
    const b = eyesFor("scrolling", { phase: 0.6 }).signature();
    expect(a).not.toBe(b);
  });

  it("twitches one tantrum eye on a beat of its own", () => {
    // sin(phase * 11) > 0.82 gates the squint; find a phase either side of it.
    const open = eyesFor("tantrum", { phase: 0 });
    const twitching = eyesFor("tantrum", { phase: Math.asin(0.9) / 11 });
    expect(open.signature()).not.toBe(twitching.signature());
    // While squinting, that eye loses its catchlight.
    expect(twitching.count("fill")).toBeLessThan(open.count("fill"));
  });

  it("leaves the static moods unaffected by phase", () => {
    for (const mood of ["idle", "happy", "worried", "proud", "sleeping"] as const) {
      expect(
        eyesFor(mood, { phase: 0 }).signature(),
        `${mood} should not animate`,
      ).toBe(eyesFor(mood, { phase: 9.1 }).signature());
    }
  });
});

describe("eyeScale", () => {
  it("makes the persian's eyes larger than the ginger's", () => {
    const wide = new RecordingCtx();
    drawEyes(wide, new CatCompanion(findCoat("cat-persian")), state());
    const normal = new RecordingCtx();
    drawEyes(normal, new CatCompanion(findCoat("cat-ginger")), state());

    const socketWidth = (ctx: RecordingCtx) =>
      ctx.calls.find((c) => c.op === "ellipse")!.args[2]!;
    expect(socketWidth(wide)).toBeGreaterThan(socketWidth(normal));
  });
});

describe("drawFurSpikes", () => {
  it("emits thirteen closed triangles around the head", () => {
    const ctx = new RecordingCtx();
    drawFurSpikes(ctx, new CatCompanion(), 0);
    expect(ctx.count("fill")).toBe(13);
    expect(ctx.count("closePath")).toBe(13);
  });

  it("animates with phase so the fur ripples", () => {
    const a = new RecordingCtx();
    drawFurSpikes(a, new CatCompanion(), 0);
    const b = new RecordingCtx();
    drawFurSpikes(b, new CatCompanion(), 0.4);
    expect(a.signature()).not.toBe(b.signature());
  });

  it("keeps spikes anchored to the head, never floating away", () => {
    const cat = new CatCompanion();
    const ctx = new RecordingCtx();
    drawFurSpikes(ctx, cat, 1.1);
    const head = cat.headEllipse;
    // Longest spike is 5.5 + 4.0 = 9.5 beyond the head ellipse.
    expect(ctx.bounds().maxY).toBeLessThanOrEqual(head.y + head.height + 9.6);
  });
});
