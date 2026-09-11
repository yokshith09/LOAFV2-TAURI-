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

/**
 * The engines you can actually pick for talking TO Loaf.
 *
 * WHISPER IS NOT ONE OF THEM ANY MORE, and that is a decision rather than an
 * omission. It is a batch transcriber: it hears a whole recording and returns
 * the words when it has finished, which is exactly right for a meeting nobody
 * is waiting on and exactly wrong for a command, where the gap between
 * speaking and something happening IS the feature. Even at full speed it
 * cannot answer before the sentence is over.
 *
 * So the two jobs are split by what each tool is good at:
 *
 *  - TALKING TO LOAF — commands and dictation — uses Windows' own speech,
 *    which answers immediately.
 *  - RECORDING A MEETING uses Whisper, which is slower and far more accurate
 *    and runs entirely on this machine.
 *
 * Whisper is still downloaded, still local, still shown — it just lives under
 * Meetings, where it does its work, instead of in a picker for a job it was
 * never suited to.
 *
 * WHERE THIS ARGUMENT STOPS, AND IT DOES STOP. It assumes there is an OS
 * recogniser to prefer. On macOS there is not: `SFSpeechRecognizer` is a
 * network recogniser unless driven through Objective-C, so the choice there is
 * not "Windows speech or Whisper", it is "Whisper or nothing at all". Loaf now
 * takes commands and dictation with Whisper wherever there is no OS
 * recogniser — see the note at the top of `speech.rs`. A reply half a second
 * late beats the wake word answering "Mm?" and then saying that speaking to
 * Loaf is Windows-only, which is what a Mac used to get.
 *
 * That is a platform decision rather than a setting, which is why the list
 * below does not change: nobody should be asked to pick an engine whose only
 * alternative is silence.
 */
export const PICKABLE_ENGINES: readonly EngineId[] = ENGINES.filter(
  (e) => e !== "whisper",
);

/**
 * Which engines can actually be picked for talking TO Loaf, on THIS machine.
 *
 * THE BUG THIS FUNCTION FIXES. `PICKABLE_ENGINES` above is the Windows list,
 * and until this existed it was also shown as THE list everywhere — including
 * on a Mac, where "Windows speech (built in)" rendered as a selectable option
 * with the reason "Windows speech is not available here", and "Whisper" (the
 * one that actually works there, once downloaded — see `speech.rs`) was not
 * offered at all. A settings screen that names the wrong recogniser AND hides
 * the real one reads exactly like "voice is not working", because from the
 * outside it is indistinguishable from voice not working.
 *
 * `builtin` is Windows' own recogniser; it cannot exist on any other platform,
 * and listing it there is not "showing an unavailable option with its reason"
 * the way `whisper: Not downloaded yet` is — there is no reason that will ever
 * turn it available, because it is calling an API that platform does not have.
 * So it is not merely disabled elsewhere, it is not offered.
 */
export function pickableEnginesFor(os: string): readonly EngineId[] {
  return os === "windows" ? PICKABLE_ENGINES : (["whisper", "hosted"] as const);
}

/**
 * Whether Whisper is installed and usable, for the meeting recorder.
 *
 * Separate from `unavailableReason` because Whisper is no longer one of the
 * choices that function is about.
 */
export function whisperReason(have: EngineAvailability): string | null {
  return have.whisperModel ? null : "Not downloaded yet.";
}

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
 * The engine to actually use, given what is available on this platform.
 *
 * Falls back to the first of `pickableEnginesFor(os)`, NEVER to `hosted`: a
 * fallback that silently starts sending audio to a server is the single worst
 * thing this module could do. That first entry is `builtin` on Windows and
 * `whisper` everywhere else — chosen even when Whisper is not yet downloaded,
 * because "builtin" is not a fallback that can ever succeed off Windows, and a
 * fallback that is guaranteed to fail is not a fallback.
 */
export function resolveEngine(
  wanted: EngineId,
  have: EngineAvailability,
  os: string,
): EngineId {
  const pickable = pickableEnginesFor(os);
  const fallback = pickable[0]!;
  // A stored "whisper" from before it stopped being a choice for talking to
  // Loaf on Windows lands here on the next launch there and quietly becomes
  // the built-in one. Migrating rather than erroring: the setting was valid
  // when it was saved, on whatever platform saved it.
  if (!pickable.includes(wanted)) return fallback;
  if (isAvailable(wanted, have)) return wanted;
  return fallback;
}

/**
 * Which way dictation goes: Loaf's own recogniser, or Windows' voice-typing bar.
 *
 * A five-line decision that has now been wrong twice in a row, which is why it
 * is a named function with tests rather than a condition inside an async
 * handler nothing can reach. First it was Win+H unconditionally. Then it was
 * routed by PLATFORM, which meant a Windows machine with Whisper downloaded and
 * selected still got Microsoft's bar — the fix worked only on the platform
 * nobody was testing on, under a comment claiming it worked everywhere.
 *
 * The question is which recogniser EXISTS, not which OS this is. Win+H is the
 * fallback for a Windows machine with no model, and it is weaker twice over:
 * Windows decides whether that audio leaves the machine, and Loaf never gets
 * the text back, so it cannot fill in a task or a note.
 */
export type DictationRoute = "whisper" | "windows-voice-typing";

export function dictationRoute(whisperReady: boolean, os: string): DictationRoute {
  if (whisperReady) return "whisper";
  // Win+H is a Windows shortcut. Pressing it anywhere else does nothing and
  // leaves somebody waiting for a bar that is never going to appear, so every
  // other platform goes to Whisper and gets told to download it.
  return os === "windows" ? "windows-voice-typing" : "whisper";
}
