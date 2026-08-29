import { describe, it, expect } from "vitest";
import { RecordingCtx } from "./helpers/recordingCtx";
import { OUTFITS, findOutfit, seasonalOutfit, seasonalLabel, SEASONAL_ID, BARE_ID } from "../src/outfits/registry";
import { hatFit, CEILING } from "../src/outfits/kit";
import { COMPANIONS, findCompanion } from "../src/companions/registry";
import { drawCompanion } from "../src/render/scene";
import { ALL_MOODS, BADGE_STRIP_Y, type SceneState } from "../src/core/types";

const state = (over: Partial<SceneState> = {}): SceneState => ({
  mood: "idle",
  phase: 0,
  blinking: false,
  ...over,
});

/** January is month 1; JS Date months are 0-based, hence the -1 everywhere. */
const on = (month: number, day = 15): Date => new Date(2026, month - 1, day);

describe("the wardrobe", () => {
  it("ships the six garments from the Swift reference", () => {
    expect(OUTFITS.map((o) => o.id)).toEqual([
      "party",
      "flowers",
      "shades",
      "pumpkin",
      "scarf",
      "santa",
    ]);
  });

  it("has no duplicate ids — they are persisted in preferences", () => {
    expect(new Set(OUTFITS.map((o) => o.id)).size).toBe(OUTFITS.length);
  });

  it("gives every garment a name and a glyph for the closet chip", () => {
    for (const o of OUTFITS) {
      expect(o.name.length, o.id).toBeGreaterThan(0);
      expect(o.glyph.length, o.id).toBeGreaterThan(0);
    }
  });
});

describe("dress for the season", () => {
  it("assigns each month to at most one garment", () => {
    for (let m = 1; m <= 12; m++) {
      const claimants = OUTFITS.filter((o) => o.months.has(m));
      expect(claimants.length, `month ${m} claimed by ${claimants.length}`).toBeLessThanOrEqual(1);
    }
  });

  it("follows the calendar through the year", () => {
    const expected: Record<number, string | null> = {
      1: "santa",
      2: "santa",
      3: "flowers",
      4: "flowers",
      5: "flowers",
      6: "shades",
      7: "shades",
      8: "shades",
      9: null, // deliberately bare
      10: "pumpkin",
      11: "scarf",
      12: "santa",
    };
    for (let m = 1; m <= 12; m++) {
      expect(seasonalOutfit(on(m))?.id ?? null, `month ${m}`).toBe(expected[m]!);
    }
  });

  it("leaves September bare rather than falling back to the first garment", () => {
    // An empty month must read as "no outfit". Returning OUTFITS[0] would put a
    // party hat on every September.
    expect(seasonalOutfit(on(9))).toBeNull();
    expect(seasonalLabel(on(9))).toBe("Seasonal · nothing this month");
  });

  it("never auto-picks the party hat — a party is declared, not scheduled", () => {
    for (let m = 1; m <= 12; m++) {
      expect(seasonalOutfit(on(m))?.id, `month ${m}`).not.toBe("party");
    }
  });

  it("labels the seasonal chip with the garment's name", () => {
    expect(seasonalLabel(on(11))).toBe("Seasonal · Cosy scarf");
  });

  it("does not fall foul of the 0-based month trap", () => {
    // JS months are 0-based and the Swift's are 1-based. An off-by-one here
    // would silently dress everyone one month early all year.
    expect(seasonalOutfit(on(12))?.id).toBe("santa");
    expect(seasonalOutfit(on(10))?.id).toBe("pumpkin");
  });
});

describe("findOutfit", () => {
  it("treats null, undefined and 'none' as bare", () => {
    expect(findOutfit(null)).toBeNull();
    expect(findOutfit(undefined)).toBeNull();
    expect(findOutfit(BARE_ID)).toBeNull();
  });

  it("resolves the seasonal sentinel through the calendar", () => {
    expect(findOutfit(SEASONAL_ID, on(10))?.id).toBe("pumpkin");
    expect(findOutfit(SEASONAL_ID, on(9))).toBeNull();
  });

  it("resolves a concrete id regardless of the date", () => {
    expect(findOutfit("santa", on(7))?.id).toBe("santa");
  });

  it("resolves an unknown id to bare rather than throwing", () => {
    // A stored preference can outlive the garment it names.
    expect(findOutfit("sombrero")).toBeNull();
  });
});

describe("hatFit — one wardrobe, eighteen heads", () => {
  it("keeps every hat under the ceiling on every companion", () => {
    for (const c of COMPANIONS) {
      for (const height of [0.3, 0.37, 0.38]) {
        const fit = hatFit(c, height);
        expect(
          fit.base.y + fit.u * height,
          `${c.id} at height ${height}`,
        ).toBeLessThanOrEqual(CEILING + 0.001);
      }
    }
  });

  it("never returns a zero or negative unit", () => {
    for (const c of COMPANIONS) {
      expect(hatFit(c, 0.37).u, c.id).toBeGreaterThan(0);
    }
  });

  it("sinks a hat into a tall skull rather than shrinking it away", () => {
    // The cat's ears push hatAnchor high; refusing to sink would halve the hat.
    const cat = findCompanion("cat-ginger");
    const fit = hatFit(cat, 0.37);
    expect(fit.base.y).toBeLessThanOrEqual(cat.hatAnchor.y);
    // Still a usable size, not a shrunken token.
    expect(fit.u).toBeGreaterThan(cat.headEllipse.width * 0.45);
  });

  it("sizes off the eye band, not just width, for a wide flat face", () => {
    // The capybara is wide but has little headroom; a hat sized off width alone
    // would be worn over its own eyes.
    const capy = findCompanion("capybara");
    const fit = hatFit(capy, 0.37);
    const brow = Math.max(capy.eyeLeft.y, capy.eyeRight.y);
    expect(fit.base.y).toBeGreaterThan(brow);
  });
});

describe("every outfit on every companion", () => {
  it("renders without throwing or emitting NaN", () => {
    for (const c of COMPANIONS) {
      for (const o of OUTFITS) {
        for (const mood of ALL_MOODS) {
          const ctx = new RecordingCtx();
          expect(
            () => drawCompanion(ctx, c, state({ mood, phase: 1.7 }), o),
            `${c.id} in ${o.id} / ${mood}`,
          ).not.toThrow();
          expect(ctx.hasNonFiniteArgs(), `${c.id} in ${o.id} / ${mood}`).toBe(false);
        }
      }
    }
  });

  it("never intrudes on the tab-badge strip", () => {
    // The whole point of hatFit. A garment that ignored it would put a party
    // hat through the tab counter on the tallest-eared characters.
    for (const c of COMPANIONS) {
      for (const o of OUTFITS) {
        for (const mood of ALL_MOODS) {
          const ctx = new RecordingCtx();
          drawCompanion(ctx, c, state({ mood, phase: 2.4 }), o);
          expect(
            ctx.bounds().maxY,
            `${c.id} in ${o.id} / ${mood}`,
          ).toBeLessThanOrEqual(BADGE_STRIP_Y);
        }
      }
    }
  });

  it("balances save and restore, so clipping cannot leak", () => {
    // Four of the six garments clip: the party hat's stripes, the sunglasses'
    // glint, the scarf's stripes and the santa hat's shading.
    for (const c of COMPANIONS) {
      for (const o of OUTFITS) {
        const ctx = new RecordingCtx();
        drawCompanion(ctx, c, state(), o);
        expect(ctx.count("save"), `${c.id} in ${o.id}`).toBe(ctx.count("restore"));
      }
    }
  });

  it("actually paints something for every garment", () => {
    for (const c of COMPANIONS) {
      for (const o of OUTFITS) {
        const bare = new RecordingCtx();
        drawCompanion(bare, c, state());
        const dressed = new RecordingCtx();
        drawCompanion(dressed, c, state(), o);
        expect(
          dressed.calls.length,
          `${c.id} in ${o.id} added nothing`,
        ).toBeGreaterThan(bare.calls.length);
      }
    }
  });
});

describe("garments that respond to state", () => {
  /**
   * Draws the GARMENT ALONE, not the whole scene. Comparing full renders would
   * pick up the companion's own animation — the cat's tail sways with phase —
   * and every one of these assertions would pass for the wrong reason.
   */
  const withOutfit = (id: string, s: Partial<SceneState>): RecordingCtx => {
    const ctx = new RecordingCtx();
    const o = OUTFITS.find((x) => x.id === id)!;
    o.draw(ctx, findCompanion("cat-ginger"), state(s));
    return ctx;
  };

  it("slips the sunglasses down the nose when asleep", () => {
    expect(withOutfit("shades", { mood: "sleeping" }).signature()).not.toBe(
      withOutfit("shades", { mood: "idle" }).signature(),
    );
  });

  it("swings the scarf harder when cross than when calm", () => {
    expect(withOutfit("scarf", { mood: "tantrum", phase: 1 }).signature()).not.toBe(
      withOutfit("scarf", { mood: "idle", phase: 1 }).signature(),
    );
  });

  it("rocks the pumpkin hat with phase", () => {
    expect(withOutfit("pumpkin", { phase: 0 }).signature()).not.toBe(
      withOutfit("pumpkin", { phase: 0.9 }).signature(),
    );
  });

  it("keeps the flower crown still — a woven band does not bob", () => {
    // Deliberate: flowers animating would be a second animation fighting the
    // one the companion is already doing.
    expect(withOutfit("flowers", { phase: 0 }).signature()).toBe(
      withOutfit("flowers", { phase: 7.3 }).signature(),
    );
  });
});

describe("outfits are drawn last", () => {
  it("puts garment paint after the muzzle, so shades can cover the eyes", () => {
    const bare = new RecordingCtx();
    drawCompanion(bare, findCompanion("cat-ginger"), state());
    const dressed = new RecordingCtx();
    const shades = OUTFITS.find((o) => o.id === "shades")!;
    drawCompanion(dressed, findCompanion("cat-ginger"), state(), shades);

    // Everything the bare render emitted is still there, unchanged, at the
    // front — the outfit only appends.
    expect(dressed.calls.length).toBeGreaterThan(bare.calls.length);
    expect(dressed.signature().startsWith(bare.signature())).toBe(true);
  });
});
