import { describe, it, expect } from "vitest";
import { widen, parseIntent } from "../src/voice/commands";

/**
 * The widening layer: strip politeness, fold synonyms, and let the intent rules
 * that already exist see the sentence underneath.
 *
 * The rules themselves are unchanged. That is the property these tests are
 * really protecting — the first version of this list rewrote two phrases the
 * rules already handled, and four passing tests went red immediately.
 */

const NOW = new Date("2026-09-08T09:00:00");

describe("politeness no longer stops a command working", () => {
  // Every one of these was heard perfectly and then did nothing, because the
  // rule wanted "start focus" and got "could you please start a focus timer".
  const polite: [string, string][] = [
    ["could you please start a focus session", "focus.start"],
    ["would you start a focus session", "focus.start"],
    ["can you start a focus session for me", "focus.start"],
    ["please start a focus session", "focus.start"],
    ["i want you to start a focus session", "focus.start"],
    ["i'd like to start a focus session", "focus.start"],
    ["just start a focus session", "focus.start"],
    ["go ahead and start a focus session", "focus.start"],
    ["um start a focus session", "focus.start"],
  ];

  for (const [said, kind] of polite) {
    it(`understands "${said}"`, () => {
      expect(parseIntent(said, NOW)?.kind).toBe(kind);
    });
  }
});

describe("other words for the same act", () => {
  const paraphrases: [string, string][] = [
    ["kick off a focus session", "focus.start"],
    ["fire up a focus session", "focus.start"],
    ["spin up a pomodoro", "focus.start"],
    ["kick start a focus session", "focus.start"],
  ];

  for (const [said, kind] of paraphrases) {
    it(`understands "${said}"`, () => {
      expect(parseIntent(said, NOW)?.kind).toBe(kind);
    });
  }

  it("folds pomodoro onto focus", () => {
    expect(widen("start a pomodoro")).toContain("focus");
  });

  it("maps a note phrasing nobody wrote a rule for", () => {
    expect(parseIntent("jot down buy milk", NOW)?.kind).toBe("task.add");
  });
});

describe("what it deliberately does not do", () => {
  // Deliberately NOT fuzzy. A near-miss that runs the wrong command is worse
  // than a miss that says it did not understand — the same rule best_match
  // follows for program names.
  it("does not guess at a word it does not know", () => {
    expect(parseIntent("commence a focus session", NOW)).toBeNull();
  });

  it("leaves a sentence with nothing in it alone", () => {
    expect(parseIntent("please", NOW)).toBeNull();
    expect(parseIntent("um", NOW)).toBeNull();
    expect(parseIntent("could you please", NOW)).toBeNull();
  });

  // "can" is only stripped as part of "can you". It is a noun on its own.
  it("does not eat a word that carries meaning", () => {
    expect(widen("open the can")).toContain("can");
  });
});

describe("it cannot change what an existing rule means", () => {
  /**
   * THE PROPERTY THIS WHOLE LAYER RESTS ON.
   *
   * The first version of the synonym list mapped "how long have i been" and
   * "where did my time go" to "screen time", on the reasoning that no rule
   * looked for them. Rules already did, and the rewrite stopped those rules
   * matching. These are the phrasings that went red.
   */
  const alreadyWorked: [string, string][] = [
    ["how long have I been at it", "report.today"],
    ["where did my time go", "report.today"],
    ["show me my screen time", "open"],
    ["start a focus session for 25 minutes", "focus.start"],
    ["stop the focus session", "focus.stop"],
    ["remind me to call Priya", "task.add"],
    ["reset today", "reset.today"],
  ];

  for (const [said, kind] of alreadyWorked) {
    it(`still understands "${said}"`, () => {
      expect(parseIntent(said, NOW)?.kind).toBe(kind);
    });
  }

  it("keeps the number in a request that carries one", () => {
    const intent = parseIntent("could you please start a focus session for 25 minutes", NOW);
    expect(intent).toEqual({ kind: "focus.start", minutes: 25 });
  });

  it("keeps the words of a note rather than folding them", () => {
    const intent = parseIntent("please remind me to buy bread", NOW);
    expect(JSON.stringify(intent)).toContain("bread");
  });
});

describe("widen itself", () => {
  it("lower-cases", () => {
    expect(widen("START FOCUS")).toBe("start focus");
  });

  it("is safe to run twice", () => {
    const once = widen("could you please kick off a pomodoro");
    expect(widen(once)).toBe(once);
  });

  it("never returns undefined for odd input", () => {
    expect(typeof widen("")).toBe("string");
    expect(typeof widen("!!!")).toBe("string");
    expect(typeof widen("🍞")).toBe("string");
  });
});
