/**
 * The three ways Loaf can turn speech into text, and what each one costs.
 *
 * These are not three settings of one feature. They are three different
 * bargains between "can it understand anything I say" and "does my voice leave
 * this machine", and the honest thing is to put all three in front of the user
 * with the trade written next to each rather than picking one and describing
 * the product by it.
 *
 *   builtin  commands only        nothing leaves      works today, no download
 *   whisper  anything you say     nothing leaves      needs a model downloaded
 *   hosted   anything you say     AUDIO LEAVES        needs a service connected
 *
 * WHY THE MIDDLE ONE MATTERS. It is easy to state this as "free text means the
 * cloud", and that was said in this codebase before it was checked. It is not
 * true: it is a property of the WINDOWS recogniser, not of on-device speech
 * recognition. Whisper runs locally and transcribes arbitrary speech. What it
 * costs is a model download, not the privacy promise.
 *
 * THE PROMISE STOPS BEING GLOBAL. Once `hosted` exists, "Loaf makes no network
 * calls" is no longer a fact about the app; it is a fact about the engine you
 * chose. So it is carried here, per engine, and shown at the moment of
 * choosing and again whenever the microphone is open — rather than asserted
 * once in a README where nobody is looking when it matters.
 */

export const ENGINES = ["builtin", "whisper", "hosted"] as const;
export type EngineId = (typeof ENGINES)[number];

/** The one that needs nothing installed and nothing connected. */
export const DEFAULT_ENGINE: EngineId = "builtin";

export function isEngineId(v: unknown): v is EngineId {
  return typeof v === "string" && (ENGINES as readonly string[]).includes(v);
}

/** Anything unrecognised falls back to the engine that keeps audio here. */
export function readEngineId(raw: unknown): EngineId {
  return isEngineId(raw) ? raw : DEFAULT_ENGINE;
}

/** Where a given engine sends what you say. */
export type AudioDestination = "this-device" | "a-server";

export interface EngineInfo {
  readonly id: EngineId;
  readonly label: string;
  /** Whether it can transcribe arbitrary speech, or only known phrases. */
  readonly freeText: boolean;
  readonly audio: AudioDestination;
  /** One line, shown next to the choice. */
  readonly summary: string;
  /** What it needs before it can be used at all. */
  readonly requires: string;
}

export const ENGINE_INFO: Readonly<Record<EngineId, EngineInfo>> = {
  builtin: {
    id: "builtin",
    label: "Windows speech (built in)",
    freeText: false,
    audio: "this-device",
    summary:
      "Understands Loaf's own commands and program names. Cannot take dictation. " +
      "Audio is processed on this device.",
    requires: "Nothing. This is what Loaf uses today.",
  },
  whisper: {
    id: "whisper",
    label: "Whisper (on this machine)",
    freeText: true,
    audio: "this-device",
    summary:
      "Understands anything you say, including dictation. Also what records and " +
      "transcribes meetings — the same download does both. Audio is processed on " +
      "this device.",
    requires: "A one-time model download, around 190 MB.",
  },
  hosted: {
    id: "hosted",
    label: "A hosted service",
    freeText: true,
    audio: "a-server",
    summary:
      "Understands anything you say. Your audio is sent to that service to be " +
      "transcribed, and leaves this machine.",
    requires: "A service connected through MCP, and its own account and terms.",
  },
};

/**
 * The sentence shown wherever the microphone is open.
 *
 * Deliberately blunt for the hosted case. Everywhere else in Loaf the claim is
 * that nothing leaves; the one place that stops being true has to say so in the
 * same size type.
 */
export function audioLine(id: EngineId): string {
  return ENGINE_INFO[id].audio === "this-device"
    ? "Audio is processed on this device."
    : "Audio is sent to a server to be transcribed.";
}

/** Whether choosing this engine means audio leaving the machine. */
export function leavesMachine(id: EngineId): boolean {
  return ENGINE_INFO[id].audio === "a-server";
}

/** Whether this engine can take dictation rather than only commands. */
export function canDictate(id: EngineId): boolean {
  return ENGINE_INFO[id].freeText;
}

/**
 * Why an engine cannot be used right now, or null when it can.
 *
 * Availability is passed in rather than detected here so this stays pure and
 * testable, and so the UI can list an engine it cannot yet run WITH the reason
 * — which is more use than hiding it and leaving people to wonder whether Loaf
 * can do dictation at all.
 */
export interface EngineAvailability {
  /** Whether a Whisper model has been downloaded. */
  readonly whisperModel: boolean;
  /** Whether a speech service is connected through MCP. */
  readonly hostedConnected: boolean;
  /** Whether the Windows recogniser compiled a constraint successfully. */
  readonly builtinReady: boolean;
}

export function unavailableReason(
  id: EngineId,
  have: EngineAvailability,
): string | null {
  switch (id) {
    case "builtin":
      return have.builtinReady
        ? null
        : "Windows speech is not available here. A speech language pack may not be installed.";
    case "whisper":
      return have.whisperModel ? null : "Not downloaded yet.";
    case "hosted":
      return have.hostedConnected ? null : "No speech service is connected.";
  }
}

export function isAvailable(id: EngineId, have: EngineAvailability): boolean {
  return unavailableReason(id, have) === null;
}

/**
 * The engine to actually use, given what is available.
 *
 * Falls back to `builtin`, never to `hosted`: a fallback that silently starts
 * sending audio to a server is the single worst thing this module could do.
 */
export function resolveEngine(
  wanted: EngineId,
  have: EngineAvailability,
): EngineId {
  if (isAvailable(wanted, have)) return wanted;
  return "builtin";
}
