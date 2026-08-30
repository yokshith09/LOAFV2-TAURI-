/**
 * What Loaf says, and when. Ported from the prompt tables in `AppDelegate.swift`.
 */

/** The fifteen-minute nudge. Rotated, never random. */
export const BREAK_PROMPTS: readonly string[] = [
  "15 minutes down. 💧 Did you have water?",
  "Eyes need a break too. 👀 Look at something 20 feet away for 20 seconds.",
  "Stand up and stretch for a sec. 🙆",
  "Blink a few times — screens dry your eyes out. 😌",
];

/**
 * Hands out prompts in order and wraps.
 *
 * Rotation rather than a random pick, because random repeats: over a long day
 * a four-item table draws the same line twice in a row often enough to notice,
 * and the second time it reads as the app being stuck rather than as advice.
 */
export class PromptRotation {
  private index = 0;
  constructor(private readonly prompts: readonly string[]) {
    if (prompts.length === 0) throw new Error("a rotation needs prompts");
  }
  next(): string {
    const p = this.prompts[this.index % this.prompts.length]!;
    this.index++;
    return p;
  }
}

/**
 * What he says about your tabs. `%d` is the count, `%s` the browser.
 *
 * Rotated like the break prompts, and for the same reason — but this one is
 * seen far less often, so the rotation matters more per line, not less.
 */
export const TANTRUM_PROMPTS: readonly string[] = [
  "%d tabs. I counted them. Twice.",
  "%d tabs open in %s. Pick five. Close them.",
  "%d tabs. Your computer is fine. I am not.",
];

const tantrumRotation = new PromptRotation(TANTRUM_PROMPTS);

export function tantrumLine(count: number, browser: string): string {
  return tantrumRotation.next().replace("%d", String(count)).replace("%s", browser);
}

/** How long a nudge stays up, in seconds. Matches the reference. */
export const BREAK_BUBBLE_SECONDS = 12;

/** Hover before the preview card appears, in milliseconds. */
export const HOVER_DWELL_MS = 350;

/**
 * Whether the fifteen-minute nudge is allowed to interrupt right now.
 *
 * A focus session is a deliberate promise not to be interrupted, so the nudge
 * stands down while one runs — otherwise a 90-minute session collects five
 * interruptions from the very app you told to leave you alone. The session's
 * own completion is the break prompt, and it lands at a moment you chose.
 */
export function mayNudge(focusRunning: boolean): boolean {
  return !focusRunning;
}
