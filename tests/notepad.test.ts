import { describe, it, expect } from "vitest";
import {
  TaskList,
  forTheWall,
  labelsInUse,
  readLabels,
  normaliseLabel,
  firstLineOf,
  isNoteColour,
  NOTE_COLOURS,
  MAX_BODY_LENGTH,
  MAX_LABELS,
  MAX_TITLE_LENGTH,
  type Task,
} from "../src/tasks/tasks";

/**
 * The notepad half of the notetaker.
 *
 * The old model was one 80-character title and nothing else, so anything that
 * did not fit on a line could not be written down at all. These are the fields
 * that make it a wall of notes rather than a reminder list — body, colour, pin,
 * labels — added to the same `Task` on purpose, so that every file written
 * before they existed still loads with all of its rows.
 *
 * Its own file rather than appended to tasks.test.ts: that one covers the
 * reminder behaviour, which has not changed, and mixing the two would make it
 * unclear which half a failure belongs to. (`notes.test.ts` is taken, by the
 * unrelated pattern-notes module.)
 */

function memoryStore() {
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
}

function fixedStore(contents: string | null) {
  return { getItem: () => contents, setItem: () => {} };
}

/** A complete Task, so a test can vary one field without restating the rest. */
function note(over: Partial<Task> = {}): Task {
  return {
    id: "n1",
    title: "A note",
    priority: "soon",
    dueAt: null,
    done: false,
    createdAt: 1_000,
    body: "",
    colour: "default",
    pinned: false,
    labels: [],
    updatedAt: 1_000,
    ...over,
  };
}

describe("a note, not just a line", () => {
  it("holds a body far longer than a title ever could", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Shopping")!;
    const body = "milk\nbread\n".repeat(200);
    expect(list.edit(t.id, "Shopping", body)).toBe(true);
    expect(list.all[0]!.body).toBe(body);
    expect(list.all[0]!.body.length).toBeGreaterThan(MAX_TITLE_LENGTH);
  });

  it("keeps the newlines, because a list of things is the point", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("List")!;
    list.edit(t.id, "List", "one\ntwo\nthree");
    expect(list.all[0]!.body.split("\n")).toHaveLength(3);
  });

  it("caps a body that has become a document", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Long")!;
    list.edit(t.id, "Long", "x".repeat(MAX_BODY_LENGTH + 5_000));
    expect(list.all[0]!.body.length).toBe(MAX_BODY_LENGTH);
  });

  // A half-written note with a body and no title yet is the single worst thing
  // for a notepad to throw away, which is why `edit` allows what `add` refuses.
  it("keeps a note whose title was cleared but which has a body", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("temp")!;
    expect(list.edit(t.id, "", "the part I actually wrote")).toBe(true);
    expect(list.all[0]!.body).toBe("the part I actually wrote");
    expect(list.all[0]!.title).toBe("");
  });

  it("still refuses to create a blank note", () => {
    const list = new TaskList(memoryStore());
    expect(list.add("   ")).toBe(null);
    expect(list.all).toHaveLength(0);
  });

  it("says nothing happened when the note is not there", () => {
    const list = new TaskList(memoryStore());
    expect(list.edit("nope", "a", "b")).toBe(false);
    expect(list.setColour("nope", "sage")).toBe(false);
    expect(list.togglePin("nope")).toBe(false);
  });
});

describe("colour", () => {
  it("takes one from the palette", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Coloured")!;
    expect(list.setColour(t.id, "sage")).toBe(true);
    expect(list.all[0]!.colour).toBe("sage");
  });

  it("starts with none, which is what most notes stay", () => {
    const list = new TaskList(memoryStore());
    expect(list.add("Plain")!.colour).toBe("default");
  });

  // A free colour picker lets somebody make a note they cannot read, and then
  // the bug report is about Loaf.
  it("is a fixed palette with a no-colour option", () => {
    expect(NOTE_COLOURS).toContain("default");
    expect(NOTE_COLOURS.length).toBeGreaterThan(3);
    expect(isNoteColour("sage")).toBe(true);
    expect(isNoteColour("neon-green")).toBe(false);
    expect(isNoteColour(7)).toBe(false);
  });
});

describe("pinning", () => {
  it("pins and unpins", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Pin me")!;
    list.togglePin(t.id);
    expect(list.all[0]!.pinned).toBe(true);
    list.togglePin(t.id);
    expect(list.all[0]!.pinned).toBe(false);
  });
});

describe("the order notes appear in", () => {
  it("puts pinned cards first, whatever else is true of them", () => {
    const a = note({ id: "a", pinned: true, updatedAt: 1 });
    const b = note({ id: "b", updatedAt: 100 });
    expect(forTheWall([b, a]).map((t) => t.id)).toEqual(["a", "b"]);
  });

  // Every notes app sorts this way and no task list does. Priority still
  // decides what the PET shows; the wall is something you scan.
  it("then the most recently touched, not the highest priority", () => {
    const older = note({ id: "older", priority: "now", updatedAt: 10 });
    const newer = note({ id: "newer", priority: "whenever", updatedAt: 20 });
    expect(forTheWall([older, newer]).map((t) => t.id)).toEqual(["newer", "older"]);
  });

  it("sinks finished notes below unfinished ones", () => {
    const done = note({ id: "done", done: true, updatedAt: 99 });
    const open = note({ id: "open", updatedAt: 1 });
    expect(forTheWall([done, open]).map((t) => t.id)).toEqual(["open", "done"]);
  });

  it("keeps a pinned finished note above an unpinned unfinished one", () => {
    const pinnedDone = note({ id: "pd", pinned: true, done: true, updatedAt: 1 });
    const open = note({ id: "o", updatedAt: 50 });
    expect(forTheWall([open, pinnedDone]).map((t) => t.id)).toEqual(["pd", "o"]);
  });

  it("does not modify the list it was handed", () => {
    const given = [note({ id: "a", updatedAt: 1 }), note({ id: "b", updatedAt: 2 })];
    forTheWall(given);
    expect(given.map((t) => t.id)).toEqual(["a", "b"]);
  });

  // A MOVING clock, because with a frozen one both notes share an updatedAt
  // and "most recently touched" has nothing to order them by. The first version
  // of this test froze it and blamed the sort.
  it("brings an edited note to the front", () => {
    let clock = 1_000;
    const first = new TaskList(memoryStore(), { now: () => (clock += 1_000) });
    const a = first.add("first")!;
    const b = first.add("second")!;
    expect(first.wall()[0]!.id).toBe(b.id);

    const later = new TaskList(fixedStore(JSON.stringify(first.all)), { now: () => 50_000 });
    later.edit(a.id, "first, edited", "");
    expect(later.wall()[0]!.id).toBe(a.id);
  });
});

describe("labels", () => {
  it("adds one and keeps it", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Tagged")!;
    expect(list.addLabel(t.id, "work")).toBe(true);
    expect(list.all[0]!.labels).toEqual(["work"]);
  });

  it("treats another capitalisation as the same label", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Tagged")!;
    list.addLabel(t.id, "Work");
    list.addLabel(t.id, "work");
    expect(list.all[0]!.labels).toEqual(["Work"]);
  });

  it("refuses a blank label rather than storing one", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Tagged")!;
    expect(list.addLabel(t.id, "   ")).toBe(false);
    expect(list.all[0]!.labels).toEqual([]);
  });

  it("stops where the chips stop fitting on a card", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Many")!;
    for (let i = 0; i < MAX_LABELS + 4; i += 1) list.addLabel(t.id, `label${i}`);
    expect(list.all[0]!.labels).toHaveLength(MAX_LABELS);
  });

  it("removes one, in any capitalisation", () => {
    const list = new TaskList(memoryStore());
    const t = list.add("Tagged")!;
    list.addLabel(t.id, "Work");
    expect(list.removeLabel(t.id, "WORK")).toBe(true);
    expect(list.all[0]!.labels).toEqual([]);
  });

  // Re-adding a label somebody already has must not bump the card to the front
  // of the wall, or a no-op reorders their screen.
  it("does not touch the note when the label is already there", () => {
    const list = new TaskList(memoryStore(), { now: () => 1_000 });
    const t = list.add("Tagged")!;
    list.addLabel(t.id, "work");
    const was = list.all[0]!.updatedAt;

    const later = new TaskList(fixedStore(JSON.stringify(list.all)), { now: () => 9_000 });
    later.addLabel(t.id, "WORK");
    expect(later.all[0]!.updatedAt).toBe(was);
  });

  it("lists what is in use, most used first", () => {
    const list = new TaskList(memoryStore());
    const a = list.add("a")!;
    const b = list.add("b")!;
    list.addLabel(a.id, "work");
    list.addLabel(b.id, "work");
    list.addLabel(b.id, "home");
    expect(list.labels()).toEqual(["work", "home"]);
  });

  it("filters to one label, case-insensitively", () => {
    const list = new TaskList(memoryStore());
    const a = list.add("a")!;
    list.add("b");
    list.addLabel(a.id, "work");
    expect(list.withLabel("WORK").map((t) => t.title)).toEqual(["a"]);
  });

  it("finds nothing for a label nobody uses", () => {
    const list = new TaskList(memoryStore());
    list.add("a");
    expect(list.withLabel("ghost")).toEqual([]);
    expect(labelsInUse([])).toEqual([]);
  });

  it("drops rubbish from a hand-edited file rather than coercing it", () => {
    expect(readLabels(["ok", 7, null, "", "  ", "fine"])).toEqual(["ok", "fine"]);
    expect(readLabels("not an array")).toEqual([]);
    expect(readLabels(undefined)).toEqual([]);
  });

  it("tidies whitespace inside a label", () => {
    expect(normaliseLabel("  two   words  ")).toBe("two words");
  });
});

/**
 * The compatibility contract — the same one `stats.json` has: a missing field is
 * a default, never a dropped row. Anyone who had tasks before this change keeps
 * every one of them.
 */
describe("a file written before notes had bodies", () => {
  const older = JSON.stringify([
    {
      id: "t1",
      title: "Ring the bank",
      priority: "now",
      dueAt: null,
      done: false,
      createdAt: 50,
    },
  ]);

  it("loads the task as a plain uncoloured card", () => {
    const list = new TaskList(fixedStore(older));
    expect(list.all).toHaveLength(1);
    const t = list.all[0]!;
    expect(t.title).toBe("Ring the bank");
    expect(t.priority).toBe("now");
    expect(t.body).toBe("");
    expect(t.colour).toBe("default");
    expect(t.pinned).toBe(false);
    expect(t.labels).toEqual([]);
  });

  // Falling back to `now` would make every old note claim to be the newest and
  // scramble the order of somebody's whole wall on first launch.
  it("dates it from when it was made, not from now", () => {
    const list = new TaskList(fixedStore(older), { now: () => 9_999_999 });
    expect(list.all[0]!.updatedAt).toBe(50);
  });

  it("ignores a colour that is not in the palette", () => {
    const odd = JSON.stringify([{ id: "t1", title: "x", createdAt: 1, colour: "neon-green" }]);
    expect(new TaskList(fixedStore(odd)).all[0]!.colour).toBe("default");
  });

  it("ignores a body that is not a string", () => {
    const odd = JSON.stringify([{ id: "t1", title: "x", createdAt: 1, body: { not: "text" } }]);
    expect(new TaskList(fixedStore(odd)).all[0]!.body).toBe("");
  });
});

/**
 * A note may be just a body, with no title — the composer's title box is not
 * required, the same way Google Keep's is not. `TaskList.add` still refuses an
 * empty title (a blank new row is litter), so the caller — `applyTaskCommand`
 * in main.ts — falls back to this when there is a body and no typed title.
 */
describe("firstLineOf: a title for a note that never got one", () => {
  it("takes the first line", () => {
    expect(firstLineOf("Call the bank\nabout the overdraft")).toBe("Call the bank");
  });

  it("falls through leading blank lines", () => {
    // Pasting a body that starts with a blank line must not produce an
    // empty-looking card sitting in the middle of the wall.
    expect(firstLineOf("\n\n  \nActual first line\nrest")).toBe("Actual first line");
  });

  it("is empty for a body that is nothing but blank lines", () => {
    expect(firstLineOf("\n\n   \n")).toBe("");
  });

  it("is empty for a completely empty body", () => {
    expect(firstLineOf("")).toBe("");
  });

  it("trims the line it takes", () => {
    expect(firstLineOf("   spaced out   \nrest")).toBe("spaced out");
  });

  it("caps at the same length as any other title", () => {
    expect(firstLineOf("x".repeat(200))).toHaveLength(MAX_TITLE_LENGTH);
  });

  it("is a single line even when the source line has one already", () => {
    expect(firstLineOf("just one line")).toBe("just one line");
  });
});
