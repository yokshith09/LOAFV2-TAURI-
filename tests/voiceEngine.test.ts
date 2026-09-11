import { describe, it, expect } from "vitest";
import {
  ENGINES,
  PICKABLE_ENGINES,
  pickableEnginesFor,
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
  dictationRoute,
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

/**
 * Which engines a settings screen may actually offer — the fix for a Mac
 * showing "Windows speech (built in)" as its recogniser, with no way to make
 * it work, while the one that actually does (Whisper) was never listed.
 */
describe("which engines this platform can even offer", () => {
  it("offers Windows' own recogniser only on Windows", () => {
    expect(pickableEnginesFor("windows")).toEqual(PICKABLE_ENGINES);
    expect(pickableEnginesFor("windows")).toContain("builtin");
  });

  // `builtin` is not "not ready yet" off Windows — it is an API that platform
  // does not have. It must never appear as an option there, disabled or not.
  it("never offers builtin off Windows", () => {
    for (const os of ["macos", "linux", "", "other"]) {
      expect(pickableEnginesFor(os)).not.toContain("builtin");
    }
  });

  it("offers Whisper wherever builtin cannot exist", () => {
    for (const os of ["macos", "linux", "", "other"]) {
      expect(pickableEnginesFor(os)).toContain("whisper");
    }
  });

  it("always offers the hosted engine, on every platform", () => {
    for (const os of ["windows", "macos", "linux", ""]) {
      expect(pickableEnginesFor(os)).toContain("hosted");
    }
  });
});

describe("resolving what to actually run", () => {
  it("uses what was asked for when it can, on Windows", () => {
    for (const id of PICKABLE_ENGINES) expect(resolveEngine(id, ALL, "windows")).toBe(id);
  });

  it("uses what was asked for when it can, off Windows", () => {
    for (const id of pickableEnginesFor("macos")) {
      expect(resolveEngine(id, ALL, "macos")).toBe(id);
    }
  });

  // Whisper stopped being a choice for talking to Loaf ON WINDOWS: it answers
  // once a recording has finished, which is right for a meeting and wrong for
  // a command there, where a fast native recogniser already exists. A setting
  // saved back when it WAS a choice — or saved on a Mac, where it still is —
  // has to keep working on Windows rather than erroring.
  it("migrates a stored Whisper choice to the built-in recogniser, on Windows", () => {
    expect(resolveEngine("whisper", ALL, "windows")).toBe("builtin");
    expect(PICKABLE_ENGINES).not.toContain("whisper");
  });

  // The bug this whole function was rewritten to fix: off Windows, "builtin"
  // cannot run no matter what is available, so falling back to it is falling
  // back to something guaranteed to fail — indistinguishable from voice being
  // broken, because it IS broken, forever, for anyone on that platform.
  it("never falls back to builtin off Windows — it does not exist there", () => {
    expect(resolveEngine("builtin", ALL, "macos")).toBe("whisper");
    expect(resolveEngine("hosted", NONE, "macos")).toBe("whisper");
  });

  // A fallback that silently starts uploading audio is the worst thing this
  // module could do, on any platform.
  it("never falls back to the hosted engine", () => {
    expect(resolveEngine("whisper", NONE, "windows")).toBe("builtin");
    expect(resolveEngine("hosted", NONE, "windows")).toBe("builtin");
    expect(resolveEngine("hosted", NONE, "macos")).toBe("whisper");
    for (const os of ["windows", "macos"]) {
      for (const id of ENGINES) {
        expect(leavesMachine(resolveEngine(id, NONE, os))).toBe(false);
      }
    }
  });

  // An unknown platform — `platform_name` has not answered yet — must never be
  // read as "so it must be Windows". That misreading is exactly how a Mac
  // ends up being offered a recogniser it does not have.
  it("treats an unknown platform the same as any non-Windows one", () => {
    expect(resolveEngine("builtin", ALL, "")).toBe("whisper");
  });
});

/**
 * The routing that has been wrong twice. Both failures shipped, and both
 * looked correct in review because the comment beside them described the
 * intended behaviour rather than the code's.
 */
describe("which way dictation goes", () => {
  it("uses Whisper on Windows once the model is downloaded — the reported bug", () => {
    expect(dictationRoute(true, "windows")).toBe("whisper");
  });

  it("falls back to Windows voice typing only when there is no model", () => {
    expect(dictationRoute(false, "windows")).toBe("windows-voice-typing");
  });

  it("never presses a Windows shortcut on a Mac", () => {
    expect(dictationRoute(false, "macos")).toBe("whisper");
    expect(dictationRoute(true, "macos")).toBe("whisper");
  });

  it("treats an unknown platform as not-Windows rather than guessing", () => {
    // platform_name returns "" when the call fails.
    expect(dictationRoute(false, "")).toBe("whisper");
  });

  it("prefers the local recogniser on every platform when it is there", () => {
    for (const os of ["windows", "macos", "linux", ""]) {
      expect(dictationRoute(true, os)).toBe("whisper");
    }
  });
});
