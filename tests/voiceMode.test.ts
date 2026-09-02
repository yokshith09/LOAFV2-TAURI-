import { describe, it, expect } from "vitest";
import {
  LISTEN_MODES,
  DEFAULT_LISTEN_MODE,
  isListenMode,
  readListenMode,
  LABELS,
  DESCRIPTIONS,
  NEEDS_MICROPHONE,
  isContinuous,
  usesWakeWord,
  widensAccess,
} from "../src/voice/mode";

describe("listen modes", () => {
  // The default is the whole ethical position of the feature. If this ever
  // fails, someone has made a microphone open by default.
  it("defaults to never opening the microphone", () => {
    expect(DEFAULT_LISTEN_MODE).toBe("off");
    expect(NEEDS_MICROPHONE[DEFAULT_LISTEN_MODE]).toBe(false);
  });

  it("recognises its own modes and nothing else", () => {
    for (const mode of LISTEN_MODES) expect(isListenMode(mode)).toBe(true);
    for (const junk of ["", "on", "ALWAYS", null, 3, undefined]) {
      expect(isListenMode(junk)).toBe(false);
    }
  });

  // A corrupt or older settings file must not silently upgrade someone into a
  // hot microphone.
  it("falls back to off, never to something louder", () => {
    expect(readListenMode("nonsense")).toBe("off");
    expect(readListenMode(undefined)).toBe("off");
    expect(readListenMode(null)).toBe("off");
    expect(readListenMode("always")).toBe("always");
  });

  it("describes every mode it offers", () => {
    for (const mode of LISTEN_MODES) {
      expect(LABELS[mode]?.length ?? 0).toBeGreaterThan(0);
      expect(DESCRIPTIONS[mode]?.length ?? 0).toBeGreaterThan(0);
      expect(typeof NEEDS_MICROPHONE[mode]).toBe("boolean");
    }
  });

  it("says plainly that always-on means an open microphone", () => {
    expect(DESCRIPTIONS.always).toContain("Microphone stays active");
    expect(DESCRIPTIONS.always).toContain("open the whole time");
    expect(DESCRIPTIONS.off).toContain("never");
  });

  // Every mode that opens a microphone says where the audio goes. This is
  // the sentence people actually read before agreeing to it.
  it("tells you the audio stays here, in every mode that listens", () => {
    for (const mode of LISTEN_MODES) {
      if (!NEEDS_MICROPHONE[mode]) continue;
      expect(DESCRIPTIONS[mode], mode).toContain("processed on this device");
    }
  });

  it("only treats always as continuous", () => {
    expect(isContinuous("always")).toBe(true);
    for (const mode of ["off", "push", "hover"] as const) {
      expect(isContinuous(mode)).toBe(false);
      expect(usesWakeWord(mode)).toBe(false);
    }
    expect(usesWakeWord("always")).toBe(true);
  });

  it("orders the modes by how much access they need", () => {
    expect(LISTEN_MODES).toEqual(["off", "push", "hover", "always"]);
    expect(widensAccess("off", "always")).toBe(true);
    expect(widensAccess("push", "hover")).toBe(true);
    expect(widensAccess("always", "off")).toBe(false);
    expect(widensAccess("push", "push")).toBe(false);
  });

  it("needs a microphone for everything except off", () => {
    expect(NEEDS_MICROPHONE.off).toBe(false);
    for (const mode of ["push", "hover", "always"] as const) {
      expect(NEEDS_MICROPHONE[mode]).toBe(true);
    }
  });
});
