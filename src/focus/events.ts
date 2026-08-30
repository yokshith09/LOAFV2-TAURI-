import type { TimerState } from "./timer";
import type { FocusSnapshot } from "./view";

/**
 * What the focus window and the companion say to each other.
 *
 * Same division as the closet and the dashboard: the window reports clicks, the
 * companion owns the timer and broadcasts what changed. The timer is already
 * persisted and already drives the ring on the character, so a second copy of
 * it in this window would be a second answer to "how long is left".
 */

export const FOCUS_COMMAND_EVENT = "loaf://focus/command";
export const FOCUS_STATE_EVENT = "loaf://focus/state";
/** Window -> companion: "I have just opened, tell me where the timer is." */
export const FOCUS_HELLO_EVENT = "loaf://focus/hello";

export type FocusCommand =
  | { readonly kind: "preset"; readonly minutes: number }
  | { readonly kind: "adjust"; readonly minutes: number }
  | { readonly kind: "toggle" }
  | { readonly kind: "reset" };

const TIMER_STATES: readonly TimerState[] = ["idle", "running", "paused", "finished"];

/**
 * Parse a command that crossed the bus.
 *
 * The minute values decide how long someone's session is, so they are bounded
 * here rather than trusted: an unchecked number reaches `setDurationSeconds` and
 * `adjust`, and while both clamp, a NaN would sail through the clamp and put
 * `NaN:NaN` on the dial.
 */
export function isFocusCommand(v: unknown): v is FocusCommand {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  switch (c.kind) {
    case "toggle":
    case "reset":
      return true;
    case "preset":
    case "adjust":
      return (
        typeof c.minutes === "number" &&
        Number.isFinite(c.minutes) &&
        Math.abs(c.minutes) <= 24 * 60
      );
    default:
      return false;
  }
}

/** Parse the `data-focus-cmd` attribute the markup carries. */
export function parseCommand(raw: string): FocusCommand | null {
  if (raw === "toggle") return { kind: "toggle" };
  if (raw === "reset") return { kind: "reset" };
  const [kind, value] = raw.split(":", 2);
  // `Number("")` is 0, not NaN, so an empty value would otherwise parse as a
  // zero-minute session rather than being rejected.
  if (value === undefined || value.trim() === "") return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return null;
  if (kind === "preset") return { kind: "preset", minutes };
  if (kind === "adjust") return { kind: "adjust", minutes };
  return null;
}

export function isFocusSnapshot(v: unknown): v is FocusSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!TIMER_STATES.includes(s.state as TimerState)) return false;
  if (typeof s.duration !== "number" || !Number.isFinite(s.duration)) return false;
  if (s.endsAt !== null && typeof s.endsAt !== "number") return false;
  if (s.pausedRemaining !== null && typeof s.pausedRemaining !== "number") return false;
  return true;
}
