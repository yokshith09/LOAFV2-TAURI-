import { describe, it, expect } from "vitest";
import { parsePack, frameAt, frameRect, type SpriteClip } from "../src/sprites/manifest";
import { loadPacks, mergeCompanions, FAILURE_NOTES } from "../src/sprites/load";
import { DESIGN_HEIGHT } from "../src/core/types";

const sheet = { file: "sheet.png", scale: 2, frameWidth: 128, frameHeight: 142, columns: 4, rows: 2 };

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "pack-fox",
  name: "Rusty",
  sheet,
  moods: { idle: { from: 0, count: 2 } },
  ...over,
});

/** The error a manifest was rejected for, or null if it was accepted. */
const errorOf = (raw: unknown): string | null => {
  const r = parsePack(raw);
  return r.ok ? null : r.error;
};

const unwrap = (raw: unknown) => {
  const result = parsePack(raw);
  if (!result.ok) throw new Error(`expected a pack, got ${result.error}`);
  return result.pack;
};

describe("what makes a pack loadable", () => {
  it("accepts the smallest complete manifest", () => {
    const pack = unwrap(manifest());
    expect(pack.id).toBe("pack-fox");
    expect(pack.name).toBe("Rusty");
  });

  it("refuses one with no idle clip", () => {
    // A pack with nothing to show at rest is not a character, and guessing on
    // its behalf means shipping a companion that is wrong in a way nobody
    // asked for.
    const r = parsePack(manifest({ moods: { happy: { from: 0, count: 1 } } }));
    expect(r).toEqual({ ok: false, error: "no-idle" });
  });

  it("refuses one with no moods at all", () => {
    expect(parsePack(manifest({ moods: undefined })).ok).toBe(false);
  });

  it("refuses an incomplete sheet rather than guessing the grid", () => {
    // The grid cuts the frames and the scale decides how big the character
    // stands. Neither has a default that could be quietly wrong.
    for (const missing of ["file", "scale", "frameWidth", "frameHeight", "columns", "rows"]) {
      const broken = { ...sheet, [missing]: missing === "file" ? "" : 0 };
      expect(parsePack(manifest({ sheet: broken }))).toEqual({
        ok: false,
        error: "bad-grid",
      });
    }
  });

  it("refuses one with no id or no name", () => {
    expect(errorOf(manifest({ id: "" }))).toBe("no-id");
    expect(errorOf(manifest({ name: "  " }))).toBe("no-name");
  });

  it("refuses something that is not a manifest at all", () => {
    for (const junk of [null, "{}", 7, []]) {
      expect(parsePack(junk).ok).toBe(false);
    }
  });
});

describe("filling in what the pack left out", () => {
  it("gives every mood a clip, so the draw path needs no fallback", () => {
    const pack = unwrap(manifest());
    for (const mood of ["idle", "happy", "sleeping", "worried", "scrolling", "tantrum", "proud"] as const) {
      expect(pack.clips[mood].frames.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the nearest sensible neighbour, not to a blank stare", () => {
    // A pack that drew a tantrum but skipped "worried" should look worried with
    // its tantrum face, rather than going placid.
    const pack = unwrap(
      manifest({
        moods: { idle: { from: 0, count: 1 }, tantrum: { from: 4, count: 2 } },
      }),
    );
    expect(pack.clips.worried.frames).toEqual(pack.clips.tantrum.frames);
    expect(pack.clips.happy.frames).toEqual(pack.clips.idle.frames);
  });

  it("draws its own face by default", () => {
    // The art already has one. The shared eye system drawing a second pair on
    // top is the likeliest way for a pack to look broken on arrival.
    expect(unwrap(manifest()).drawsOwnFace).toBe(true);
  });

  it("lands on the elsewhere shelf when the group is unknown", () => {
    expect(unwrap(manifest({ group: "reptiles" })).group).toBe("elsewhere");
    expect(unwrap(manifest({ group: "dogs" })).group).toBe("dogs");
  });
});

describe("clips", () => {
  it("expands from and count into real indices", () => {
    expect(unwrap(manifest()).clips.idle.frames).toEqual([0, 1]);
  });

  it("takes an explicit frame list, so a clip can hold or ping-pong", () => {
    const pack = unwrap(
      manifest({ moods: { idle: { frames: [0, 1, 2, 1] } } }),
    );
    expect(pack.clips.idle.frames).toEqual([0, 1, 2, 1]);
  });

  it("drops a frame the sheet does not have", () => {
    // Clamping instead would draw the wrong picture silently, which is the
    // least useful way to report a mistake in someone's pack.
    const pack = unwrap(manifest({ moods: { idle: { frames: [0, 99, 3] } } }));
    expect(pack.clips.idle.frames).toEqual([0, 3]);
  });

  it("refuses a clip that is entirely out of range", () => {
    expect(errorOf(manifest({ moods: { idle: { frames: [50, 60] } } }))).toBe("no-idle");
  });

  it("treats a missing frame rate as a still rather than a fault", () => {
    expect(unwrap(manifest()).clips.idle.fps).toBeGreaterThan(0);
  });
});

describe("playing a clip", () => {
  const clip = (over: Partial<SpriteClip> = {}): SpriteClip => ({
    frames: [0, 1, 2],
    fps: 10,
    loops: true,
    ...over,
  });

  it("advances with time", () => {
    expect(frameAt(clip(), 0)).toBe(0);
    expect(frameAt(clip(), 0.1)).toBe(1);
    expect(frameAt(clip(), 0.2)).toBe(2);
  });

  it("wraps a looping clip", () => {
    expect(frameAt(clip(), 0.3)).toBe(0);
  });

  it("holds the last frame of one that does not loop", () => {
    expect(frameAt(clip({ loops: false }), 60)).toBe(2);
  });

  it("survives a phase that has been accumulating for a very long time", () => {
    // `phase` counts from the moment the view was created; a huge value must
    // produce a frame rather than nonsense.
    expect(frameAt(clip(), 1e18)).toBeGreaterThanOrEqual(0);
    expect(frameAt(clip(), -5)).toBe(0);
  });
});

describe("cutting frames out of the sheet", () => {
  it("walks left to right, then down", () => {
    const s = unwrap(manifest()).sheet;
    expect(frameRect(s, 0)).toEqual({ x: 0, y: 0, width: 128, height: 142 });
    expect(frameRect(s, 3)).toEqual({ x: 384, y: 0, width: 128, height: 142 });
    expect(frameRect(s, 4)).toEqual({ x: 0, y: 142, width: 128, height: 142 });
  });
});

describe("anchors measured the other way up", () => {
  it("takes y-up coordinates as they come", () => {
    const pack = unwrap(
      manifest({ anchors: { origin: "bottom-left", hat: { x: 85, y: 150 } } }),
    );
    expect(pack.hatAnchor).toEqual({ x: 85, y: 150 });
  });

  it("flips y-down ones, so nobody has to subtract from 190 by hand", () => {
    // Doing that arithmetic by hand is silent when it goes wrong, and a hat in
    // the wrong place is the only symptom.
    const pack = unwrap(
      manifest({ anchors: { origin: "top-left", hat: { x: 85, y: 40 } } }),
    );
    expect(pack.hatAnchor).toEqual({ x: 85, y: DESIGN_HEIGHT - 40 });
  });

  it("flips a box by its own height, not just its origin", () => {
    // A box measured from the top is anchored by its top edge. Ignoring the
    // height puts the head one head-height too low.
    const pack = unwrap(
      manifest({
        anchors: { origin: "top-left", head: { x: 55, y: 40, width: 60, height: 52 } },
      }),
    );
    expect(pack.headEllipse).toEqual({
      x: 55,
      y: DESIGN_HEIGHT - 40 - 52,
      width: 60,
      height: 52,
    });
  });

  it("leaves defaults alone whichever way up the pack measured", () => {
    // A pack that declares an origin but no anchors must not have its defaults
    // flipped out from under it.
    const down = unwrap(manifest({ anchors: { origin: "top-left" } }));
    const up = unwrap(manifest({ anchors: { origin: "bottom-left" } }));
    expect(down.hatAnchor).toEqual(up.hatAnchor);
    expect(down.headEllipse).toEqual(up.headEllipse);
    expect(down.neckY).toEqual(up.neckY);
  });
});

describe("loading a folder of packs", () => {
  const sheetImage = async () => ({ width: 512, height: 284 });
  const raw = (folder: string, manifestObj: unknown) => ({
    folder,
    manifest: typeof manifestObj === "string" ? manifestObj : JSON.stringify(manifestObj),
    sheet: "data:image/png;base64,AA==",
  });

  it("turns a good pack into a companion", async () => {
    const { companions, failures } = await loadPacks([raw("fox", manifest())], sheetImage);
    expect(failures).toEqual([]);
    expect(companions[0]!.id).toBe("pack-fox");
    expect(companions[0]!.isPreRendered).toBe(true);
  });

  it("skips a broken pack without losing the good ones", async () => {
    // One half-finished character must not cost the user the rest, and must not
    // stop Loaf starting.
    const { companions, failures } = await loadPacks(
      [raw("broken", "{not json"), raw("fox", manifest()), raw("empty", { id: "x" })],
      sheetImage,
    );
    expect(companions).toHaveLength(1);
    expect(failures.map((f) => f.folder).sort()).toEqual(["broken", "empty"]);
  });

  it("says why, in words the person who drew it can act on", async () => {
    const { failures } = await loadPacks([raw("broken", "{not json")], sheetImage);
    expect(FAILURE_NOTES[failures[0]!.reason]).toContain("valid JSON");
    // Every reason has a note; a failure with no explanation is a silent one.
    for (const reason of Object.keys(FAILURE_NOTES)) {
      expect(FAILURE_NOTES[reason as keyof typeof FAILURE_NOTES]).toBeTruthy();
    }
  });

  it("reports a sheet it cannot decode rather than drawing nothing", async () => {
    const failing = async () => {
      throw new Error("nope");
    };
    const { companions, failures } = await loadPacks([raw("fox", manifest())], failing);
    expect(companions).toEqual([]);
    expect(failures[0]!.reason).toBe("bad-image");
  });
});

describe("packs beside the shipped characters", () => {
  const fake = (id: string) => ({ id }) as never;

  it("adds a pack to the list", () => {
    const merged = mergeCompanions([fake("cat-ginger")], [fake("pack-fox")]);
    expect(merged.map((c) => c.id)).toEqual(["cat-ginger", "pack-fox"]);
  });

  it("lets a pack replace a built-in rather than duplicating its id", () => {
    // Two characters with one id makes "which is on duty" unanswerable, and
    // someone who names their pack after a shipped cat meant to.
    const mine = fake("cat-ginger");
    const merged = mergeCompanions([fake("cat-ginger"), fake("dog-husky")], [mine]);
    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.id === "cat-ginger")).toBe(mine);
  });
});
