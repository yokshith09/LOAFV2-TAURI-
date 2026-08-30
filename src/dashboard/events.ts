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
export const COMMANDS = ["reset", "sites:forget", "radar:on"] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(v: unknown): v is Command {
  return typeof v === "string" && (COMMANDS as readonly string[]).includes(v);
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
