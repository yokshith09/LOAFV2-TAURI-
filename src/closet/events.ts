/**
 * What the closet window sends back.
 *
 * The closet decides nothing — the same division the reference draws in its own
 * header. It reports what was clicked; the companion window applies the choice
 * to the live character, persists it, and broadcasts the new state so the
 * closet's selection catches up.
 *
 * Keeping the decision on one side is what stops two windows disagreeing about
 * which cat is on duty.
 */

import { isHabit } from "../behaviour/habits";
import { isListenMode, type ListenMode } from "../voice/mode";
import { isEngineId, type EngineId, type EngineAvailability } from "../voice/engine";

export const CLOSET_PICK_EVENT = "loaf://closet/pick";
export const CLOSET_CHANGED_EVENT = "loaf://closet/changed";
/**
 * Closet -> companion: "I have just opened, tell me the state."
 *
 * The closet could read the same storage the companion writes — all the windows
 * share an origin — but that quietly assumes every platform's webview keeps one
 * live localStorage across separate windows. Asking the owner is one round trip
 * and needs no assumption at all.
 */
export const CLOSET_HELLO_EVENT = "loaf://closet/hello";

export type ClosetPick =
  | { readonly kind: "companion"; readonly id: string }
  | { readonly kind: "outfit"; readonly id: string }
  | { readonly kind: "pixelated"; readonly on: boolean }
  /** How see-through the window is. See ClosetState’s own doc comment. */
  | { readonly kind: "opacity"; readonly percent: number }
  | { readonly kind: "habit"; readonly habit: string; readonly on: boolean }
  | { readonly kind: "muted"; readonly on: boolean }
  /** How much of the time Loaf may listen. See voice/mode.ts. */
  | { readonly kind: "listenMode"; readonly mode: ListenMode }
  /** Which local voice speaks. Null means let Loaf choose. */
  | { readonly kind: "voice"; readonly name: string | null }
  /** A wake word of your own. Null restores the built-in ones. */
  | { readonly kind: "wakeWord"; readonly word: string | null }
  /** How long to hold the cursor on Loaf before the microphone opens. */
  | { readonly kind: "hoverListenMs"; readonly ms: number }
  /** Which recogniser to use. See voice/engine.ts. */
  | { readonly kind: "engine"; readonly id: EngineId }
  /** Fetch and install the Whisper engine. Never triggered by picking it. */
  | { readonly kind: "engine.download" }
  /** An empty or whitespace-only name is how the user resets to the default. */
  | { readonly kind: "rename"; readonly name: string };

/**
 * Validate a pick that arrived over the event bus.
 *
 * Both ends are ours, but the payload still crosses a window boundary, and the
 * companion acts on this by changing what is on the user's screen and writing
 * to storage. Checked rather than trusted.
 */
/**
 * Validate a state broadcast before rendering from it.
 *
 * Same reasoning as `isClosetPick`: ours or not, it crossed a window boundary,
 * and this one decides what eighteen cards say.
 */
export function isClosetState(v: unknown): v is ClosetStatePayload {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.companionId !== "string" || s.companionId.length === 0) return false;
  if (typeof s.outfitId !== "string" || s.outfitId.length === 0) return false;
  if (typeof s.pixelated !== "boolean") return false;
  if (typeof s.opacity !== "number" || !Number.isFinite(s.opacity)) return false;
  if (typeof s.names !== "object" || s.names === null || Array.isArray(s.names)) {
    return false;
  }
  if (typeof s.muted !== "boolean") return false;
  if (
    typeof s.habits !== "object" ||
    s.habits === null ||
    Array.isArray(s.habits) ||
    !Object.values(s.habits as Record<string, unknown>).every((h) => typeof h === "boolean")
  ) {
    return false;
  }
  return Object.values(s.names as Record<string, unknown>).every(
    (n) => typeof n === "string",
  );
}

/** The shape carried by `CLOSET_CHANGED_EVENT`. Mirrors `ClosetState`. */
export interface ClosetStatePayload {
  readonly companionId: string;
  readonly outfitId: string;
  readonly pixelated: boolean;
  /** How see-through the window is, 40 to 100. See ClosetState's own doc. */
  readonly opacity: number;
  readonly names: Readonly<Record<string, string>>;
  readonly habits: Readonly<Record<string, boolean>>;
  readonly muted: boolean;
  readonly listenMode: ListenMode;
  /** Local voices only — a remote one is never offered. */
  readonly voices: readonly string[];
  readonly voice: string | null;
  /** The chosen wake word, or null for the built-in ones. */
  readonly wakeWord: string | null;
  readonly hoverListenMs: number;
  readonly engine: EngineId;
  /** What each engine needs before it can run. */
  readonly engineAvailability: EngineAvailability;
  /** Progress of an in-flight Whisper download, or null when none is running. */
  readonly whisperDownload: { downloaded: number; total: number } | null;
}

export function isClosetPick(v: unknown): v is ClosetPick {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  switch (p.kind) {
    case "companion":
    case "outfit":
      return typeof p.id === "string" && p.id.length > 0;
    case "pixelated":
    case "muted":
      return typeof p.on === "boolean";
    case "opacity":
      return typeof p.percent === "number" && Number.isFinite(p.percent);
    case "habit":
      return isHabit(p.habit) && typeof p.on === "boolean";
    case "listenMode":
      // Validated rather than trusted: this one decides whether a
      // microphone is opened.
      return isListenMode(p.mode);
    case "voice":
      return p.name === null || typeof p.name === "string";
    case "wakeWord":
      return p.word === null || typeof p.word === "string";
    case "hoverListenMs":
      return typeof p.ms === "number" && p.ms >= 1000 && p.ms <= 30000;
    case "engine":
      // Checked rather than trusted: one of these sends audio off the
      // machine.
      return isEngineId(p.id);
    case "engine.download":
      return true;
    case "rename":
      return typeof p.name === "string";
    default:
      return false;
  }
}
