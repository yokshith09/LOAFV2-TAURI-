import { describe, it, expect } from "vitest";
import {
  WakeGate,
  isWakeWord,
  stripWakeWord,
  wakePhrases,
  wakeWordsFor,
  normaliseWakeWord,
  WAKE_WORDS,
  DEFAULT_WAKE_WORDS,
  COMMAND_WINDOW_MS,
  MIN_WAKE_LENGTH,
  MAX_WAKE_LENGTH,
} from "../src/voice/wake";
import { parseIntent } from "../src/voice/commands";

/** A clock the test moves by hand; a deadline cannot be tested any other way. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("recognising the wake word", () => {
  it.each(["hey loaf", "Hey Loaf", "ok loaf", "okay loaf", "loaf", "  loaf  "])(
    "hears %s",
    (text) => {
      expect(isWakeWord(text)).toBe(true);
    },
  );

  it.each(["hey", "loafing", "open notepad", ""])("does not hear %s", (text) => {
    expect(isWakeWord(text)).toBe(false);
  });

  it("strips a leading wake word and leaves the command", () => {
    expect(stripWakeWord("hey loaf open notepad")).toBe("open notepad");
    expect(stripWakeWord("loaf go quiet")).toBe("go quiet");
    expect(stripWakeWord("open notepad")).toBe("open notepad");
    expect(stripWakeWord("hey loaf")).toBe("");
  });

  // The longest wake word has to win, or "okay loaf" leaves "loaf" behind.
  it("strips the longest matching wake word", () => {
    expect(stripWakeWord("okay loaf open notepad")).toBe("open notepad");
  });
});

describe("WakeGate", () => {
  it("ignores everything until it is woken", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    const verdict = gate.heard("open notepad");
    expect(verdict.command).toBeNull();
    expect(verdict.awake).toBe(false);
  });

  it("wakes, then acts on the next thing said", () => {
    const c = clock();
    const gate = new WakeGate(c.now);

    const woke = gate.heard("hey loaf");
    expect(woke.command).toBeNull();
    expect(woke.awake).toBe(true);
    expect(woke.justWoke).toBe(true);

    c.tick(1500);
    const acted = gate.heard("open notepad");
    expect(acted.command).toBe("open notepad");
  });

  // A follow-up needs no second wake word: "open Notepad" is usually followed
  // by something else.
  it("re-opens the window after a command instead of closing it", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    expect(gate.heard("open notepad").command).toBe("open notepad");
    expect(gate.isAwake).toBe(true);
    c.tick(2000);
    expect(gate.heard("go quiet").command).toBe("go quiet");
  });

  // Silence is the only thing that closes it. A window extended by anything
  // other than Loaf acting would be an assistant always acting on the room.
  it("closes on silence, however many commands came before", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    gate.heard("open notepad");
    c.tick(2000);
    gate.heard("go quiet");
    c.tick(COMMAND_WINDOW_MS + 1);
    expect(gate.isAwake).toBe(false);
    expect(gate.heard("open notepad").command).toBeNull();
  });

  it("gives a full window after each command, not the remainder", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    c.tick(COMMAND_WINDOW_MS - 500);
    gate.heard("open notepad");
    expect(gate.remainingMs).toBe(COMMAND_WINDOW_MS);
  });

  it("closes the window when nobody follows up", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    c.tick(COMMAND_WINDOW_MS + 1);
    expect(gate.isAwake).toBe(false);
    expect(gate.heard("open notepad").command).toBeNull();
  });

  it("acts right up to the edge of the window", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    c.tick(COMMAND_WINDOW_MS - 1);
    expect(gate.heard("open notepad").command).toBe("open notepad");
  });

  it("does not chirp twice when the wake word is repeated", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    expect(gate.heard("hey loaf").justWoke).toBe(true);
    c.tick(500);
    const again = gate.heard("hey loaf");
    expect(again.justWoke).toBe(false);
    expect(again.awake).toBe(true);
  });

  it("extends nothing but restarts the window on a repeat", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    c.tick(COMMAND_WINDOW_MS - 100);
    gate.heard("hey loaf");
    c.tick(COMMAND_WINDOW_MS - 100);
    expect(gate.isAwake).toBe(true);
  });

  it("acts on a combined phrase and stays open for a follow-up", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    const verdict = gate.heard("hey loaf open notepad");
    expect(verdict.command).toBe("open notepad");
    expect(verdict.awake).toBe(true);
    c.tick(1000);
    expect(gate.heard("go quiet").command).toBe("go quiet");
  });

  it("can be closed early", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    gate.reset();
    expect(gate.isAwake).toBe(false);
    expect(gate.remainingMs).toBe(0);
  });

  it("reports how long is left, never negative", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    gate.heard("hey loaf");
    expect(gate.remainingMs).toBe(COMMAND_WINDOW_MS);
    c.tick(COMMAND_WINDOW_MS * 2);
    expect(gate.remainingMs).toBe(0);
  });

  it("ignores empty and whitespace phrases without waking", () => {
    const c = clock();
    const gate = new WakeGate(c.now);
    expect(gate.heard("").awake).toBe(false);
    expect(gate.heard("   ").awake).toBe(false);
  });
});

describe("the wake words reach the grammar", () => {
  it("offers exactly what it answers to", () => {
    expect(wakePhrases()).toEqual([...WAKE_WORDS]);
  });

  // The wake word itself must NOT be a command, or "hey loaf" alone would do
  // something on its own.
  it.each([...WAKE_WORDS])("does not parse %s as a command", (word) => {
    expect(parseIntent(word)).toBeNull();
  });
});

describe("a wake word of your own", () => {
  it("accepts a reasonable one and cleans it up", () => {
    expect(normaliseWakeWord("  Hey  Biscuit! ")).toBe("hey biscuit");
    expect(normaliseWakeWord("Toast")).toBe("toast");
  });

  // The failure mode of a bad wake word is silent: you say it, nothing
  // happens, and you cannot tell whether the word or the microphone was wrong.
  it("refuses ones that would fail silently", () => {
    expect(normaliseWakeWord("")).toBeNull();
    expect(normaliseWakeWord("a")).toBeNull();
    expect(normaliseWakeWord("!!")).toBeNull();
    expect(normaliseWakeWord("1234")).toBeNull();
    expect(normaliseWakeWord("x".repeat(MAX_WAKE_LENGTH + 1))).toBeNull();
    expect(normaliseWakeWord("hey there my lovely cat")).toBeNull();
  });

  it("enforces its own stated bounds", () => {
    expect(normaliseWakeWord("x".repeat(MIN_WAKE_LENGTH))).not.toBeNull();
    expect(normaliseWakeWord("x".repeat(MIN_WAKE_LENGTH - 1))).toBeNull();
  });

  // Someone who renamed their pet does not want it still answering to "loaf",
  // and leaving both in doubles the chance of a false wake.
  it("replaces the defaults rather than joining them", () => {
    const words = wakeWordsFor("biscuit");
    expect(words).toContain("biscuit");
    expect(words).toContain("hey biscuit");
    expect(words).not.toContain("loaf");
  });

  it("does not double the hey when one was typed", () => {
    expect(wakeWordsFor("hey biscuit")).toEqual(["hey biscuit", "biscuit"]);
  });

  it("falls back to the defaults for anything unusable", () => {
    for (const junk of ["", "  ", "a", null, undefined]) {
      expect(wakeWordsFor(junk as string | null)).toEqual(DEFAULT_WAKE_WORDS);
    }
  });

  it("answers to the custom word and not the old one", () => {
    const gate = new WakeGate(() => 1000, COMMAND_WINDOW_MS, wakeWordsFor("biscuit"));
    expect(gate.heard("hey loaf").awake).toBe(false);
    expect(gate.heard("hey biscuit").awake).toBe(true);
  });

  it("puts the custom word in the grammar", () => {
    expect(wakePhrases("biscuit")).toContain("hey biscuit");
    expect(wakePhrases()).toEqual([...DEFAULT_WAKE_WORDS]);
  });
});

describe("the command window", () => {
  // Ten seconds, not eight: the gap between "he heard me" and "I have thought
  // of what to say" is longer than it feels when you wrote the command list.
  it("is ten seconds", () => {
    expect(COMMAND_WINDOW_MS).toBe(10_000);
  });

  it("still exports the old name for the defaults", () => {
    expect(WAKE_WORDS).toEqual(DEFAULT_WAKE_WORDS);
  });
});
