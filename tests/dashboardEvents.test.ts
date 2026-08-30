import { describe, it, expect } from "vitest";
import {
  isCommand,
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
