import { describe, it, expect } from "vitest";
import {
  ClosetSettings,
  MemorySettingsStore,
  displayName,
  isSeasonal,
  normaliseName,
  NO_OUTFIT,
  MAX_NAME_LENGTH,
} from "../src/closet/settings";
import { isClosetPick, isClosetState } from "../src/closet/events";
import { closetBody } from "../src/closet/view";
import { COMPANIONS, DEFAULT_COMPANION_ID, grouped } from "../src/companions/registry";
import { OUTFITS, SEASONAL_ID } from "../src/outfits/registry";
import { loadHabits, saveHabits, habitLine } from "../src/behaviour/habits";
import { defaultBehaviourSettings } from "../src/behaviour/settings";

const fresh = (): ClosetSettings => new ClosetSettings(new MemorySettingsStore());

describe("remembering what was picked", () => {
  it("starts on the shipped character wearing nothing", () => {
    const s = fresh().read();
    expect(s.companionId).toBe(DEFAULT_COMPANION_ID);
    expect(s.outfitId).toBe(NO_OUTFIT);
    expect(s.pixelated).toBe(false);
    expect(s.names).toEqual({});
  });

  it("keeps a choice across a restart", () => {
    const store = new MemorySettingsStore();
    const first = new ClosetSettings(store);
    first.setCompanion("dog-husky");
    first.setOutfit("scarf");
    first.setPixelated(true);

    const after = new ClosetSettings(store).read();
    expect(after.companionId).toBe("dog-husky");
    expect(after.outfitId).toBe("scarf");
    expect(after.pixelated).toBe(true);
  });

  it("stores no outfit as a sentinel, never an empty string", () => {
    // An empty value is indistinguishable from an absent key, and the absent
    // key already means something else.
    const store = new MemorySettingsStore();
    new ClosetSettings(store).setOutfit(null);
    expect(store.getItem("closet.outfit")).toBe(NO_OUTFIT);
  });

  it("falls back rather than throwing when a saved character is gone", () => {
    // A saved id can legitimately disappear between versions, and that must not
    // be fatal on launch.
    const store = new MemorySettingsStore();
    store.setItem("closet.companion", "cat-from-a-future-release");
    const state = new ClosetSettings(store).read();
    // The state keeps the raw id; the registry is what resolves it safely.
    expect(state.companionId).toBe("cat-from-a-future-release");
    expect(COMPANIONS.some((c) => c.id === state.companionId)).toBe(false);
  });
});

describe("naming a companion", () => {
  it("keeps names per character", () => {
    // The closet card promises exactly this: renaming this one won't rename the
    // rest. Switching away and back should find the old name intact.
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    s.setName("cat-ginger", "Biscuit");
    s.setName("dog-husky", "Wolfgang");

    const state = s.read();
    expect(displayName(state, "cat-ginger", "Ginger")).toBe("Biscuit");
    expect(displayName(state, "dog-husky", "Husky")).toBe("Wolfgang");
  });

  it("falls back to the shipped name for anything unnamed", () => {
    expect(displayName(fresh().read(), "cat-ginger", "Ginger")).toBe("Ginger");
  });

  it("treats an empty field as the reset", () => {
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    s.setName("cat-ginger", "Biscuit");
    s.setName("cat-ginger", normaliseName(""));
    expect(displayName(s.read(), "cat-ginger", "Ginger")).toBe("Ginger");
  });

  it("treats a field of spaces as empty too", () => {
    // Otherwise the pet ends up called "   " and the reset appears not to work.
    expect(normaliseName("   ")).toBeNull();
    expect(normaliseName("  Biscuit  ")).toBe("Biscuit");
  });

  it("cuts a name down to something that fits on a card", () => {
    const long = normaliseName("x".repeat(200));
    expect(long).toHaveLength(MAX_NAME_LENGTH);
  });

  it("survives a corrupt name map instead of showing junk", () => {
    // These are rendered as the character's own name, so a stray null would put
    // the word "null" on someone's pet.
    const store = new MemorySettingsStore();
    store.setItem(
      "closet.names",
      JSON.stringify({ "cat-ginger": null, "dog-husky": 7, "cat-black": "Sooty" }),
    );
    const state = new ClosetSettings(store).read();
    expect(state.names).toEqual({ "cat-black": "Sooty" });
  });

  it("survives a name map that is not even JSON", () => {
    const store = new MemorySettingsStore();
    store.setItem("closet.names", "{not json");
    expect(new ClosetSettings(store).read().names).toEqual({});
  });
});

describe("picks arriving from the other window", () => {
  it("accepts what the closet actually sends", () => {
    expect(isClosetPick({ kind: "companion", id: "cat-ginger" })).toBe(true);
    expect(isClosetPick({ kind: "outfit", id: NO_OUTFIT })).toBe(true);
    expect(isClosetPick({ kind: "pixelated", on: true })).toBe(true);
    expect(isClosetPick({ kind: "rename", name: "" })).toBe(true);
  });

  it("rejects anything else", () => {
    // This payload crosses a window boundary and the companion acts on it by
    // changing what is on screen and writing to storage.
    for (const junk of [
      null,
      "companion",
      { kind: "companion" },
      { kind: "companion", id: "" },
      { kind: "pixelated", on: "yes" },
      { kind: "rename" },
      { kind: "quit" },
    ]) {
      expect(isClosetPick(junk)).toBe(false);
    }
  });
});

describe("the closet page", () => {
  const state = fresh().read();

  it("offers every character that is in the registry", () => {
    const html = closetBody(state);
    for (const c of COMPANIONS) {
      expect(html).toContain(`data-companion="${c.id}"`);
    }
  });

  it("gives every character a canvas to be drawn into", () => {
    // The reference has to render each thumbnail offscreen and paste it in as a
    // base64 PNG, because AppKit cannot draw inside a WKWebView. Here the page
    // and the renderer are one runtime, so the canvas is the thumbnail.
    const canvases = closetBody(state).match(/data-thumb="/g) ?? [];
    expect(canvases).toHaveLength(COMPANIONS.length);
  });

  it("offers every garment, plus bare and seasonal", () => {
    const html = closetBody(state);
    expect(html).toContain(`data-outfit="${NO_OUTFIT}"`);
    expect(html).toContain(`data-outfit="${SEASONAL_ID}"`);
    for (const o of OUTFITS) expect(html).toContain(`data-outfit="${o.id}"`);
  });

  it("marks exactly one character as on duty", () => {
    const badges = closetBody(state).match(/class="tag"/g) ?? [];
    expect(badges).toHaveLength(1);
  });

  it("marks exactly one outfit chip as chosen", () => {
    const chosen = closetBody(state).match(/class="chip on"/g) ?? [];
    expect(chosen).toHaveLength(1);
  });

  it("moves the on-duty badge when the character changes", () => {
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    s.setCompanion("dog-husky");
    const html = closetBody(s.read());
    const at = html.indexOf('data-companion="dog-husky"');
    // The badge belongs to the card that opened just before it.
    expect(html.indexOf('class="tag"')).toBeGreaterThan(at);
    expect(html).toContain('class="card on" data-companion="dog-husky"');
  });

  it("shows the name field empty while the name is still the shipped one", () => {
    // So the placeholder does the explaining and clearing it is the obvious
    // reset.
    expect(closetBody(state)).toContain('id="petname"');
    expect(closetBody(state)).toContain('value=""');
  });

  it("shows a custom name in the field", () => {
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    s.setName(DEFAULT_COMPANION_ID, "Biscuit");
    expect(closetBody(s.read())).toContain('value="Biscuit"');
  });

  it("groups into shelves rather than one wall of animals", () => {
    const html = closetBody(state);
    for (const { group } of grouped()) expect(html).toContain(`<h2>${group}</h2>`);
  });

  it("escapes a name the user chose", () => {
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    s.setName(DEFAULT_COMPANION_ID, '"><img onerror=x>');
    const html = closetBody(s.read());
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("carries no inline handler and no script", () => {
    // Same rule as the dashboard: the app's CSP forbids inline script, and the
    // reference wires every button with onclick.
    const html = closetBody(state);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("reflects the pixel toggle", () => {
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    expect(closetBody(s.read())).not.toContain("toggle on");
    s.setPixelated(true);
    expect(closetBody(s.read())).toContain("toggle on");
  });
});

describe("habits", () => {
  const withHabits = (over: Record<string, boolean> = {}, companionId?: string) => {
    const store = new MemorySettingsStore();
    const s = new ClosetSettings(store);
    if (companionId) s.setCompanion(companionId);
    s.habits = { loafing: true, playing: true, wandering: false, drifting: true, ...over };
    return s.read();
  };

  it("offers the three habits every character has", () => {
    const html = closetBody(withHabits());
    for (const h of ["loafing", "playing", "wandering"]) {
      expect(html).toContain(`data-habit="${h}"`);
    }
  });

  it("does not offer drifting to something that cannot drift", () => {
    // A switch wired to nothing, whose default is the opposite of wandering's
    // — baffling sitting next to it on a cat.
    expect(closetBody(withHabits({}, "cat-ginger"))).not.toContain('data-habit="drifting"');
  });

  it("offers drifting to a ghost", () => {
    const ghost = COMPANIONS.find((c) => c.drifts)!;
    expect(closetBody(withHabits({}, ghost.id))).toContain('data-habit="drifting"');
  });

  it("checks the ones that are on and leaves wandering off", () => {
    // The window walk has been built and tested and unreachable; this is the
    // control that finally turns it on, and it must start off.
    const html = closetBody(withHabits());
    expect(html).toMatch(/data-habit="loafing" checked/);
    expect(html).not.toMatch(/data-habit="wandering" checked/);
  });

  it("loads saved habits over the defaults, and nothing else", () => {
    // Only the four booleans come back. A stale or hand-edited file must not be
    // able to leave the pet walking at forty points a second.
    const store = new MemorySettingsStore();
    store.setItem(
      "behaviour.habits",
      JSON.stringify({ wandering: true, loafing: false, wanderSpeed: 400 }),
    );
    const loaded = loadHabits(store);
    expect(loaded.wandering).toBe(true);
    expect(loaded.loafing).toBe(false);
    expect(loaded.wanderSpeed).toBe(defaultBehaviourSettings().wanderSpeed);
  });

  it("ignores a non-boolean where a habit should be", () => {
    const store = new MemorySettingsStore();
    store.setItem("behaviour.habits", JSON.stringify({ wandering: "yes" }));
    expect(loadHabits(store).wandering).toBe(false);
  });

  it("survives a habits file that is not JSON", () => {
    const store = new MemorySettingsStore();
    store.setItem("behaviour.habits", "{oops");
    expect(loadHabits(store)).toEqual(defaultBehaviourSettings());
  });

  it("round-trips through storage", () => {
    const store = new MemorySettingsStore();
    const settings = defaultBehaviourSettings();
    settings.wandering = true;
    saveHabits(store, settings);
    expect(loadHabits(store).wandering).toBe(true);
  });

  it("speaks only for the habits that move him", () => {
    // A confirmation bubble for every switch is a pet that talks back at you
    // for using its own settings.
    expect(habitLine("wandering", true)).toContain("stretch my legs");
    expect(habitLine("drifting", false)).toContain("Anchored");
    expect(habitLine("loafing", true)).toBeNull();
    expect(habitLine("playing", false)).toBeNull();
  });

  it("accepts a habit pick and rejects an invented one", () => {
    expect(isClosetPick({ kind: "habit", habit: "wandering", on: true })).toBe(true);
    expect(isClosetPick({ kind: "habit", habit: "flying", on: true })).toBe(false);
    expect(isClosetPick({ kind: "habit", habit: "wandering", on: "yes" })).toBe(false);
  });
});

describe("the seasonal sentinel", () => {
  it("is told apart from a real garment id", () => {
    expect(isSeasonal(SEASONAL_ID)).toBe(true);
    expect(isSeasonal(NO_OUTFIT)).toBe(false);
    for (const o of OUTFITS) expect(isSeasonal(o.id)).toBe(false);
  });
});

describe("state arriving from the companion", () => {
  it("accepts the shape the companion actually broadcasts", () => {
    expect(isClosetState(fresh().read())).toBe(true);
    expect(
      isClosetState({
        companionId: "dog-husky",
        outfitId: "scarf",
        pixelated: true,
        names: { "dog-husky": "Wolfgang" },
        habits: { loafing: true, playing: true, wandering: false },
      }),
    ).toBe(true);
  });

  it("rejects a payload it would otherwise render eighteen cards from", () => {
    for (const junk of [
      null,
      "state",
      { companionId: "", outfitId: "none", pixelated: false, names: {}, habits: {} },
      { companionId: "x", outfitId: "", pixelated: false, names: {}, habits: {} },
      { companionId: "x", outfitId: "none", pixelated: "no", names: {}, habits: {} },
      { companionId: "x", outfitId: "none", pixelated: false, names: null, habits: {} },
      { companionId: "x", outfitId: "none", pixelated: false, names: { a: 3 }, habits: {} },
      { companionId: "x", outfitId: "none", pixelated: false, habits: {} },
      // A habit that is not a boolean would render as a checkbox in an
      // indeterminate state and toggle to something nobody chose.
      { companionId: "x", outfitId: "none", pixelated: false, names: {}, habits: { a: 1 } },
      { companionId: "x", outfitId: "none", pixelated: false, names: {} },
    ]) {
      expect(isClosetState(junk)).toBe(false);
    }
  });
});
