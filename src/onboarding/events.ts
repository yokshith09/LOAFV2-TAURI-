/**
 * What the consent screen sends back.
 *
 * Deliberately tiny. This window asks one question, and the answer to it turns
 * on the only feature in the app that reads anything outside itself — so the
 * payload is a single word and every other word is rejected.
 */

export const ONBOARD_DECISION_EVENT = "loaf://onboard/decision";
export const ONBOARD_STATE_EVENT = "loaf://onboard/state";
export const ONBOARD_HELLO_EVENT = "loaf://onboard/hello";

export const DECISIONS = ["yes", "no", "settings", "close"] as const;
export type Decision = (typeof DECISIONS)[number];

export function isDecision(v: unknown): v is Decision {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}
