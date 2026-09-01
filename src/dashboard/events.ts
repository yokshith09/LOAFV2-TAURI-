/**
 * The two events the dashboard window and the companion window speak over.
 *
 * Named in one place because a typo in an event name fails silently — the
 * emitter succeeds, nobody listens, and the button simply does nothing.
 */

import type { RadarSnapshot } from "./html";

/** Dashboard -> companion: the user pressed something. Payload is the command. */
export const COMMAND_EVENT = "loaf://command";

/** Companion -> dashboard: the file changed, re-read it. No payload. */
export const STATS_CHANGED_EVENT = "loaf://stats-changed";

/**
 * Companion -> dashboard: the radar's state, as a `RadarSnapshot`.
 *
 * Sent rather than read, for the same reason the closet's state is sent: the
 * radar lives in the companion's memory and has never been on disk, so there is
 * nothing for another window to read even if it wanted to.
 */
export const RADAR_STATE_EVENT = "loaf://radar/state";
/** Dashboard -> companion: "I have just opened, what does the radar know?" */
export const RADAR_HELLO_EVENT = "loaf://radar/hello";

/** Commands the dashboard can send. Anything else is ignored by the companion. */
export const COMMANDS = [
  "reset",
  "sites:forget",
  "radar:on",
  "radar:off",
  "about",
  // The dashboard is the window people actually find, so it has to be able to
  // reach the rest of the app. Until now the closet and the focus timer were
  // behind a tray icon that Windows hides in an overflow flyout by default.
  "open:closet",
  "open:focus",
  "open:sounds",
  "open:packs",
  // Both hand a fixed URL to the browser. Loaf makes no request itself — see
  // FEEDBACK_URL in lib.rs for why a form inside the app was the wrong shape.
  "open:star",
  "open:feedback",
  // Sends him to sleep now, rather than waiting for the idle threshold. Only an
  // explicit wake ends it — someone who chose this wants him down while they
  // carry on working, so touching the keyboard must not undo it.
  "sleep",
  "wake",
  /** Draw the week as a picture and save it. Nothing is uploaded or posted. */
  "recap",
] as const;

/**
 * Adding and changing tasks.
 *
 * Separate from `Command` because these carry a payload, and validating a
 * string against a fixed list is a different job from validating an object with
 * user text in it. Same reason `tantrum:<n>` is handled apart from the rest.
 */
export interface TaskCommand {
  readonly kind: "task";
  readonly action: "add" | "done" | "remove" | "clear-done";
  /** For `add`. Trimmed and length-capped by the companion, not here. */
  readonly title?: string;
  readonly priority?: string;
  /** Minutes until its timer. Absent or 0 means no timer. */
  readonly minutes?: number;
  /** For `done` and `remove`. */
  readonly id?: string;
}

export function isTaskCommand(v: unknown): v is TaskCommand {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (c.kind !== "task") return false;
  if (
    c.action !== "add" &&
    c.action !== "done" &&
    c.action !== "remove" &&
    c.action !== "clear-done"
  ) {
    return false;
  }
  if (c.title !== undefined && typeof c.title !== "string") return false;
  if (c.priority !== undefined && typeof c.priority !== "string") return false;
  if (c.id !== undefined && typeof c.id !== "string") return false;
  if (
    c.minutes !== undefined &&
    (typeof c.minutes !== "number" || !Number.isFinite(c.minutes))
  ) {
    return false;
  }
  return true;
}

/** Dashboard -> companion: a task was added or changed. */
export const TASK_COMMAND_EVENT = "loaf://task";
/** Companion -> dashboard: the current list, as the only writer sees it. */
export const TASKS_CHANGED_EVENT = "loaf://tasks/changed";

/**
 * Dashboard -> companion: a sentence to interpret.
 *
 * Carries the raw text and nothing else. The companion parses it, because the
 * companion is what can act on the result — a window that decided what a
 * sentence meant and then asked for that action would be inventing authority it
 * does not have.
 */
export const SPOKEN_EVENT = "loaf://spoken";
/** Companion -> dashboard: what it understood, or that it did not. */
export const SPOKEN_REPLY_EVENT = "loaf://spoken/reply";
export type Command = (typeof COMMANDS)[number];

/** Tab counts the tantrum can be set to. 0 is "never complain". */
export const TANTRUM_OPTIONS = [0, 20, 30, 40, 60] as const;

export function isCommand(v: unknown): v is Command {
  if (typeof v !== "string") return false;
  if ((COMMANDS as readonly string[]).includes(v)) return true;
  // `tantrum:<n>`, checked against the offered list rather than parsed as a
  // number: this sets how tolerant he is, and an arbitrary value from the bus
  // has no business becoming a threshold.
  const [kind, value] = v.split(":", 2);
  return kind === "tantrum" && TANTRUM_OPTIONS.some((o) => String(o) === value);
}

/**
 * Validate a radar snapshot before rendering the privacy section from it.
 *
 * Every other cross-window payload is checked; this one decides whether a page
 * tells the user their tab domains are being read, which is the last claim in
 * this app that should be made on trust.
 */
export function isRadarSnapshot(v: unknown): v is RadarSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.available !== "boolean" || typeof s.enabled !== "boolean") return false;
  if (typeof s.readsInsideBrowser !== "boolean") return false;
  if (typeof s.tabThreshold !== "number" || !Number.isFinite(s.tabThreshold)) return false;
  if (s.peakTabsNow !== null && typeof s.peakTabsNow !== "number") return false;
  return Array.isArray(s.statusRows);
}
