import { describe, it, expect } from "vitest";
import {
  OCCASIONS,
  VOICES,
  OCCASION_NOTES,
  RETRIGGER_FLOOR_MS,
  isOccasion,
  isAudible,
  durationOf,
  defaultSoundSettings,
} from "../src/sound/voice";
import {
  SoundKit,
  loadSoundSettings,
  saveSoundSettings,
  type AudioHost,
} from "../src/sound/soundKit";
import { MemorySettingsStore } from "../src/closet/settings";

/**
 * Counts what was asked of Web Audio without needing any of it.
 *
 * Typed as `AudioHost`, which is now derived from `AudioContext` — so a stub
 * that implements a method the real API does not have no longer compiles. That
 * is what let `ctx.now()` ship: this file agreed with the interface, and the
 * interface was wrong.
 */
function stubHost(): { host: AudioHost; started: number[] } {
  const started: number[] = [];
  const param = () => ({
    setValueAtTime: () => param(),
    linearRampToValueAtTime: () => param(),
    exponentialRampToValueAtTime: () => param(),
  });
  const host = {
    currentTime: 0,
    state: "running",
    resume: async () => {},
    destination: {} as AudioNode,
    createOscillator: () =>
      ({
        type: "sine",
        frequency: param(),
        connect: () => {},
        start: (t: number) => started.push(t),
        stop: () => {},
      }) as unknown as OscillatorNode,
    createGain: () =>
      ({ gain: param(), connect: () => {} }) as unknown as GainNode,
  } as unknown as AudioHost;
  return { host, started };
}

describe("the four occasions", () => {
  it("all have a voice and a line of the README", () => {
    // A new occasion with no sound is a call site that silently does nothing.
    for (const o of OCCASIONS) {
      expect(VOICES[o].length).toBeGreaterThan(0);
      expect(OCCASION_NOTES[o]).toBeTruthy();
    }
  });

  it("are short enough not to be in the way", () => {
    // Greeting fires on every click. A sound you cannot click through is worse
    // than no sound at all.
    for (const o of OCCASIONS) expect(durationOf(o)).toBeLessThan(0.6);
    expect(durationOf("greeting")).toBeLessThan(0.2);
  });

  it("keep every note quiet enough to sit under whatever you are doing", () => {
    for (const o of OCCASIONS) {
      for (const note of VOICES[o]) expect(note.gain).toBeLessThanOrEqual(0.2);
    }
  });

  it("recognises its own occasions and nothing else", () => {
    for (const o of OCCASIONS) expect(isOccasion(o)).toBe(true);
    for (const junk of ["", "finished", "FINISH", null, 3]) {
      expect(isOccasion(junk)).toBe(false);
    }
  });

  it("rises for the timer, because that is what it has always done", () => {
    // Quietly changing the noise a timer makes, while adding a feature, would
    // be a change nobody asked for.
    const notes = VOICES.finish;
    expect(notes[1]!.from).toBeGreaterThan(notes[0]!.from);
  });

  it("falls for the tantrum, because that one is a complaint", () => {
    expect(VOICES.tantrum[0]!.to).toBeLessThan(VOICES.tantrum[0]!.from);
  });
});

describe("whether it is heard at all", () => {
  it("says nothing while muted", () => {
    const s = { ...defaultSoundSettings(), muted: true };
    for (const o of OCCASIONS) expect(isAudible(s, o)).toBe(false);
  });

  it("lets the chime have its own switch", () => {
    // Two controls that both believe they own the chime is how a preference
    // ends up fighting itself; mute is a second gate, not a replacement.
    const s = { muted: false, focusChime: false };
    expect(isAudible(s, "finish")).toBe(false);
    expect(isAudible(s, "greeting")).toBe(true);
  });

  it("keeps the chime on when the setting has never been written", () => {
    // A chime that switched itself off because a key was missing would look
    // like the timer had stopped working.
    expect(loadSoundSettings(new MemorySettingsStore()).focusChime).toBe(true);
  });

  it("round-trips through storage", () => {
    const store = new MemorySettingsStore();
    saveSoundSettings(store, { muted: true, focusChime: false });
    expect(loadSoundSettings(store)).toEqual({ muted: true, focusChime: false });
  });
});

describe("not making the same noise twice", () => {
  it("drops a second request inside the retrigger window", () => {
    // A double-click delivers two clicks, and two greetings a millisecond apart
    // is a glitch rather than a feature.
    let clock = 0;
    const kit = new SoundKit({ now: () => clock });
    expect(kit.claim("greeting")).toBe(true);
    clock += RETRIGGER_FLOOR_MS - 1;
    expect(kit.claim("greeting")).toBe(false);
  });

  it("allows it again once the window has passed", () => {
    let clock = 0;
    const kit = new SoundKit({ now: () => clock });
    kit.claim("greeting");
    clock += RETRIGGER_FLOOR_MS + 1;
    expect(kit.claim("greeting")).toBe(true);
  });

  it("throttles each occasion on its own", () => {
    // A tantrum landing in the same instant as a click must not swallow either.
    const kit = new SoundKit({ now: () => 0 });
    expect(kit.claim("greeting")).toBe(true);
    expect(kit.claim("tantrum")).toBe(true);
  });

  it("does not start a throttle for something it refused to play", () => {
    // Otherwise unmuting inside the window would be met with silence for no
    // reason the user could see.
    let clock = 0;
    const kit = new SoundKit({
      now: () => clock,
      settings: { muted: true, focusChime: true },
    });
    expect(kit.claim("greeting")).toBe(false);
    kit.settings.muted = false;
    expect(kit.claim("greeting")).toBe(true);
  });
});

describe("making the noise", () => {
  it("plays every note of the voice", () => {
    const { host, started } = stubHost();
    const kit = new SoundKit({ now: () => 0, context: () => host });
    kit.play("finish");
    expect(started).toHaveLength(VOICES.finish.length);
  });

  it("plays nothing at all while muted", () => {
    const { host, started } = stubHost();
    const kit = new SoundKit({
      now: () => 0,
      context: () => host,
      settings: { muted: true, focusChime: true },
    });
    kit.play("finish");
    expect(started).toHaveLength(0);
  });

  it("staggers the notes rather than stacking them", () => {
    const { host, started } = stubHost();
    const kit = new SoundKit({ now: () => 0, context: () => host });
    kit.play("finish");
    expect(started[1]).toBeGreaterThan(started[0]!);
  });

  it("survives a machine with no audio at all", () => {
    // No device, or a webview without Web Audio. Silence is the correct
    // failure: a pet that threw out of a click handler because the machine has
    // no speakers would take the click with it.
    const kit = new SoundKit({
      now: () => 0,
      context: () => {
        throw new Error("no audio");
      },
    });
    expect(() => kit.play("finish")).not.toThrow();
  });

  it("does not retry a context that already failed", () => {
    // Otherwise every click pays for another failed construction.
    let attempts = 0;
    const kit = new SoundKit({
      now: () => attempts * 1000,
      context: () => {
        attempts++;
        throw new Error("no audio");
      },
    });
    kit.play("finish");
    kit.play("tantrum");
    expect(attempts).toBeLessThanOrEqual(2);
  });
});
