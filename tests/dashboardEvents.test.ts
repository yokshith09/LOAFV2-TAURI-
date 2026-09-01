import { describe, it, expect } from "vitest";
import {
  isCommand,
  isTaskCommand,
  COMMANDS,
  COMMAND_EVENT,
  STATS_CHANGED_EVENT,
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
});
