import { describe, it, expect, beforeEach } from "vitest";
import {
  pickVoice,
  localVoices,
  isRemoteOnly,
  speakable,
  Speaker,
  MAX_SPOKEN_CHARS,
  type VoiceInfo,
  type Synth,
  type SpeechUtteranceLike,
} from "../src/voice/speak";

const LOCAL_US: VoiceInfo = { name: "Zira", lang: "en-US", localService: true };
const LOCAL_IN: VoiceInfo = { name: "Heera", lang: "en-IN", localService: true };
const LOCAL_FR: VoiceInfo = { name: "Hortense", lang: "fr-FR", localService: true };
// On Windows these are the "Online (Natural)" voices. They sound far better and
// they send the text to a server.
const REMOTE: VoiceInfo = { name: "Ava Online (Natural)", lang: "en-US", localService: false };

describe("pickVoice", () => {
  // This is the whole rule. A remote voice sounds better, which is exactly why
  // it would get chosen by accident.
  it("never returns a remote voice", () => {
    expect(pickVoice([REMOTE])).toBeNull();
    expect(pickVoice([REMOTE, REMOTE])).toBeNull();
  });

  it("returns null rather than falling back to a remote voice", () => {
    expect(pickVoice([REMOTE], "Ava Online (Natural)")).toBeNull();
  });

  it("prefers a local voice the user named", () => {
    expect(pickVoice([LOCAL_US, LOCAL_IN], "Heera")).toBe(LOCAL_IN);
  });

  // The request was for a voice, not for silence.
  it("still speaks when the named voice is remote but a local one exists", () => {
    expect(pickVoice([LOCAL_US, REMOTE], "Ava Online (Natural)")).toBe(LOCAL_US);
  });

  it("matches the language, then the language family, then English", () => {
    expect(pickVoice([LOCAL_FR, LOCAL_US], undefined, "en-US")).toBe(LOCAL_US);
    expect(pickVoice([LOCAL_FR, LOCAL_IN], undefined, "en-US")).toBe(LOCAL_IN);
    expect(pickVoice([LOCAL_FR], undefined, "de-DE")).toBe(LOCAL_FR);
  });

  it("has nothing to say with no voices at all", () => {
    expect(pickVoice([])).toBeNull();
  });
});

describe("naming the voices", () => {
  it("offers only local ones", () => {
    expect(localVoices([LOCAL_US, REMOTE, LOCAL_IN])).toEqual([LOCAL_US, LOCAL_IN]);
  });

  // So a settings screen can explain why a chosen voice is not being used.
  it("can say a named voice is remote-only", () => {
    expect(isRemoteOnly([LOCAL_US, REMOTE], "Ava Online (Natural)")).toBe(true);
    expect(isRemoteOnly([LOCAL_US, REMOTE], "Zira")).toBe(false);
    expect(isRemoteOnly([LOCAL_US], "Nobody")).toBe(false);
  });
});

describe("speakable", () => {
  it("strips emoji rather than reading them out", () => {
    expect(speakable("Nice work 🎉")).toBe("Nice work");
  });

  it("collapses whitespace and curly quotes", () => {
    expect(speakable('Heard:  “open notepad”')).toBe('Heard: "open notepad"');
  });

  // Spoken aloud, a long line cannot be skimmed and talks over whatever the
  // user is actually doing.
  it("refuses a line too long to hear", () => {
    expect(speakable("a".repeat(MAX_SPOKEN_CHARS + 1))).toBeNull();
    expect(speakable("a".repeat(MAX_SPOKEN_CHARS))).not.toBeNull();
  });

  it("refuses lines with nothing to say", () => {
    expect(speakable("")).toBeNull();
    expect(speakable("   ")).toBeNull();
    expect(speakable("🎉")).toBeNull();
    expect(speakable("42 — 17")).toBeNull();
  });
});

describe("Speaker", () => {
  let spoken: SpeechUtteranceLike[];
  let cancels: number;
  let synth: Synth;
  let voices: VoiceInfo[];

  beforeEach(() => {
    spoken = [];
    cancels = 0;
    voices = [LOCAL_US, REMOTE];
    synth = {
      getVoices: () => voices,
      speak: (u) => spoken.push(u),
      cancel: () => {
        cancels += 1;
      },
    };
  });

  it("says nothing until it is switched on", () => {
    const speaker = new Speaker(synth);
    expect(speaker.speak("hello")).toBeNull();
    expect(spoken).toHaveLength(0);
  });

  it("speaks with a local voice once enabled", () => {
    const speaker = new Speaker(synth);
    speaker.enabled = true;
    expect(speaker.speak("Opening Notepad.")).toBe("Opening Notepad.");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.voice).toBe(LOCAL_US);
  });

  // Silence is the correct failure. The bubble is still on screen.
  it("stays silent when every voice is remote", () => {
    voices = [REMOTE];
    const speaker = new Speaker(synth);
    speaker.enabled = true;
    expect(speaker.speak("Opening Notepad.")).toBeNull();
    expect(spoken).toHaveLength(0);
  });

  // A fast series of bubbles must not build a queue that keeps talking long
  // after the thing it described has finished.
  it("cancels whatever it was saying before starting", () => {
    const speaker = new Speaker(synth);
    speaker.enabled = true;
    speaker.speak("one");
    speaker.speak("two");
    expect(cancels).toBe(2);
    expect(spoken).toHaveLength(2);
  });

  it("can be hushed mid-sentence", () => {
    const speaker = new Speaker(synth);
    speaker.hush();
    expect(cancels).toBe(1);
  });

  it("reports what it can do", () => {
    expect(new Speaker(synth).available).toBe(true);
    expect(new Speaker(synth).voices()).toEqual([LOCAL_US]);
    voices = [REMOTE];
    expect(new Speaker(synth).available).toBe(false);
    expect(new Speaker(null).available).toBe(false);
    expect(new Speaker(null).voices()).toEqual([]);
  });

  it("is harmless with no synthesiser at all", () => {
    const speaker = new Speaker(null);
    speaker.enabled = true;
    expect(speaker.speak("hello")).toBeNull();
    expect(() => speaker.hush()).not.toThrow();
  });
});
