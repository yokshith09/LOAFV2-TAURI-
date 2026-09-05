/**
 * What you can ask Loaf to do, and how the words become an action.
 *
 * This is the half of "voice" that can be built and proved without a
 * microphone. Speech recognition turns sound into a string; everything after
 * that is this file, and it is the same work whether the string arrived from a
 * microphone, a command box, or a test.
 *
 * Building it this way round is deliberate. The recogniser is the part that
 * cannot be unit-tested, needs a permission, differs per platform and may send
 * audio to a server if a flag is missed. The parser is the part that decides
 * what actually happens, and it can be exhaustively tested today. If the parser
 * is right, adding a recogniser is plumbing; if the parser is wrong, no amount
 * of recognition accuracy saves it.
 *
 * TWO RULES, both of which exist because a misheard sentence is a normal event
 * rather than an exceptional one:
 *
 *  1. UNRECOGNISED MEANS UNRECOGNISED. A sentence that does not clearly match
 *     returns null. Guessing the nearest command is how "set a timer" becomes
 *     "reset today" and somebody loses their history to a cough.
 *
 *  2. DESTRUCTIVE INTENTS ASK FIRST. Anything that deletes carries
 *     `confirm: true`, and the caller must not act on it without a yes. Speech
 *     is the least reliable input the app has, so it gets the strictest gate.
 */

import { PRIORITIES, type Priority } from "../tasks/tasks";

export type Intent =
  | { readonly kind: "focus.start"; readonly minutes: number }
  | { readonly kind: "focus.stop" }
  | { readonly kind: "task.add"; readonly title: string; readonly priority: Priority; readonly minutes: number | null }
  | { readonly kind: "sleep" }
  | { readonly kind: "wake" }
  | { readonly kind: "open"; readonly what: "dashboard" | "closet" | "timer" }
  | { readonly kind: "recap" }
  | { readonly kind: "report.today" }
  | { readonly kind: "volume.set"; readonly percent: number }
  | { readonly kind: "volume.mute"; readonly on: boolean }
  | { readonly kind: "brightness.set"; readonly percent: number }
  | { readonly kind: "media"; readonly key: string }
  | { readonly kind: "click"; readonly target: string }
  | { readonly kind: "level.ask"; readonly what: "volume" | "brightness" }
  /** Hand over to Windows' own voice typing. See the note in the parser. */
  | { readonly kind: "dictate" }
  /** Typed only — see the note in the parser. */
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "app.open"; readonly app: string }
  | { readonly kind: "app.close"; readonly app: string }
  /**
   * Record YOUR OWN microphone for the meeting in progress.
   *
   * Carries `confirm` for the same reason deleting does, and a stronger one:
   * it is the only command in Loaf whose effect reaches other people. The
   * confirmation is where the user states that everyone knows.
   */
  | { readonly kind: "record.start"; readonly confirm: true }
  | { readonly kind: "record.stop" }
  | { readonly kind: "reset.today"; readonly confirm: true }
  | { readonly kind: "forget.sites"; readonly confirm: true }
  /**
   * Throw away every kept transcript.
   *
   * Confirmed like the other two destructive ones. Reached from a button
   * rather than a sentence today — there is deliberately no spoken phrase for
   * it, because "delete all my notes" is not something to be one mishearing
   * away from.
   */
  | { readonly kind: "meetings.forget"; readonly confirm: true };

/** Sessions Loaf will start from a sentence. Matches the timer's own presets. */
export const MIN_SESSION_MINUTES = 1;
export const MAX_SESSION_MINUTES = 180;

/** Used when a focus request names no length. The reference's default. */
export const DEFAULT_SESSION_MINUTES = 25;

/**
 * Flatten a sentence to something the patterns below can match.
 *
 * WIDER THAN IT USED TO BE, BECAUSE WHISPER WRITES LIKE A PERSON. The closed
 * Windows grammar could only ever return one of the phrases it was given —
 * bare words, no punctuation — so stripping `.,!?` was enough. Whisper returns
 * real prose: em dashes, semicolons, quotation marks, and hyphenated numbers.
 * "Twenty-five minutes" is the one that actually bites: the spoken-number table
 * has "twenty" and "five" as separate words, so a hyphen turned a working
 * command into an unrecognised one.
 *
 * The apostrophe is deliberately KEPT. Stripping it turns "don't" into "don t",
 * which breaks more than it fixes.
 */
function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?;:"“”]+/g, " ")
    // Dashes become spaces rather than vanishing, or "twenty-five" would
    // collapse to the single unknown word "twentyfive".
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Minutes from now until a clock time somebody named, or null.
 *
 * "Remind me about the meeting at 10" is how people actually say this, and the
 * parser understood only "in ninety minutes" -- which means doing the
 * subtraction in your head, at the exact moment you are trying to write
 * something down so you do not have to think about it.
 *
 * `now` is injected so the rules that matter -- rolling to tomorrow, choosing
 * between 10am and 10pm -- can be tested at a fixed time rather than whenever
 * the suite happens to run.
 *
 * THE AMBIGUOUS CASE, decided deliberately: a bare "at 10" with no am or pm
 * means the NEXT ten o'clock, morning or evening, whichever comes first.
 * Someone saying it at nine in the morning means an hour away, and someone
 * saying it at nine at night means an hour away too. Reading it as 24-hour
 * would turn the second into a thirteen-hour wait.
 */
export function minutesUntilClockTime(text: string, now: Date): number | null {
  const t = normalise(text);
  // "at" is required. Without it, "focus for 10" would become ten o'clock --
  // exactly the guess rule 1 at the top of this file forbids.
  // The separator allows a SPACE as well as ":" and ".", because
  // `normalise` above strips colons — it has to, so that Whisper's prose
  // punctuation does not defeat the command patterns. That turns "10:15"
  // into "10 15" long before it reaches here, and a pattern that only knew
  // about colons quietly read it as ten o'clock.
  const m = t.match(/\bat\s+(\d{1,2})(?:[:. ](\d{2}))?\s*(am|pm|o clock|oclock)?/);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3];
  if (hour < 1 || hour > 24 || minute > 59) return null;

  if (suffix === "pm" && hour < 12) hour += 12;
  else if (suffix === "am" && hour === 12) hour = 0;
  else if (hour === 24) hour = 0;

  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  if (suffix === undefined && hour < 12) {
    const evening = new Date(target);
    evening.setHours(hour + 12);
    if (target.getTime() <= now.getTime() && evening.getTime() > now.getTime()) {
      return Math.round((evening.getTime() - now.getTime()) / 60_000);
    }
  }
  // A time that has already gone means tomorrow. A reminder set for a moment
  // in the past is the one answer that is certainly wrong.
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);

  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  return minutes > 0 ? minutes : null;
}

/**
 * Numbers people say out loud, as well as digits.
 *
 * A recogniser hands back "twenty five" as often as "25", and a parser that
 * only understood digits would fail on half of what it heard while looking like
 * it had misunderstood the command rather than the number.
 */
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Pull a number of minutes out of a sentence, or null.
 *
 * Handles "25", "twenty five", "half an hour", "an hour". Hours are converted
 * rather than rejected: somebody who says "focus for an hour" has been perfectly
 * clear and should not be told to rephrase.
 */
export function minutesIn(text: string): number | null {
  const t = normalise(text);

  if (/\bhalf an hour\b/.test(t)) return 30;
  if (/\bquarter of an hour\b/.test(t)) return 15;

  const hourDigits = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (hourDigits) return Math.round(Number(hourDigits[1]) * 60);
  if (/\b(?:an?|one)\s+hours?\b/.test(t)) return 60;
  const hourWords = t.match(/\b(\w+)\s+hours?\b/);
  if (hourWords && WORD_NUMBERS[hourWords[1]!] !== undefined) {
    return WORD_NUMBERS[hourWords[1]!]! * 60;
  }

  const digits = t.match(/(\d+)\s*(?:minutes?|mins?|m)?\b/);
  if (digits) return Number(digits[1]);

  // "twenty five" — two words that add up.
  const compound = t.match(/\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/);
  if (compound) {
    return WORD_NUMBERS[compound[1]!]! + WORD_NUMBERS[compound[2]!]!;
  }
  const single = t.match(/\b(\w+)\s*(?:minutes?|mins?)\b/);
  if (single && WORD_NUMBERS[single[1]!] !== undefined) return WORD_NUMBERS[single[1]!]!;

  return null;
}

/**
 * A percentage out of a sentence, or null.
 *
 * Separate from `minutesIn` because the two disagree about bare numbers: in
 * "focus for 25" the number is minutes, and in "set volume to 25" it is a
 * percent. Sharing one parser would make each of them slightly wrong.
 */
export function percentIn(text: string): number | null {
  const t = normalise(text);
  if (/\bhalf\b/.test(t)) return 50;
  if (/\b(max|maximum|full|all the way)\b/.test(t)) return 100;
  if (/\b(min|minimum|zero|silent)\b/.test(t)) return 0;

  const digits = t.match(/(\d{1,3})\s*(?:percent|%)?\b/);
  if (digits) {
    const value = Number(digits[1]);
    return value >= 0 && value <= 100 ? value : null;
  }
  const compound = t.match(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/,
  );
  if (compound) {
    const tens = WORD_NUMBERS[compound[1]!];
    const ones = WORD_NUMBERS[compound[2]!];
    if (tens !== undefined && ones !== undefined) return tens + ones;
  }
  const single = t.match(
    /\b(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one hundred|hundred)\b/,
  );
  if (single) {
    const word = single[1]!;
    if (word === "hundred" || word === "one hundred") return 100;
    const value = WORD_NUMBERS[word];
    if (value !== undefined) return value;
  }
  return null;
}

function clampSession(minutes: number): number | null {
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  if (rounded < MIN_SESSION_MINUTES || rounded > MAX_SESSION_MINUTES) return null;
  return rounded;
}

function priorityIn(text: string): Priority {
  const t = normalise(text);
  if (/\b(urgent|now|asap|immediately|first)\b/.test(t)) return "now";
  if (/\b(whenever|sometime|eventually|low priority|no rush)\b/.test(t)) return "whenever";
  return "soon";
}

/**
 * Everything after the word that introduced the task.
 *
 * Kept as the user said it rather than cleaned up: a task is a note to
 * yourself, and a parser that tidied the wording would produce a list of things
 * you did not quite write.
 */
function titleAfter(raw: string, marker: RegExp): string | null {
  const match = raw.match(marker);
  if (!match || match.index === undefined) return null;
  const rest = raw.slice(match.index + match[0].length).trim();
  // Strip a trailing priority or timer phrase, which belongs to the command
  // rather than to the sentence you meant to keep.
  const cleaned = rest
    // Everything from "in"/"after" up to and including the unit. The earlier
    // version expected exactly one word before the unit, so it stripped
    // "in 30 minutes" and left "in half an hour" sitting in the task title.
    .replace(/\b(?:in|after)\s+[^,]*?\b(?:minutes?|mins?|hours?|hrs?)\b.*$/i, "")
    .replace(/\b(?:priority\s+)?(?:urgent|asap|whenever|sometime|eventually|no rush)\b\s*$/i, "")
    .replace(/[,\s]+$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Turn a sentence into something to do, or null.
 *
 * Null is a real and common answer. See rule 1 at the top of this file: the
 * caller should say it did not understand, never do the closest thing.
 */
export function parseIntent(raw: string, now: Date = new Date()): Intent | null {
  if (typeof raw !== "string") return null;
  const t = normalise(raw);
  if (t.length === 0) return null;

  // --- Recording first, alongside the destructive commands and for the same
  // --- reason: it must never be reached by a partial match on something else.
  if (/\b(stop|end|finish)\b.*\brecord(ing)?\b/.test(t)) {
    return { kind: "record.stop" };
  }
  if (/\brecord(ing)?\b/.test(t) && /\b(this|the|meeting|call|me|start|begin)\b/.test(t)) {
    return { kind: "record.start", confirm: true };
  }

  // --- Destructive next, so a partial match on something else cannot shadow
  // --- them and quietly become the wrong action.
  if (/\b(reset|clear|wipe|delete)\b.*\b(today|stats|screen ?time)\b/.test(t)) {
    return { kind: "reset.today", confirm: true };
  }
  if (/\b(forget|clear|delete|wipe)\b.*\b(sites?|domains?|browsing|site data)\b/.test(t)) {
    return { kind: "forget.sites", confirm: true };
  }

  // --- Focus sessions
  if (/\b(stop|cancel|end|abandon)\b.*\b(focus|session|timer)\b/.test(t)) {
    return { kind: "focus.stop" };
  }
  if (/\b(focus|session|pomodoro|deep work|work)\b/.test(t) && /\b(start|begin|do|let'?s|for|set)\b/.test(t)) {
    const minutes = clampSession(minutesIn(t) ?? DEFAULT_SESSION_MINUTES);
    // A named length outside what the timer accepts is a misheard number far
    // more often than a real request, so it is refused rather than clamped into
    // something the user did not ask for.
    return minutes === null ? null : { kind: "focus.start", minutes };
  }

  // --- Tasks
  // "remind me ABOUT the meeting at 10" is how people phrase a reminder for
  // a thing rather than an action, and it used to return null — no note, no
  // reply that made sense, just nothing. "to" is for things you will do and
  // "about"/"of" for things that will happen, and both are reminders.
  const taskMarker =
    /\b(?:add(?: a)?(?: new)? (?:task|note|reminder)|remind me (?:to|about|of)|note down|task)\b:?\s*/i;
  if (taskMarker.test(raw)) {
    const title = titleAfter(raw, taskMarker);
    if (title === null) return null;
    // A clock time first, then a relative one. "at 10" and "in 10" are
    // different requests, and "at" is checked first so that "in ten minutes
    // at the latest" is not read as ten o'clock.
    const clock = minutesUntilClockTime(t, now);
    const minutes =
      clock !== null ? clock : /\b(?:in|after)\b/.test(t) ? minutesIn(t) : null;
    return {
      kind: "task.add",
      title,
      priority: priorityIn(t),
      minutes: minutes !== null && minutes > 0 ? minutes : null,
    };
  }

  // --- Sleep and waking
  if (/\b(go to sleep|sleep now|be quiet|go quiet|shush|hush|quiet down)\b/.test(t)) {
    return { kind: "sleep" };
  }
  if (/\b(wake up|wake|come back)\b/.test(t)) return { kind: "wake" };

  // --- Windows
  if (/\b(closet|wardrobe|outfit|change character)\b/.test(t)) {
    return { kind: "open", what: "closet" };
  }
  if (/\b(timer|stopwatch)\b/.test(t) && /\b(open|show|bring up)\b/.test(t)) {
    return { kind: "open", what: "timer" };
  }
  if (/\b(dashboard|screen ?time|stats|my day|my time)\b/.test(t) && /\b(open|show|bring up|see)\b/.test(t)) {
    return { kind: "open", what: "dashboard" };
  }

  // --- The machine itself.
  //
  // Before programs, so a machine with something called "Volume" installed
  // cannot shadow the volume control.
  if (/\b(volume|sound)\b/.test(t) && /\b(set|change|turn|make|put)\b/.test(t)) {
    const percent = percentIn(t.replace(/\b(volume|sound)\b/g, " "));
    if (percent !== null) return { kind: "volume.set", percent };
  }
  if (/\b(mute|silence)\b/.test(t) && !/\bun ?mute\b/.test(t)) {
    return { kind: "volume.mute", on: true };
  }
  if (/\bun ?mute\b/.test(t)) return { kind: "volume.mute", on: false };
  if (/\b(volume|sound)\b/.test(t) && /\b(up|louder|higher)\b/.test(t)) {
    return { kind: "media", key: "volumeup" };
  }
  if (/\b(volume|sound)\b/.test(t) && /\b(down|quieter|lower)\b/.test(t)) {
    return { kind: "media", key: "volumedown" };
  }
  if (/\b(brightness|screen|display)\b/.test(t) && /\b(set|change|turn|make|put|dim)\b/.test(t)) {
    const percent = percentIn(t.replace(/\b(brightness|screen|display)\b/g, " "));
    if (percent !== null) return { kind: "brightness.set", percent };
  }

  if (/\b(how (?:loud|high)|what.*volume)\b/.test(t)) {
    return { kind: "level.ask", what: "volume" };
  }
  // --- Windows' own dictation.
  //
  // This opens the Win+H voice-typing bar and stops there. Loaf NEVER SEES THE
  // TEXT: Windows types it straight into whatever has focus, and there is no
  // API to read it back. That is what makes it nearly free — it is a keystroke,
  // not a recogniser — and also why it cannot feed Loaf's parser.
  //
  // Whether it runs on the machine or in Microsoft's cloud is decided by
  // Windows' own privacy setting, not by Loaf, so this makes no claim about it.
  if (/\b(dictate|dictation|voice typing|type what i say)\b/.test(t)) {
    return { kind: "dictate" };
  }
  if (/\b(how bright|what.*brightness)\b/.test(t)) {
    return { kind: "level.ask", what: "brightness" };
  }

  // --- Typing text out.
  //
  // Reachable from the command box and NOT from the microphone, and that is
  // not an oversight: knowing what to type means free-form speech, and
  // free-form speech on Windows is the online recogniser. It is deliberately
  // absent from phrases.ts. See speech.rs.
  const typing = raw.match(/^\s*type\s+(.+)$/i);
  if (typing && typing[1]) {
    const text = typing[1].trim();
    if (text.length > 0) return { kind: "type", text };
  }

  // --- Media keys. Whole-phrase matches, because "play" inside a longer
  // --- sentence is far more often a word than a command.
  const MEDIA: Readonly<Record<string, string>> = {
    play: "playpause",
    pause: "playpause",
    "play pause": "playpause",
    "next track": "nexttrack",
    "next song": "nexttrack",
    skip: "nexttrack",
    "previous track": "previoustrack",
    "previous song": "previoustrack",
  };
  const media = MEDIA[t];
  if (media !== undefined) return { kind: "media", key: media };

  // --- Clicking something on screen by its name.
  const clicking = t.match(/^(?:please\s+)?(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (clicking && clicking[1]) {
    const target = clicking[1].trim();
    if (target.length > 0) return { kind: "click", target };
  }

  // --- Programs on the machine.
  //
  // Deliberately after Loaf's own windows, so "open the closet" stays the
  // closet even on a machine with a program called Closet. The name is passed
  // through as heard; matching it against what is actually installed happens
  // in Rust, where the list lives and the matching is tested.
  const opening = t.match(/^(?:please\s+)?(?:open|launch|run)\s+(?:up\s+)?(?:my|the|a)?\s*(.+)$/);
  if (opening && opening[1]) {
    const app = opening[1].trim();
    return app.length > 0 ? { kind: "app.open", app } : null;
  }
  // "stop" is deliberately not a closing word: it means the focus session,
  // handled above, and a misheard "stop" shutting a program would be a
  // genuinely bad surprise.
  const closing = t.match(/^(?:please\s+)?(?:close|quit|exit)\s+(?:my|the|a)?\s*(.+)$/);
  if (closing && closing[1]) {
    const app = closing[1].trim();
    return app.length > 0 ? { kind: "app.close", app } : null;
  }

  // --- Reports
  if (/\b(recap|wrapped|my week|week card|share card)\b/.test(t)) return { kind: "recap" };
  if (/\b(how (?:long|much)|what did i do|how am i doing|summar(?:y|ise|ize))\b/.test(t)) {
    return { kind: "report.today" };
  }

  return null;
}

/** True when the caller must get a yes before acting. */
export function needsConfirmation(intent: Intent): boolean {
  return "confirm" in intent && intent.confirm === true;
}

/**
 * What Loaf says back, so the user knows it heard correctly.
 *
 * Every action gets a spoken confirmation naming what it understood. With
 * speech this is not politeness — it is the only way to notice a misheard
 * command before it has already happened.
 */
export function acknowledge(intent: Intent): string {
  switch (intent.kind) {
    case "focus.start":
      return `${intent.minutes} minutes. Starting now.`;
    case "focus.stop":
      return "Stopping the session.";
    case "task.add":
      return intent.minutes === null
        ? `Added: ${intent.title}`
        : `Added: ${intent.title} — I'll say in ${intent.minutes} minutes.`;
    case "sleep":
      return "Going quiet.";
    case "wake":
      return "I'm up.";
    case "open":
      return `Opening the ${intent.what}.`;
    case "volume.set":
      return `Volume ${intent.percent}.`;
    case "volume.mute":
      return intent.on ? "Muted." : "Unmuted.";
    case "brightness.set":
      return `Brightness ${intent.percent}.`;
    case "media":
      return "Done.";
    case "level.ask":
      return `Checking the ${intent.what}.`;
    case "dictate":
      return "Opening Windows voice typing.";
    case "type":
      return `Typing: ${intent.text}`;
    case "click":
      return `Clicking ${intent.target}.`;
    case "app.open":
      return `Opening ${intent.app}.`;
    case "app.close":
      // Named rather than silent. This is what the X button does, so
      // it is not destructive, but a mishearing should still be
      // visible before the window goes.
      return `Closing ${intent.app}.`;
    case "recap":
      return "Drawing your week.";
    case "report.today":
      return "Here's today.";
    case "record.start":
      // Names what it will and will not capture, every time. This is the
      // moment the user decides, so it is the moment it has to be true.
      return (
        "Record your microphone only \u2014 not the other people \u2014 for this meeting? " +
        "Only say yes if everyone here knows. Say yes to start."
      );
    case "record.stop":
      return "Stopping the recording.";
    case "reset.today":
      return "Clear everything recorded today? Say yes to confirm.";
    case "forget.sites":
      return "Forget all site data? Say yes to confirm.";
    case "meetings.forget":
      return "Delete every kept transcript? Say yes to confirm.";
  }
}

/** Whether a reply to a confirmation was a yes. Anything unclear is a no. */
export function isAffirmative(raw: string): boolean {
  return /^\s*(yes|yeah|yep|yup|confirm|do it|go ahead|please do)\b/i.test(raw);
}

/** Exported for the command box's placeholder and the help text. */
export const EXAMPLE_COMMANDS: readonly string[] = [
  "start a 25 minute focus session",
  "remind me to call the bank in 20 minutes",
  "add a task: write the spec, urgent",
  "open the closet",
  "open notepad",
  "close chrome",
  "set volume to fifty",
  "mute",
  "set brightness to seventy",
  "record this meeting",
  "stop recording",
  "how long have I been at it",
  "go quiet",
];

/** Every priority word the parser understands, for documentation and tests. */
export const PRIORITY_WORDS: Readonly<Record<Priority, readonly string[]>> = {
  now: ["urgent", "now", "asap", "immediately", "first"],
  soon: ["soon", "(the default)"],
  whenever: ["whenever", "sometime", "eventually", "low priority", "no rush"],
};

/** Guard so the table above cannot drift from the real priority list. */
export const KNOWN_PRIORITIES: readonly Priority[] = PRIORITIES;
