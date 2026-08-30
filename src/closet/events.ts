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
  if (typeof s.names !== "object" || s.names === null || Array.isArray(s.names)) {
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
  readonly names: Readonly<Record<string, string>>;
}

export function isClosetPick(v: unknown): v is ClosetPick {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  switch (p.kind) {
    case "companion":
    case "outfit":
      return typeof p.id === "string" && p.id.length > 0;
    case "pixelated":
      return typeof p.on === "boolean";
    case "rename":
      return typeof p.name === "string";
    default:
      return false;
  }
}
