import { describe, it, expect } from "vitest";
import {
  isCommand,
  isTaskCommand,
  isNoteView,
  isNoteViewList,
  COMMANDS,
  COMMAND_EVENT,
  STATS_CHANGED_EVENT,
  type NoteView,
} from "../src/dashboard/events";

describe("the command channel between the two windows", () => {
  it("accepts every command the dashboard can render", () => {
    // The dashboard's buttons and the companion's switch are written in
    // different files; this is what stops them drifting apart silently.
    for (const c of COMMANDS) expect(isCommand(c)).toBe(true);
  });

  it("rejects anything else", () => {
    // The payload crosses a window boundary, so it is untrusted input even
    // though both ends are ours.
    for (const junk of ["", "quit", "reset ", null, 7, {}, ["reset"]]) {
      expect(isCommand(junk)).toBe(false);
    }
  });

  it("keeps the two event names distinct", () => {
    // They travel in opposite directions on one bus. If they were ever equal,
    // the companion's own "saved" broadcast would come straight back to it as a
    // command and loop.
    expect(COMMAND_EVENT).not.toBe(STATS_CHANGED_EVENT);
  });
});

describe("the dashboard's own entry points to the rest of the app", () => {
  // These exist because the tray icon is not a reliable way in: Windows files a
  // new one into a hidden overflow flyout, which left the closet and the focus
  // timer reachable from nowhere the user could find.
  it.each(["open:closet", "open:focus", "open:sounds", "open:packs"])(
    "accepts %s",
    (cmd) => {
      expect(isCommand(cmd)).toBe(true);
    },
  );

  it("still refuses anything not on the list", () => {
    for (const bad of ["open:", "open:anything", "open", "quit", "exec:rm", ""]) {
      expect(isCommand(bad)).toBe(false);
    }
  });
});

describe("support links", () => {
  // They open in the browser rather than posting from Loaf. See FEEDBACK_URL.
  it.each(["open:star", "open:feedback"])("accepts %s", (cmd) => {
    expect(isCommand(cmd)).toBe(true);
  });
});

describe("sending him to sleep", () => {
  it("accepts sleep and wake", () => {
    expect(isCommand("sleep")).toBe(true);
    expect(isCommand("wake")).toBe(true);
  });
});

describe("task commands", () => {
  it("accepts adding a task", () => {
    expect(isTaskCommand({ kind: "task", action: "add", title: "x", priority: "now" })).toBe(true);
  });

  // A note may be just a body, with no title — the composer's title box is
  // not required. See firstLineOf in tasks/tasks.ts.
  it("accepts adding with a body and no title", () => {
    expect(isTaskCommand({ kind: "task", action: "add", body: "just a body" })).toBe(true);
  });

  it("accepts ticking and removing", () => {
    expect(isTaskCommand({ kind: "task", action: "done", id: "0" })).toBe(true);
    expect(isTaskCommand({ kind: "task", action: "remove", id: "2" })).toBe(true);
  });

  it("refuses anything else off the wire", () => {
    for (const bad of [
      null,
      "task",
      { kind: "task" },
      { kind: "task", action: "drop-everything" },
      { kind: "command", action: "add" },
      { kind: "task", action: "add", title: 42 },
      { kind: "task", action: "add", minutes: "soon" },
    ]) {
      expect(isTaskCommand(bad)).toBe(false);
    }
  });

  /**
   * The Notes wall's own actions, addressed by a REAL id rather than the
   * index `done`/`remove` above carry. See the doc comment on TaskCommand for
   * why those are not the same trust question.
   */
  describe("note actions", () => {
    it("accepts editing a note's title and body together", () => {
      expect(
        isTaskCommand({ kind: "task", action: "note-edit", id: "n1", title: "t", body: "b" }),
      ).toBe(true);
    });

    it("accepts a colour change", () => {
      expect(isTaskCommand({ kind: "task", action: "note-colour", id: "n1", colour: "sage" })).toBe(
        true,
      );
    });

    it("accepts pinning, archiving and deleting by id", () => {
      expect(isTaskCommand({ kind: "task", action: "note-pin", id: "n1" })).toBe(true);
      expect(isTaskCommand({ kind: "task", action: "note-done", id: "n1" })).toBe(true);
      expect(isTaskCommand({ kind: "task", action: "note-remove", id: "n1" })).toBe(true);
    });

    it("accepts adding and removing a label", () => {
      expect(
        isTaskCommand({ kind: "task", action: "note-label-add", id: "n1", label: "work" }),
      ).toBe(true);
      expect(
        isTaskCommand({ kind: "task", action: "note-label-remove", id: "n1", label: "work" }),
      ).toBe(true);
    });

    it("refuses the wrong type for any of the new fields", () => {
      for (const bad of [
        { kind: "task", action: "note-edit", id: "n1", body: 7 },
        { kind: "task", action: "note-colour", id: "n1", colour: 7 },
        { kind: "task", action: "note-label-add", id: "n1", label: 7 },
        { kind: "task", action: "note-pin", id: 7 },
      ]) {
        expect(isTaskCommand(bad)).toBe(false);
      }
    });
  });
});

/**
 * The Notes wall's own broadcast — every note, in full, unlike the tiny
 * `tasks` list, which is never validated at all (see page.ts). A note's
 * colour and labels reach straight into a class attribute and chip text, so a
 * shape mistake here is worth catching before it becomes a blank tab.
 */
describe("NoteView, the Notes wall's broadcast", () => {
  const note = (over: Partial<NoteView> = {}): NoteView => ({
    id: "n1",
    title: "A note",
    body: "",
    priority: "soon",
    colour: "default",
    pinned: false,
    done: false,
    labels: [],
    minutesLeft: null,
    ...over,
  });

  it("accepts a complete, well-formed note", () => {
    expect(isNoteView(note())).toBe(true);
  });

  it("accepts every priority and every colour in the palette", () => {
    for (const priority of ["now", "soon", "whenever"] as const) {
      expect(isNoteView(note({ priority }))).toBe(true);
    }
    for (const colour of ["default", "butter", "rose", "sage", "sky", "lilac", "clay"] as const) {
      expect(isNoteView(note({ colour }))).toBe(true);
    }
  });

  it("accepts a timer or none", () => {
    expect(isNoteView(note({ minutesLeft: 5 }))).toBe(true);
    expect(isNoteView(note({ minutesLeft: null }))).toBe(true);
  });

  it("refuses a colour outside the fixed palette", () => {
    // The whole reason the palette is fixed rather than free text: every name
    // in it is chosen to stay legible, and this is what stops a stray string
    // from becoming a card nobody can read.
    expect(isNoteView(note({ colour: "neon-green" as never }))).toBe(false);
  });

  it("refuses a priority outside the three the app understands", () => {
    expect(isNoteView(note({ priority: "urgent" as never }))).toBe(false);
  });

  it("refuses labels that are not all strings", () => {
    expect(isNoteView({ ...note(), labels: ["ok", 7] })).toBe(false);
  });

  it("refuses anything missing a required field", () => {
    for (const key of ["id", "title", "body", "priority", "colour", "pinned", "done", "labels"]) {
      const broken = { ...note() } as Record<string, unknown>;
      delete broken[key];
      expect(isNoteView(broken)).toBe(false);
    }
  });

  it("refuses non-objects outright", () => {
    for (const bad of [null, undefined, "note", 7, []]) {
      expect(isNoteView(bad)).toBe(false);
    }
  });

  describe("a whole wall of them", () => {
    it("accepts an empty wall and a wall of many", () => {
      expect(isNoteViewList([])).toBe(true);
      expect(isNoteViewList([note({ id: "a" }), note({ id: "b" })])).toBe(true);
    });

    it("refuses the list if even one note in it is malformed", () => {
      // The failure mode this guards against: a broadcast where every note but
      // one is fine renders as a blank tab rather than a wall missing one card,
      // because a `.map` over a bad shape throws. Refuse the whole thing and
      // let the caller keep the last good copy instead.
      expect(isNoteViewList([note(), { not: "a note" }])).toBe(false);
    });

    it("refuses anything that is not an array", () => {
      expect(isNoteViewList(note())).toBe(false);
      expect(isNoteViewList(null)).toBe(false);
    });
  });
});
