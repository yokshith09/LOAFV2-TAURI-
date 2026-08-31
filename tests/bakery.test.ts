import { describe, it, expect } from "vitest";
import {
  Bakery,
  loafFor,
  riseFor,
  browningFor,
  LOAF_KINDS,
  SHELF_KEY,
  SHELF_LIMIT,
  COLLAPSE_SECONDS,
  type BakeryStore,
} from "../src/bakery/bakery";

class Memory implements BakeryStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const DAY = "2026-08-31";

describe("loafFor", () => {
  it("gives a bigger loaf for a longer session", () => {
    expect(loafFor(5)).toBe("roll");
    expect(loafFor(15)).toBe("bun");
    expect(loafFor(25)).toBe("loaf");
    expect(loafFor(45)).toBe("sourdough");
    expect(loafFor(90)).toBe("cottage");
  });

  it("has a kind for any length, however odd", () => {
    for (const m of [0, 1, 7, 24, 44, 89, 500]) {
      expect(LOAF_KINDS).toContain(loafFor(m));
    }
  });

  it("never rewards a shorter session with a bigger loaf", () => {
    let previous = -1;
    for (const m of [1, 10, 25, 45, 90, 200]) {
      const rank = LOAF_KINDS.indexOf(loafFor(m));
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });
});

describe("riseFor", () => {
  it("starts flat and ends full", () => {
    expect(riseFor(0)).toBe(0);
    expect(riseFor(1)).toBe(1);
  });

  // Bread does most of its rising early. A loaf growing at a constant rate
  // would read as a progress bar shaped like a loaf.
  it("does most of its growing in the first half", () => {
    expect(riseFor(0.5)).toBeGreaterThan(0.65);
  });

  it("clamps nonsense rather than drawing a negative loaf", () => {
    expect(riseFor(-3)).toBe(0);
    expect(riseFor(9)).toBe(1);
  });
});

describe("browningFor", () => {
  it("does nothing until the session is well along", () => {
    expect(browningFor(0)).toBe(0);
    expect(browningFor(0.5)).toBe(0);
  });

  it("colours over the last stretch", () => {
    expect(browningFor(0.8)).toBeGreaterThan(0);
    expect(browningFor(1)).toBe(1);
  });

  // Full-size and pale is obviously not finished, which is the signal that
  // keeps someone sitting there.
  it("is still pale when the loaf is already nearly full size", () => {
    expect(riseFor(0.5)).toBeGreaterThan(0.65);
    expect(browningFor(0.5)).toBe(0);
  });
});

describe("the oven", () => {
  const oven = (store = new Memory()) => ({ bakery: new Bakery(store), store });

  it("has nothing in it without a session", () => {
    expect(oven().bakery.peek(null, 25)).toBeNull();
  });

  it("shows dough rising through a session", () => {
    const { bakery } = oven();
    const early = bakery.peek(0.1, 25)!;
    const late = bakery.peek(0.9, 25)!;
    expect(late.rise).toBeGreaterThan(early.rise);
    expect(late.browning).toBeGreaterThan(early.browning);
    expect(late.kind).toBe("loaf");
  });

  it("puts a finished loaf on the shelf", () => {
    const { bakery } = oven();
    const loaf = bakery.bake(25, DAY);
    expect(loaf.kind).toBe("loaf");
    expect(bakery.total).toBe(1);
    expect(bakery.countOn(DAY)).toBe(1);
  });
});

describe("abandoning a session", () => {
  it("collapses the loaf", () => {
    const bakery = new Bakery(new Memory());
    bakery.noteProgress(0.6);
    bakery.abandon();
    expect(bakery.isCollapsing).toBe(true);
    const bake = bakery.peek(null, 25)!;
    expect(bake.collapsing).toBe(true);
    expect(bake.rise).toBeGreaterThan(0);
  });

  it("deflates over time and then stops", () => {
    const bakery = new Bakery(new Memory());
    bakery.noteProgress(0.6);
    bakery.abandon();
    bakery.tick(COLLAPSE_SECONDS + 0.1);
    expect(bakery.isCollapsing).toBe(false);
    expect(bakery.peek(null, 25)).toBeNull();
  });

  // THE POINT OF THE WHOLE FEATURE. A shelf that also counts what you burned is
  // a scoreboard you will want to hide from.
  it("records absolutely nothing", () => {
    const store = new Memory();
    const bakery = new Bakery(store);
    bakery.noteProgress(0.9);
    bakery.abandon();
    bakery.tick(COLLAPSE_SECONDS + 1);
    expect(bakery.total).toBe(0);
    expect(bakery.loaves).toEqual([]);
    // Nothing was even written to storage.
    expect(store.getItem(SHELF_KEY)).toBeNull();
  });

  it("does not collapse a session that never started", () => {
    const bakery = new Bakery(new Memory());
    bakery.abandon();
    expect(bakery.isCollapsing).toBe(false);
  });

  it("starts the next bake clean", () => {
    const bakery = new Bakery(new Memory());
    bakery.noteProgress(0.8);
    bakery.abandon();
    bakery.bake(25, DAY);
    expect(bakery.isCollapsing).toBe(false);
    expect(bakery.total).toBe(1);
  });
});

describe("the shelf", () => {
  it("survives a restart", () => {
    const store = new Memory();
    new Bakery(store).bake(45, DAY);
    const reloaded = new Bakery(store);
    expect(reloaded.total).toBe(1);
    expect(reloaded.loaves[0]!.kind).toBe("sourdough");
  });

  it("groups by day", () => {
    const bakery = new Bakery(new Memory());
    bakery.bake(25, DAY);
    bakery.bake(25, DAY);
    bakery.bake(25, "2026-08-30");
    expect(bakery.countOn(DAY)).toBe(2);
    expect(bakery.countOn("2026-08-30")).toBe(1);
  });

  it("keeps the newest when it overflows", () => {
    const bakery = new Bakery(new Memory());
    for (let i = 0; i < SHELF_LIMIT + 20; i++) bakery.bake(5, DAY);
    expect(bakery.total).toBe(SHELF_LIMIT);
  });

  it("starts empty rather than throwing on a corrupt shelf", () => {
    const store = new Memory();
    store.setItem(SHELF_KEY, "{{{not json");
    expect(new Bakery(store).total).toBe(0);
  });

  it("drops a loaf it cannot understand and keeps the rest", () => {
    const store = new Memory();
    store.setItem(
      SHELF_KEY,
      JSON.stringify([
        { minutes: 25, day: DAY, kind: "loaf" },
        { nonsense: true },
        { minutes: 25 },
        null,
      ]),
    );
    expect(new Bakery(store).total).toBe(1);
  });

  it("works out the kind when an older file did not store one", () => {
    const store = new Memory();
    store.setItem(SHELF_KEY, JSON.stringify([{ minutes: 90, day: DAY }]));
    expect(new Bakery(store).loaves[0]!.kind).toBe("cottage");
  });

  it("clears only when asked", () => {
    const bakery = new Bakery(new Memory());
    bakery.bake(25, DAY);
    bakery.clear();
    expect(bakery.total).toBe(0);
  });

  it("does not throw when the store is broken", () => {
    const hostile: BakeryStore = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    const bakery = new Bakery(hostile);
    expect(bakery.total).toBe(0);
    expect(() => bakery.bake(25, DAY)).not.toThrow();
  });
});
