/**
 * The exact sentences Loaf listens for, and why there is a fixed list at all.
 *
 * WINDOWS OFFERS TWO KINDS OF RECOGNITION AND ONLY ONE OF THEM IS PRIVATE.
 *
 *  - The built-in *dictation* grammar understands anything you say. It also
 *    requires "Online speech recognition" to be switched on in Windows privacy
 *    settings, and when it is on your audio goes to Microsoft's servers. It is
 *    free-form and it is the cloud; those are the same choice.
 *
 *  - A *list constraint* — this file — understands only the sentences it is
 *    given, and runs entirely on the machine with no setting to enable and
 *    nothing sent anywhere.
 *
 * Loaf's whole claim is the second one, so the vocabulary is closed and lives
 * here. `speech.rs` refuses to listen at all if it is handed an empty list,
 * because the fallback for an empty list is dictation and a silent fallback to
 * the cloud is exactly the failure this file exists to prevent.
 *
 * WHAT THIS COSTS. Free text cannot be in a closed vocabulary, so
 * "remind me to call the bank" is not here — a list grammar would have to
 * contain "call the bank" before you said it. Spoken commands are the closed
 * set below; tasks with your own words are typed. That is a real limitation and
 * the honest one: the alternative is sending every task title to a server.
 *
 * Every phrase here is asserted by the tests to parse to a real intent, so this
 * list cannot drift away from `commands.ts` and leave Loaf listening for
 * sentences it would then refuse to act on.
 */

import { MAX_SESSION_MINUTES, MIN_SESSION_MINUTES } from "./commands";

/**
 * Session lengths worth saying out loud.
 *
 * Not every number from 1 to 180: a list constraint gets less accurate as it
 * grows, and nobody says "focus for 67 minutes". These match the timer's own
 * presets, and any other length can still be typed.
 */
export const SPOKEN_SESSION_MINUTES: readonly number[] = [
  5, 10, 15, 20, 25, 30, 45, 60, 90,
];

/** Guard: a preset outside what the timer accepts would be heard and refused. */
export const SESSION_BOUNDS = {
  min: MIN_SESSION_MINUTES,
  max: MAX_SESSION_MINUTES,
} as const;

/**
 * Levels worth saying out loud, for volume and brightness.
 *
 * Steps of ten rather than every number: a list constraint gets less accurate
 * as it grows, and "set the volume to sixty three" is not a thing anyone says.
 */
export const SPOKEN_LEVELS: readonly number[] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

const FIXED_PHRASES: readonly string[] = [
  // Focus
  "start a focus session",
  "stop the focus session",
  "cancel my session",
  "end the timer",

  // Sleep and waking
  "go to sleep",
  "go quiet",
  "be quiet",
  "wake up",

  // Windows
  "open the closet",
  "open the dashboard",
  "show my screen time",
  "open the timer",

  // Reports
  "make my recap",
  "show my wrapped",
  "how long have I been at it",
  "how am I doing",

  // The machine itself.
  "mute",
  "unmute",
  "volume up",
  "volume down",
  "play",
  "pause",
  "next track",
  "previous track",
  "how loud is it",
  "how bright is it",

  // Destructive. They are in the vocabulary because refusing to hear them
  // would not make them safe — it would make them typed. They are heard, then
  // they ask, and the yes has to be heard too.
  "reset today's stats",
  "forget all site data",
];

/**
 * Answers to a confirmation.
 *
 * These have to be in the grammar or the yes to "delete everything?" would be
 * unrecognised and the user would repeat themselves at a microphone that had
 * stopped listening.
 */
export const CONFIRMATION_PHRASES: readonly string[] = [
  "yes",
  "yeah",
  "go ahead",
  "no",
  "cancel",
  "stop",
];

/**
 * Program names Loaf will not turn into "open X" phrases.
 *
 * A Start menu is full of things that are not programs anyone launches by
 * voice, and every extra phrase makes every other phrase slightly harder to
 * recognise. Names with no letters, or absurdly long ones, are nobody's
 * spoken command.
 */
function sayable(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (!/[a-z]/i.test(trimmed)) return false;
  // A name with more than four words is a description, not something said.
  return trimmed.split(/\s+/).length <= 4;
}

/**
 * Everything the recogniser is allowed to hear, in one list.
 *
 * `apps` is the list of installed program names, which is what makes
 * "open Notepad" possible at all: a closed vocabulary cannot contain the word
 * "Notepad" unless something put it there. Passing none is fine and simply
 * means Loaf will not hear program names this time.
 *
 * NOTHING IS SILENTLY DROPPED except by `sayable` above, which is a stated
 * rule rather than a cap: every program that passes it is in the grammar, so
 * "Loaf did not hear it" and "Loaf cannot open it" stay the same answer.
 *
 * Deduplicated because a list constraint with a repeated phrase is a compile
 * error on some Windows builds rather than a harmless duplicate.
 */
export function spokenPhrases(
  apps: readonly string[] = [],
  onScreen: readonly string[] = [],
): readonly string[] {
  const sessions = SPOKEN_SESSION_MINUTES.flatMap((m) => [
    `start a ${m} minute focus session`,
    `focus for ${m} minutes`,
  ]);
  const programs = apps
    .filter(sayable)
    .flatMap((name) => [`open ${name}`, `close ${name}`]);
  const levels = SPOKEN_LEVELS.flatMap((n) => [
    `set volume to ${n}`,
    `set brightness to ${n}`,
  ]);
  // Whatever is clickable in the window in front, right now. Only the
  // one-shot modes can use this: the always-on grammar is compiled once and
  // the front window will have changed by the time you speak.
  const clicks = onScreen.filter(sayable).map((name) => `click ${name}`);
  return [
    ...new Set([
      ...FIXED_PHRASES,
      ...sessions,
      ...CONFIRMATION_PHRASES,
      ...programs.map((p) => p.toLowerCase()),
      ...levels,
      ...clicks.map((p) => p.toLowerCase()),
    ]),
  ];
}
