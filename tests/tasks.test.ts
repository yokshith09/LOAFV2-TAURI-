import { describe, it, expect } from "vitest";
import {
  TaskList,
  normaliseTitle,
  isPriority,
  PRIORITIES,
  PRIORITY_LABELS,
  MAX_VISIBLE,
  MAX_TITLE_LENGTH,
  TASKS_KEY,
  type TaskStore,
} from "../src/tasks/tasks";

class Memory implements TaskStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advanceMinutes: (m: number) => (t += m * 60_000) };
}

const fresh = (c = clock(), store = new Memory()) =>
  ({ list: new TaskList(store, { now: c.now }), store, c });

describe("normaliseTitle", () => {
  it("collapses whitespace and trims", () => {
    expect(normaliseTitle("  buy   bread \n")).toBe("buy bread");
  });

  it("refuses to make a task out of nothing", () => {
    expect(normaliseTitle("   ")).toBe("");
  });

  it("cuts a document down to a task", () => {
    expect(normaliseTitle("x".repeat(500)).length).toBe(MAX_TITLE_LENGTH);
  });
});

describe("adding", () => {
  it("adds a task with a priority", () => {
    const { list } = fresh();
    const t = list.add("write the spec", "now");
    expect(t?.title).toBe("write the spec");
    expect(t?.priority).toBe("now");
    expect(t?.done).toBe(false);
  });

  it("defaults to soon", () => {
    const { list } = fresh();
    expect(list.add("something")?.priority).toBe("soon");
  });

  it("refuses a blank title rather than storing an empty row", () => {
    const { list } = fresh();
    expect(list.add("   ")).toBeNull();
    expect(list.all).toHaveLength(0);
  });

  it("gives every task a distinct id, even in the same millisecond", () => {
    const { list } = fresh();
    list.add("one");
    list.add("two");
    const ids = list.all.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("ordering", () => {
  it("puts the urgent first", () => {
    const { list } = fresh();
    list.add("whenever one", "whenever");
    list.add("now one", "now");
    list.add("soon one", "soon");
    expect(list.ordered().map((t) => t.priority)).toEqual(["now", "soon", "whenever"]);
  });

  // Something written three days ago and still not done should rise past this
  // morning's, not sink under it.
  it("puts the oldest first within a priority", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("first", "now");
    c.advanceMinutes(60);
    list.add("second", "now");
    expect(list.ordered().map((t) => t.title)).toEqual(["first", "second"]);
  });

  it("hides finished tasks from the outstanding list", () => {
    const { list } = fresh();
    const t = list.add("done thing")!;
    list.complete(t.id);
    expect(list.outstanding).toHaveLength(0);
    expect(list.all).toHaveLength(1);
  });

  it("never shows the pet more than a glance's worth", () => {
    const { list } = fresh();
    for (let i = 0; i < 10; i++) list.add(`task ${i}`);
    expect(list.visible()).toHaveLength(MAX_VISIBLE);
  });
});

describe("changing a task", () => {
  it("completes and reopens", () => {
    const { list } = fresh();
    const t = list.add("thing")!;
    expect(list.complete(t.id)).toBe(true);
    expect(list.all[0]!.done).toBe(true);
    expect(list.reopen(t.id)).toBe(true);
    expect(list.all[0]!.done).toBe(false);
  });

  it("changes priority", () => {
    const { list } = fresh();
    const t = list.add("thing", "whenever")!;
    list.setPriority(t.id, "now");
    expect(list.all[0]!.priority).toBe("now");
  });

  it("removes", () => {
    const { list } = fresh();
    const t = list.add("thing")!;
    expect(list.remove(t.id)).toBe(true);
    expect(list.all).toHaveLength(0);
  });

  it("reports honestly when the task is not there", () => {
    const { list } = fresh();
    expect(list.complete("nope")).toBe(false);
    expect(list.remove("nope")).toBe(false);
    expect(list.setPriority("nope", "now")).toBe(false);
  });

  it("clears finished tasks only when asked", () => {
    const { list } = fresh();
    const a = list.add("a")!;
    list.add("b");
    list.complete(a.id);
    expect(list.clearDone()).toBe(1);
    expect(list.all.map((t) => t.title)).toEqual(["b"]);
  });
});

describe("timers", () => {
  it("does not fire before it is due", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("bread", "now", 30);
    c.advanceMinutes(29);
    expect(list.due()).toHaveLength(0);
  });

  it("fires when it is due", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("bread", "now", 30);
    c.advanceMinutes(30);
    expect(list.due().map((t) => t.title)).toEqual(["bread"]);
  });

  it("fires once, not on every tick after", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("bread", "now", 30);
    c.advanceMinutes(31);
    expect(list.due()).toHaveLength(1);
    c.advanceMinutes(5);
    expect(list.due()).toHaveLength(0);
  });

  // The bread being ready is not the same as you having taken it out.
  it("does not complete the task for you", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("bread", "now", 10);
    c.advanceMinutes(11);
    list.due();
    expect(list.all[0]!.done).toBe(false);
  });

  it("adds and clears a timer after the fact", () => {
    const c = clock();
    const { list } = fresh(c);
    const t = list.add("thing")!;
    expect(list.all[0]!.dueAt).toBeNull();
    list.setTimer(t.id, 15);
    expect(list.all[0]!.dueAt).not.toBeNull();
    list.setTimer(t.id, 0);
    expect(list.all[0]!.dueAt).toBeNull();
  });

  it("ignores a nonsense timer rather than setting a due date in the past", () => {
    const { list } = fresh();
    const t = list.add("thing", "now", -5)!;
    expect(t.dueAt).toBeNull();
  });

  it("never fires for a finished task", () => {
    const c = clock();
    const { list } = fresh(c);
    const t = list.add("bread", "now", 10)!;
    list.complete(t.id);
    c.advanceMinutes(11);
    expect(list.due()).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("survives a restart", () => {
    const store = new Memory();
    const c = clock();
    new TaskList(store, { now: c.now }).add("remember me", "now", 20);
    const reloaded = new TaskList(store, { now: c.now });
    expect(reloaded.all.map((t) => t.title)).toEqual(["remember me"]);
    expect(reloaded.all[0]!.priority).toBe("now");
    expect(reloaded.all[0]!.dueAt).not.toBeNull();
  });

  it("starts empty rather than throwing on a corrupt file", () => {
    const store = new Memory();
    store.setItem(TASKS_KEY, "{{{not json");
    expect(new TaskList(store).all).toEqual([]);
  });

  it("drops a row it cannot understand and keeps the rest", () => {
    const store = new Memory();
    store.setItem(
      TASKS_KEY,
      JSON.stringify([{ title: "good" }, { nonsense: true }, "also nonsense", null]),
    );
    expect(new TaskList(store).all.map((t) => t.title)).toEqual(["good"]);
  });

  it("fills in what an older file did not have", () => {
    const store = new Memory();
    store.setItem(TASKS_KEY, JSON.stringify([{ title: "old task" }]));
    const t = new TaskList(store).all[0]!;
    expect(t.priority).toBe("soon");
    expect(t.dueAt).toBeNull();
    expect(t.done).toBe(false);
    expect(t.id.length).toBeGreaterThan(0);
  });

  it("does not throw when the store is broken", () => {
    const hostile: TaskStore = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    const list = new TaskList(hostile);
    expect(list.all).toEqual([]);
    expect(() => list.add("thing")).not.toThrow();
  });
});

describe("the shape of the feature", () => {
  it("has a label for every priority", () => {
    for (const p of PRIORITIES) expect(PRIORITY_LABELS[p]).toBeTruthy();
  });

  it("validates a priority off the wire", () => {
    expect(isPriority("now")).toBe(true);
    expect(isPriority("urgent")).toBe(false);
    expect(isPriority(1)).toBe(false);
  });

  // Three bands, not five. A priority scale you have to think about is a
  // second task.
  it("keeps the scale small enough to pick from without thinking", () => {
    expect(PRIORITIES).toHaveLength(3);
  });
});

describe("several timers coming up at once", () => {
  // The bug this guards: the caller said the first and stopped, but due()
  // clears the timer on every ready task — so a second reminder due in the
  // same minute was silently swallowed. The worst possible failure for a
  // feature whose only job is to tell you a thing at a time you chose.
  it("reports every task that is ready, not just the first", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("bread", "now", 10);
    list.add("call back", "now", 10);
    list.add("later thing", "now", 60);
    c.advanceMinutes(11);
    const ready = list.due();
    expect(ready.map((t) => t.title).sort()).toEqual(["bread", "call back"]);
  });

  it("clears every one of them, so none fires twice", () => {
    const c = clock();
    const { list } = fresh(c);
    list.add("a", "now", 5);
    list.add("b", "now", 5);
    c.advanceMinutes(6);
    expect(list.due()).toHaveLength(2);
    c.advanceMinutes(5);
    expect(list.due()).toHaveLength(0);
  });
});
