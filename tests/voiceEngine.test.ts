import { describe, it, expect } from "vitest";
import {
  ENGINES,
  DEFAULT_ENGINE,
  ENGINE_INFO,
  isEngineId,
  readEngineId,
  audioLine,
  leavesMachine,
  canDictate,
  unavailableReason,
  isAvailable,
  resolveEngine,
  type EngineAvailability,
} from "../src/voice/engine";

const ALL: EngineAvailability = {
  whisperModel: true,
  hostedConnected: true,
  builtinReady: true,
};
const NONE: EngineAvailability = {
  whisperModel: false,
  hostedConnected: false,
  builtinReady: true,
};

describe("the three engines", () => {
  it("offers exactly the three, in order of what they cost", () => {
    expect(ENGINES).toEqual(["builtin", "whisper", "hosted"]);
  });

  it("defaults to the one that needs nothing and sends nothing", () => {
    expect(DEFAULT_ENGINE).toBe("builtin");
    expect(leavesMachine(DEFAULT_ENGINE)).toBe(false);
  });

  // The correction this module exists to record: free text does NOT imply the
  // cloud. Whisper is both.
  it("has an engine that does free text without sending audio anywhere", () => {
    const local = ENGINES.filter((e) => canDictate(e) && !leavesMachine(e));
    expect(local).toEqual(["whisper"]);
  });

  it("has exactly one engine that sends audio away", () => {
    expect(ENGINES.filter(leavesMachine)).toEqual(["hosted"]);
  });

  it("says of every engine whether it can dictate and where audio goes", () => {
    for (const id of ENGINES) {
      const info = ENGINE_INFO[id];
      expect(info.id).toBe(id);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.summary.length).toBeGreaterThan(0);
      expect(info.requires.length).toBeGreaterThan(0);
      expect(typeof info.freeText).toBe("boolean");
      expect(["this-device", "a-server"]).toContain(info.audio);
    }
  });

  // The one place the claim stops being true has to say so in the same size
  // type as everywhere it holds.
  it("states plainly where audio goes, per engine", () => {
    expect(audioLine("builtin")).toContain("on this device");
    expect(audioLine("whisper")).toContain("on this device");
    expect(audioLine("hosted")).toContain("sent to a server");
  });

  it("warns in the hosted engine's own summary too", () => {
    expect(ENGINE_INFO.hosted.summary).toContain("leaves this machine");
  });
});

describe("reading a stored choice", () => {
  it("recognises its own ids and nothing else", () => {
    for (const id of ENGINES) expect(isEngineId(id)).toBe(true);
    for (const junk of ["", "cloud", "HOSTED", null, 2, undefined]) {
      expect(isEngineId(junk)).toBe(false);
    }
  });

  // A corrupt settings file must never land on the engine that uploads.
  it("falls back to the local one, never the hosted one", () => {
    expect(readEngineId("nonsense")).toBe("builtin");
    expect(readEngineId(undefined)).toBe("builtin");
    expect(readEngineId("hosted")).toBe("hosted");
  });
});

describe("availability", () => {
  it("says why an engine cannot be used", () => {
    expect(unavailableReason("whisper", NONE)).toContain("Not downloaded");
    expect(unavailableReason("hosted", NONE)).toContain("No speech service");
    expect(unavailableReason("builtin", NONE)).toBeNull();
  });

  it("reports the built-in one as unusable when Windows speech is missing", () => {
    const broken = { ...ALL, builtinReady: false };
    expect(isAvailable("builtin", broken)).toBe(false);
    expect(unavailableReason("builtin", broken)).toContain("language pack");
  });

  it("is available when its requirement is met", () => {
    for (const id of ENGINES) expect(isAvailable(id, ALL)).toBe(true);
  });
});

describe("resolving what to actually run", () => {
  it("uses what was asked for when it can", () => {
    for (const id of ENGINES) expect(resolveEngine(id, ALL)).toBe(id);
  });

  // A fallback that silently starts uploading audio is the worst thing this
  // module could do.
  it("never falls back to the hosted engine", () => {
    expect(resolveEngine("whisper", NONE)).toBe("builtin");
    expect(resolveEngine("hosted", NONE)).toBe("builtin");
    for (const id of ENGINES) {
      expect(leavesMachine(resolveEngine(id, NONE))).toBe(false);
    }
  });
});
