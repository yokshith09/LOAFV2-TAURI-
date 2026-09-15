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

import { spell } from "../focus/timer";

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

/**
 * What he says when a focus session runs out.
 *
 * `planned` is the time the session actually took, not the length it was
 * started at — the timer keeps `duration` at spent + left precisely so this
 * quotes a number the user would recognise even after a "-5".
 */
export function sessionDoneLine(planned: number): string {
  return `${spell(planned)} done. 🍅
Stand up. Look out a window. I'll be here.`;
}

/**
 * The rest of what he says. Ported from the `bubble.show` calls scattered
 * through `AppDelegate.swift`.
 *
 * Gathered here rather than written at each call site so the voice stays one
 * voice — the reference's lines are its best feature and they are easy to
 * dilute one well-meaning string at a time.
 */
export const LINES = {
  praiseForClosing: (count: number) => `Down to ${count}. Thank you. Genuinely.`,
  radarOn: "Radar on. Domains only — never the page.",
  radarOff: "Radar off. I'll stop asking your browser anything.",
  radarDeclined: `Fine. Apps only, then.
Turn the radar on whenever — right-click me.`,
  resetToday: "Fine. Today never happened. 🫥",
  forgetSites: "Every domain I'd written down — gone. 🧽",
  soundsFolder: `Drop files in there — finish.wav, tantrum.mp3, greeting.m4a.
Yours win over mine.`,
  packsFolder: `Draw one and drop the folder in there.
There's a READ ME with the shape of it.`,
  pixelOn: "Low resolution. High opinions.",
  pixelOff: "Back to smooth.",
  muted: "Quiet, then.",
  unmuted: "Noise restored.",
} as const;

/** What he says when you rename him, or put the name back. */
export function renameLine(name: string, isDefault: boolean): string {
  return isDefault ? `${name} it is. Again.` : `${name}. I'll answer to that.`;
}

/** Greeting when a character comes on duty from the closet. */
export function closetGreeting(name: string, species: string): string {
  return `${name} here — ${species.toLowerCase()}, on duty.
Same job, whichever animal you pick.`;
}

/** The About line. Everything it claims has to stay true. */
export function aboutLine(name: string): string {
  return (
    `${name} here — Loaf, rewritten for Mac and Windows.
` +
    `Same job either way. Nothing I know leaves this computer.`
  );
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

/**
 * What to say when Claude asks Loaf something, named by the tool it used.
 *
 * The TOOL, not a generic line, because which question was asked is the part
 * worth knowing — "something happened" is not disclosure, and this app has
 * always chosen to say out loud when something reads your day. Falls back to a
 * plain sentence for a tool this build has never heard of, which is what a
 * newer server talking to an older companion looks like.
 *
 * Every line names Claude, so it can never be mistaken for Loaf itself doing
 * the asking.
 */
export function claudeAskedLine(tool: string): string {
  switch (tool) {
    case "screen_time_today":
      return "Claude is looking at today.";
    case "screen_time_range":
    case "screen_time_history":
      return "Claude is reading back over your week.";
    case "top_apps":
      return "Claude is asking what you have been in.";
    case "meetings":
    case "meeting_notes":
      return "Claude is going through your meetings.";
    default:
      return "Claude is asking Loaf something.";
  }
}

/**
 * What to say when Claude stops asking, which is the only sign a task ended.
 *
 * Rotates, because this fires after every piece of work and one fixed sentence
 * becomes wallpaper within a day — the same reason `PromptRotation` exists for
 * the break prompts.
 */
const CLAUDE_DONE_LINES: readonly string[] = [
  "Claude is done with that one.",
  "That is Claude finished. Anything good?",
  "All quiet again. Claude got what it needed.",
  "Done. Claude has stopped asking.",
];

export function claudeDoneLine(at: number = Date.now()): string {
  const i = Math.floor(at / 1000) % CLAUDE_DONE_LINES.length;
  return CLAUDE_DONE_LINES[i]!;
}

/**
 * What to say for a `report_status` call — Claude Code (or anything else
 * working alongside you) telling Loaf about a build, a push, a deploy.
 *
 * FIXED COPY, KEYED BY A FIXED ENUM — see the note on `report_status` in
 * `mcp_stdio.rs`. The caller picks a status word, never the sentence, so
 * there is nothing here an assistant confused by something it read could
 * put in Loaf's mouth. An unrecognised status (an older companion talking to
 * a newer server that added one) falls back to a plain, honest line rather
 * than silence.
 */
export function claudeStatusLine(status: string): string {
  switch (status) {
    case "thinking":
      return "Claude is thinking this through.";
    case "working":
      return "Claude is working on it.";
    case "build_passed":
      return "Build passed.";
    case "build_failed":
      return "Build failed.";
    case "checks_passed":
      return "Checks passed.";
    case "checks_failed":
      return "Checks failed.";
    case "pushed":
      return "Pushed to GitHub.";
    case "deploy_succeeded":
      return "Deploy succeeded.";
    case "deploy_failed":
      return "Deploy failed.";
    case "done":
      return claudeDoneLine();
    default:
      return "Claude reported something Loaf does not recognise yet.";
  }
}

/** The statuses that read as good news — the "proud" mood, not "worried". */
const GOOD_STATUSES: ReadonlySet<string> = new Set([
  "build_passed",
  "checks_passed",
  "pushed",
  "deploy_succeeded",
  "done",
]);

/** The statuses that read as bad news — the "worried" mood. */
const BAD_STATUSES: ReadonlySet<string> = new Set([
  "build_failed",
  "checks_failed",
  "deploy_failed",
]);

/** Whether this status is a finished result (good or bad) rather than ongoing work. */
export function isTerminalStatus(status: string): boolean {
  return GOOD_STATUSES.has(status) || BAD_STATUSES.has(status);
}

export function statusReadsAsGoodNews(status: string): boolean {
  return GOOD_STATUSES.has(status);
}
