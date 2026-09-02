import { describe, it, expect } from "vitest";
import {
  spokenPhrases,
  SPOKEN_SESSION_MINUTES,
  SESSION_BOUNDS,
  CONFIRMATION_PHRASES,
} from "../src/voice/phrases";
import { parseIntent, isAffirmative } from "../src/voice/commands";

const CONFIRMATIONS = new Set(CONFIRMATION_PHRASES);

describe("the spoken vocabulary", () => {
  // The recogniser can only hear what is in this list, so a phrase the parser
  // then refuses is Loaf listening carefully and doing nothing.
  it("every command phrase parses to a real intent", () => {
    for (const phrase of spokenPhrases()) {
      if (CONFIRMATIONS.has(phrase)) continue;
      expect(parseIntent(phrase), `"${phrase}" was heard but not understood`).not.toBeNull();
    }
  });

  it("every confirmation answer is classified, either way", () => {
    expect(CONFIRMATION_PHRASES.filter(isAffirmative).length).toBeGreaterThan(0);
    expect(CONFIRMATION_PHRASES.filter((p) => !isAffirmative(p)).length).toBeGreaterThan(0);
  });

  // A "no" that is not heard as a no is the dangerous half: it would leave a
  // destructive confirmation open rather than declining it.
  it.each(["no", "cancel", "stop"])("treats %s as a refusal", (word) => {
    expect(isAffirmative(word)).toBe(false);
  });

  it("hears the session lengths it offers, as the length it offered", () => {
    for (const m of SPOKEN_SESSION_MINUTES) {
      expect(parseIntent(`start a ${m} minute focus session`)).toEqual({
        kind: "focus.start",
        minutes: m,
      });
      expect(parseIntent(`focus for ${m} minutes`)).toEqual({
        kind: "focus.start",
        minutes: m,
      });
    }
  });

  it("offers no length the timer would refuse", () => {
    for (const m of SPOKEN_SESSION_MINUTES) {
      expect(m).toBeGreaterThanOrEqual(SESSION_BOUNDS.min);
      expect(m).toBeLessThanOrEqual(SESSION_BOUNDS.max);
    }
  });

  // A repeated phrase fails constraint compilation on some Windows builds
  // rather than being harmlessly ignored.
  it("has no duplicates", () => {
    const list = spokenPhrases();
    expect(new Set(list).size).toBe(list.length);
  });

  // speech.rs refuses an empty list rather than falling back to the built-in
  // dictation grammar, which is the cloud. If this ever returned nothing, the
  // microphone would go quiet — which is the correct failure, but it should
  // never be reachable by accident.
  it("is never empty", () => {
    expect(spokenPhrases().length).toBeGreaterThan(10);
  });

  it("contains no free-text task phrases", () => {
    // A closed vocabulary cannot hold a task title you have not said yet.
    // Anything matching here would be a phrase that only ever half-works.
    for (const phrase of spokenPhrases()) {
      expect(parseIntent(phrase)?.kind).not.toBe("task.add");
    }
  });

  it("still asks before anything destructive", () => {
    for (const phrase of ["reset today's stats", "forget all site data"]) {
      expect(spokenPhrases()).toContain(phrase);
      expect(parseIntent(phrase)).toMatchObject({ confirm: true });
    }
  });
});

describe("program names in the vocabulary", () => {
  const APPS = ["Notepad", "Google Chrome", "Visual Studio Code"];

  // This is the whole reason the app list is read at all: a closed grammar
  // cannot contain "Notepad" unless something put the word in it.
  it("offers open and close for each program", () => {
    const said = spokenPhrases(APPS);
    expect(said).toContain("open notepad");
    expect(said).toContain("close notepad");
    expect(said).toContain("open google chrome");
  });

  it("parses every program phrase it offers", () => {
    for (const phrase of spokenPhrases(APPS)) {
      if (!phrase.startsWith("open ") && !phrase.startsWith("close ")) continue;
      expect(parseIntent(phrase), phrase).not.toBeNull();
    }
  });

  it("still hears Loaf's own windows as windows, not programs", () => {
    // A machine with a program called Closet must not shadow the closet.
    const said = spokenPhrases(["Closet", "Dashboard"]);
    expect(said).toContain("open the closet");
    expect(parseIntent("open the closet")).toEqual({ kind: "open", what: "closet" });
  });

  it("leaves out names nobody would say", () => {
    // Compared against the base list rather than "nothing starts with open",
    // because Loaf's own windows are opened by name too.
    const unsayable = ["X", "1234", "A Really Very Long Program Name With Too Many Words"];
    expect(spokenPhrases(unsayable)).toEqual(spokenPhrases([]));
  });

  it("adds nothing when there are no programs", () => {
    expect(spokenPhrases()).toEqual(spokenPhrases([]));
  });
});
