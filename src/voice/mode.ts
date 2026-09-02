/**
 * How much of the time the microphone is open, as a single explicit choice.
 *
 * WHY A MODE RATHER THAN A SWITCH. "Voice on/off" hides the only question that
 * actually matters, which is not whether Loaf can hear you but *when*. A wake
 * word and a button are not two settings of one feature; they are different
 * bargains, and the user should be picking between them with the difference in
 * front of them rather than discovering it later.
 *
 * The modes are ordered by how much microphone access they need, and that order
 * is enforced by `NEEDS_MICROPHONE` below so a new mode cannot be slipped in
 * without deciding where it sits.
 */

export const LISTEN_MODES = ["off", "push", "hover", "always"] as const;
export type ListenMode = (typeof LISTEN_MODES)[number];

/** The default. Not a placeholder — see `DESCRIPTIONS.off`. */
export const DEFAULT_LISTEN_MODE: ListenMode = "off";

export function isListenMode(v: unknown): v is ListenMode {
  return typeof v === "string" && (LISTEN_MODES as readonly string[]).includes(v);
}

/** Short labels, for the setting itself. */
export const LABELS: Readonly<Record<ListenMode, string>> = {
  off: "Never",
  push: "When I press the microphone button",
  hover: "While I hold the cursor on Loaf",
  always: "Always — listen for “Hey Loaf”",
};

/**
 * What each mode actually costs, in the words the user needs to decide.
 *
 * These are shown next to the choice rather than buried in a help page. A
 * setting that changes when a microphone is open should say so at the moment
 * it is chosen.
 */
export const DESCRIPTIONS: Readonly<Record<ListenMode, string>> = {
  off: "The microphone is never opened. Typed commands still work.",
  push:
    "The microphone opens for one sentence when you press the microphone " +
    "button on the dashboard, then closes. Audio is processed on this device.",
  hover:
    "Hovering shows the day's card. Hold the cursor there longer and the " +
    "microphone opens, then closes when you move away. Audio is processed on " +
    "this device.",
  always:
    "Microphone stays active and listens for your wake word. Audio is processed on this " +
    "device. Loaf can only recognise its own list of phrases, so it cannot transcribe a " +
    "conversation — but the microphone is genuinely open the whole time.",
};

/** Whether the mode ever opens the microphone at all. */
export const NEEDS_MICROPHONE: Readonly<Record<ListenMode, boolean>> = {
  off: false,
  push: true,
  hover: true,
  always: true,
};

/** Whether the mode holds the microphone open rather than opening it per use. */
export function isContinuous(mode: ListenMode): boolean {
  return mode === "always";
}

/** Whether Loaf should answer to a wake word in this mode. */
export function usesWakeWord(mode: ListenMode): boolean {
  return mode === "always";
}

/**
 * Whether moving from `from` to `to` gives Loaf more access than it had.
 *
 * Used to decide when to say something. Reducing access is a quiet change;
 * increasing it is one the user should see confirmed, because the whole point
 * of the setting is that nobody should be surprised by it later.
 */
export function widensAccess(from: ListenMode, to: ListenMode): boolean {
  return LISTEN_MODES.indexOf(to) > LISTEN_MODES.indexOf(from);
}

/** Read a stored value, falling back to off rather than to anything louder. */
export function readListenMode(raw: unknown): ListenMode {
  return isListenMode(raw) ? raw : DEFAULT_LISTEN_MODE;
}
