import { describe, it, expect } from "vitest";
import {
  parseIntent,
  minutesIn,
  percentIn,
  needsConfirmation,
  acknowledge,
  isAffirmative,
  EXAMPLE_COMMANDS,
  PRIORITY_WORDS,
  KNOWN_PRIORITIES,
  DEFAULT_SESSION_MINUTES,
  MAX_SESSION_MINUTES,
} from "../src/voice/commands";

describe("minutesIn", () => {
  it.each([
    ["25 minutes", 25],
    ["for 5 mins", 5],
    ["45", 45],
  ])("reads digits in %s", (text, expected) => {
    expect(minutesIn(text)).toBe(expected);
  });

  // A recogniser hands back "twenty five" as often as "25".
  it.each([
    ["twenty five minutes", 25],
    ["ten minutes", 10],
    ["forty five minutes", 45],
    ["fifteen mins", 15],
  ])("reads words in %s", (text, expected) => {
    expect(minutesIn(text)).toBe(expected);
  });

  it.each([
    ["half an hour", 30],
    ["an hour", 60],
    ["2 hours", 120],
    ["quarter of an hour", 15],
  ])("converts %s rather than refusing it", (text, expected) => {
    expect(minutesIn(text)).toBe(expected);
  });

  it("returns null when there is no number", () => {
    expect(minutesIn("start a focus session")).toBeNull();
  });
});

describe("focus sessions", () => {
  it.each([
    "start a 25 minute focus session",
    "focus for 25 minutes",
    "let's do a 25 minute session",
    "begin a twenty five minute focus",
  ])("understands %s", (text) => {
    expect(parseIntent(text)).toEqual({ kind: "focus.start", minutes: 25 });
  });

  it("uses the default when no length is given", () => {
    expect(parseIntent("start a focus session")).toEqual({
      kind: "focus.start",
      minutes: DEFAULT_SESSION_MINUTES,
    });
  });

  // A named length the timer cannot accept is a misheard number far more often
  // than a real request.
  it("refuses a length outside what the timer takes", () => {
    expect(parseIntent(`start a ${MAX_SESSION_MINUTES + 60} minute focus session`)).toBeNull();
    expect(parseIntent("focus for 0 minutes")).toBeNull();
  });

  it.each(["stop the focus session", "cancel my session", "end the timer"])(
    "understands %s",
    (text) => {
      expect(parseIntent(text)).toEqual({ kind: "focus.stop" });
    },
  );
});

describe("tasks", () => {
  it("adds a task with the words you used", () => {
    expect(parseIntent("add a task: write the spec")).toEqual({
      kind: "task.add",
      title: "write the spec",
      priority: "soon",
      minutes: null,
    });
  });

  it("understands a reminder with a timer", () => {
    expect(parseIntent("remind me to call the bank in 20 minutes")).toEqual({
      kind: "task.add",
      title: "call the bank",
      priority: "soon",
      minutes: 20,
    });
  });

  it.each([
    ["add a task: fix the build, urgent", "now"],
    ["add a task: tidy the desk whenever", "whenever"],
    ["add a task: reply to Sam", "soon"],
  ])("reads the priority in %s", (text, priority) => {
    expect(parseIntent(text)).toMatchObject({ kind: "task.add", priority });
  });

  // A task is a note to yourself. A parser that tidied the wording would
  // produce a list of things you did not quite write.
  it("keeps the wording as you said it", () => {
    const intent = parseIntent("remind me to ring mum about the thing in 30 minutes");
    expect(intent).toMatchObject({ title: "ring mum about the thing" });
  });

  it("refuses a task with nothing in it", () => {
    expect(parseIntent("add a task:")).toBeNull();
    expect(parseIntent("remind me to")).toBeNull();
  });
});

describe("everything else", () => {
  it.each([
    ["go quiet", { kind: "sleep" }],
    ["go to sleep", { kind: "sleep" }],
    ["wake up", { kind: "wake" }],
    ["open the closet", { kind: "open", what: "closet" }],
    ["show me my screen time", { kind: "open", what: "dashboard" }],
    ["open the timer", { kind: "open", what: "timer" }],
    ["make my recap", { kind: "recap" }],
    ["how long have I been at it", { kind: "report.today" }],
  ])("understands %s", (text, expected) => {
    expect(parseIntent(text)).toEqual(expected);
  });
});

describe("refusing rather than guessing", () => {
  // Guessing the nearest command is how "set a timer" becomes "reset today"
  // and somebody loses their history to a cough.
  it.each([
    "",
    "   ",
    "the weather is nice today",
    "asdfghjkl",
    "play some music",
    "what is the capital of France",
  ])("returns null for %s", (text) => {
    expect(parseIntent(text)).toBeNull();
  });

  it("is not fooled by a non-string", () => {
    expect(parseIntent(null as unknown as string)).toBeNull();
    expect(parseIntent(42 as unknown as string)).toBeNull();
  });
});

describe("destructive commands", () => {
  it.each([
    ["reset today's stats", "reset.today"],
    ["clear today", "reset.today"],
    ["forget all site data", "forget.sites"],
    ["delete my browsing domains", "forget.sites"],
  ])("recognises %s", (text, kind) => {
    expect(parseIntent(text)).toMatchObject({ kind });
  });

  // Speech is the least reliable input the app has, so it gets the strictest
  // gate: nothing that deletes happens on one sentence.
  it("always asks first", () => {
    for (const text of ["reset today's stats", "forget all site data"]) {
      const intent = parseIntent(text)!;
      expect(needsConfirmation(intent)).toBe(true);
      expect(acknowledge(intent)).toContain("confirm");
    }
  });

  it("never asks first for anything harmless", () => {
    for (const text of ["go quiet", "open the closet", "start a focus session"]) {
      expect(needsConfirmation(parseIntent(text)!)).toBe(false);
    }
  });

  // A destructive phrase must not be shadowed by a partial match on something
  // else and quietly become the wrong action.
  it("is not shadowed by another command's words", () => {
    expect(parseIntent("reset today's stats")).toMatchObject({ kind: "reset.today" });
  });
});

describe("isAffirmative", () => {
  it.each(["yes", "yeah", "yep", "confirm", "do it", "go ahead"])(
    "accepts %s",
    (text) => {
      expect(isAffirmative(text)).toBe(true);
    },
  );

  // Anything unclear is a no. The cost of a wrong yes is somebody's history.
  it.each(["no", "wait", "hang on", "", "maybe", "yesterday's numbers"])(
    "treats %s as a no",
    (text) => {
      expect(isAffirmative(text)).toBe(false);
    },
  );
});

describe("acknowledgement", () => {
  // With speech this is the only way to notice a misheard command before it has
  // already happened.
  it("names what it understood", () => {
    expect(acknowledge(parseIntent("focus for 45 minutes")!)).toContain("45");
    expect(acknowledge(parseIntent("add a task: buy milk")!)).toContain("buy milk");
  });

  it("has something to say for every intent", () => {
    const samples = [
      "focus for 25 minutes",
      "stop the session",
      "add a task: x",
      "go quiet",
      "wake up",
      "open the closet",
      "make my recap",
      "how long have I been at it",
      "reset today's stats",
      "forget all site data",
    ];
    for (const text of samples) {
      const intent = parseIntent(text);
      expect(intent).not.toBeNull();
      expect(acknowledge(intent!).length).toBeGreaterThan(0);
    }
  });
});

describe("the documented examples actually work", () => {
  // A help list that contains a command the parser rejects is worse than no
  // help list.
  it.each(EXAMPLE_COMMANDS)("parses the example %s", (text) => {
    expect(parseIntent(text)).not.toBeNull();
  });

  it("documents every real priority and no invented ones", () => {
    expect(Object.keys(PRIORITY_WORDS).sort()).toEqual([...KNOWN_PRIORITIES].sort());
  });

  it("actually maps its own priority words", () => {
    for (const word of PRIORITY_WORDS.now) {
      if (word.startsWith("(")) continue;
      expect(parseIntent(`add a task: something ${word}`)).toMatchObject({ priority: "now" });
    }
    for (const word of PRIORITY_WORDS.whenever) {
      if (word.startsWith("(")) continue;
      expect(parseIntent(`add a task: something ${word}`)).toMatchObject({ priority: "whenever" });
    }
  });
});

describe("the title is cleaned of the command's own words", () => {
  // These assert the TITLE, which the priority tests above left implicit — a
  // task called "fix the build, urgent" is the parser leaking its own grammar
  // into your notes.
  it.each([
    ["add a task: fix the build, urgent", "fix the build"],
    ["add a task: tidy the desk whenever", "tidy the desk"],
    ["remind me to call the bank in 20 minutes", "call the bank"],
    ["remind me to stretch in half an hour", "stretch"],
  ])("%s -> %s", (text, title) => {
    expect(parseIntent(text)).toMatchObject({ title });
  });

  it("leaves a title that merely contains a number alone", () => {
    expect(parseIntent("add a task: review the 3 pull requests")).toMatchObject({
      title: "review the 3 pull requests",
    });
  });
});

describe("driving the machine", () => {
  it("reads a level out of a sentence", () => {
    expect(percentIn("set volume to 50")).toBe(50);
    expect(percentIn("set volume to fifty")).toBe(50);
    expect(percentIn("seventy percent")).toBe(70);
    expect(percentIn("twenty five")).toBe(25);
    expect(percentIn("half")).toBe(50);
    expect(percentIn("max")).toBe(100);
    expect(percentIn("zero")).toBe(0);
    expect(percentIn("no number here")).toBeNull();
  });

  it("refuses a level outside 0 to 100", () => {
    expect(percentIn("set volume to 400")).toBeNull();
  });

  it.each([
    ["set volume to 40", 40],
    ["turn the volume to eighty", 80],
    ["set the sound to 100", 100],
  ])("understands %s", (text, percent) => {
    expect(parseIntent(text)).toEqual({ kind: "volume.set", percent });
  });

  it("understands muting both ways", () => {
    expect(parseIntent("mute")).toEqual({ kind: "volume.mute", on: true });
    expect(parseIntent("unmute")).toEqual({ kind: "volume.mute", on: false });
  });

  it("understands relative volume", () => {
    expect(parseIntent("volume up")).toEqual({ kind: "media", key: "volumeup" });
    expect(parseIntent("volume down")).toEqual({ kind: "media", key: "volumedown" });
  });

  it("understands brightness", () => {
    expect(parseIntent("set brightness to 70")).toEqual({
      kind: "brightness.set",
      percent: 70,
    });
  });

  // "play" inside a longer sentence is far more often a word than a command.
  it("only takes media keys as whole phrases", () => {
    expect(parseIntent("play")).toEqual({ kind: "media", key: "playpause" });
    expect(parseIntent("next track")).toEqual({ kind: "media", key: "nexttrack" });
    expect(parseIntent("play some music")).toBeNull();
  });

  it("understands clicking something by name", () => {
    expect(parseIntent("click save")).toEqual({ kind: "click", target: "save" });
    expect(parseIntent("press the send button")).toEqual({
      kind: "click",
      target: "send button",
    });
  });

  // The machine commands come first, so a program called "Volume" cannot
  // shadow the volume control.
  it("is not shadowed by the generic open matcher", () => {
    expect(parseIntent("set volume to 30")).toMatchObject({ kind: "volume.set" });
    expect(parseIntent("open notepad")).toMatchObject({ kind: "app.open" });
  });

  it("names what it understood, for every new intent", () => {
    for (const text of [
      "set volume to 40",
      "mute",
      "unmute",
      "set brightness to 70",
      "play",
      "click save",
    ]) {
      const intent = parseIntent(text);
      expect(intent, text).not.toBeNull();
      expect(acknowledge(intent!).length).toBeGreaterThan(0);
      expect(needsConfirmation(intent!)).toBe(false);
    }
  });
});
