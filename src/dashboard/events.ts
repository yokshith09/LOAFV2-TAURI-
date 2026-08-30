/**
 * The two events the dashboard window and the companion window speak over.
 *
 * Named in one place because a typo in an event name fails silently — the
 * emitter succeeds, nobody listens, and the button simply does nothing.
 */

/** Dashboard -> companion: the user pressed something. Payload is the command. */
export const COMMAND_EVENT = "loaf://command";

/** Companion -> dashboard: the file changed, re-read it. No payload. */
export const STATS_CHANGED_EVENT = "loaf://stats-changed";

/** Commands the dashboard can send. Anything else is ignored by the companion. */
export const COMMANDS = ["reset", "sites:forget", "radar:on"] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(v: unknown): v is Command {
  return typeof v === "string" && (COMMANDS as readonly string[]).includes(v);
}
