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
] as const;
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
