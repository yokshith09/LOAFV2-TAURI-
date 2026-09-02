/**
 * Deciding whether you were talking to Loaf.
 *
 * The recogniser matches phrases; it has no idea which of them were addressed
 * to a small cat on your desktop. That decision is here, and it is here rather
 * than in Rust because it is the part with real edge cases: someone says the
 * wake word and then nothing, or says a command four minutes later, or says
 * "hey Loaf" twice. Those are cheap to test and expensive to get wrong.
 *
 * THE SHAPE. Say the wake word, get a short window, say a command. Acting on
 * a command RE-OPENS the window rather than closing it, so a follow-up needs
 * no second wake word — "open Notepad" is usually followed by something else,
 * and a wake word between every step is what makes assistants tiring.
 *
 * SILENCE IS WHAT CLOSES IT. The window is only ever extended by Loaf ACTING;
 * a spell of nothing ends it. That matters, because a window that stayed open
 * on its own would be indistinguishable, from the outside, from an assistant
 * always acting on what it hears.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST, said plainly: the microphone is open the
 * whole time this is switched on. The gate decides what is ACTED ON, not what
 * is heard. The thing that makes always-on listening defensible is the closed
 * grammar in `phrases.ts` — a vocabulary that cannot transcribe a conversation
 * — not this file. See `wake.rs`.
 */

/**
 * What Loaf answers to when nobody has chosen anything else.
 *
 * "loaf" alone is included because the recogniser reliably drops the "hey",
 * and a wake word that only works when every syllable is heard is one people
 * give up on. The cost is that the name of the app, said in conversation,
 * opens the window — which is why the window alone does nothing and a command
 * still has to follow it.
 */
export const DEFAULT_WAKE_WORDS: readonly string[] = [
  "hey loaf",
  "ok loaf",
  "okay loaf",
  "loaf",
];

/** Kept for the tests and callers that predate custom wake words. */
export const WAKE_WORDS = DEFAULT_WAKE_WORDS;

/**
 * How long after the wake word a command still counts.
 *
 * Ten seconds rather than eight: the recogniser itself takes a moment to
 * settle after the wake word, and the gap between "he heard me" and "I have
 * thought of what to say" is longer than it feels when you are the one who
 * wrote the command list.
 */
export const COMMAND_WINDOW_MS = 10_000;

/** Bounds on a custom wake word, in characters. */
export const MIN_WAKE_LENGTH = 3;
export const MAX_WAKE_LENGTH = 24;

function normalise(raw: string): string {
  return raw.toLowerCase().replace(/[.,!?]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Clean up a wake word somebody typed, or refuse it.
 *
 * Refused rather than corrected, because the failure mode of a bad wake word is
 * silent: you say it, nothing happens, and there is no way to tell whether the
 * word was wrong or the microphone was. Better to reject it at the point it is
 * typed, where the reason can be shown.
 *
 * A single very short word is refused because a one-syllable wake word fires
 * constantly on ordinary speech, and a wake word that triggers all day is a
 * microphone with extra steps.
 */
export function normaliseWakeWord(raw: string): string | null {
  const cleaned = normalise(raw).replace(/[^a-z0-9 ]/g, "").trim();
  if (cleaned.length < MIN_WAKE_LENGTH || cleaned.length > MAX_WAKE_LENGTH) return null;
  if (!/[a-z]/.test(cleaned)) return null;
  // More than three words is a sentence, and a sentence has to be said the same
  // way twice to work.
  if (cleaned.split(" ").length > 3) return null;
  return cleaned;
}

/**
 * The words Loaf will answer to.
 *
 * A custom word REPLACES the defaults rather than joining them. Someone who
 * renamed their pet does not want it still answering to "loaf", and leaving
 * both in doubles the chances of a false wake.
 */
export function wakeWordsFor(custom?: string | null): readonly string[] {
  const chosen = custom ? normaliseWakeWord(custom) : null;
  if (chosen === null) return DEFAULT_WAKE_WORDS;
  // "hey X" as well as bare "X", for the same reason the defaults include both.
  return chosen.startsWith("hey ") ? [chosen, chosen.slice(4)] : [`hey ${chosen}`, chosen];
}

/** True when the whole phrase was just a wake word and nothing else. */
export function isWakeWord(text: string, words: readonly string[] = DEFAULT_WAKE_WORDS): boolean {
  return words.includes(normalise(text));
}

/**
 * Remove a leading wake word, if there is one.
 *
 * The grammar does not currently contain combined phrases like "hey loaf open
 * notepad" — that would double its size and a bigger grammar recognises
 * everything slightly worse. This handles them anyway, so adding them later is
 * a change to the phrase list alone.
 */
export function stripWakeWord(
  text: string,
  words: readonly string[] = DEFAULT_WAKE_WORDS,
): string {
  const t = normalise(text);
  // Longest first, or "okay loaf" leaves "loaf" behind.
  for (const wake of [...words].sort((a, b) => b.length - a.length)) {
    if (t === wake) return "";
    if (t.startsWith(`${wake} `)) return t.slice(wake.length + 1).trim();
  }
  return t;
}

/** What the caller should do about one thing that was heard. */
export interface WakeVerdict {
  /** A command to act on, or null. */
  readonly command: string | null;
  /** Whether Loaf is now waiting for a command. Drives the indicator. */
  readonly awake: boolean;
  /** True only on the utterance that woke it, so it can chirp once. */
  readonly justWoke: boolean;
}

/**
 * The gate itself.
 *
 * `now` is injected so the tests can move time without waiting for it, which
 * is the only way to test a rule whose entire content is a deadline.
 */
export class WakeGate {
  private awakeUntil = 0;

  /** Changed when the user picks a different wake word; no restart needed. */
  words: readonly string[] = DEFAULT_WAKE_WORDS;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = COMMAND_WINDOW_MS,
    words: readonly string[] = DEFAULT_WAKE_WORDS,
  ) {
    this.words = words;
  }

  /** Whether a command said right now would be acted on. */
  get isAwake(): boolean {
    return this.now() < this.awakeUntil;
  }

  /** Milliseconds left in the window, for a countdown ring. Never negative. */
  get remainingMs(): number {
    return Math.max(0, this.awakeUntil - this.now());
  }

  heard(text: string): WakeVerdict {
    const spoken = normalise(text);
    if (spoken.length === 0) {
      return { command: null, awake: this.isAwake, justWoke: false };
    }

    // A combined "hey loaf, open notepad" acts immediately and does not leave
    // the window open behind it: the command it carried was the whole point.
    const stripped = stripWakeWord(spoken, this.words);
    const wasAddressed = stripped !== spoken;

    if (wasAddressed && stripped.length > 0) {
      // Addressed directly, so it acts — and then stays open for a follow-up
      // on the same terms as any other command.
      this.awakeUntil = this.now() + this.windowMs;
      return { command: stripped, awake: true, justWoke: false };
    }

    if (isWakeWord(spoken, this.words)) {
      const alreadyAwake = this.isAwake;
      this.awakeUntil = this.now() + this.windowMs;
      // justWoke is false on a repeat, so saying it twice does not chirp twice.
      return { command: null, awake: true, justWoke: !alreadyAwake };
    }

    if (this.isAwake) {
      // The window RE-OPENS rather than closing, so a second instruction needs
      // no second wake word. "Open Notepad" is usually followed by something
      // else, and making people say the wake word between every step is the
      // thing that makes assistants tiring to use.
      //
      // It re-opens rather than never closing: silence still ends it after
      // `windowMs`, so a conversation that has moved on does not leave Loaf
      // acting on the room.
      this.awakeUntil = this.now() + this.windowMs;
      return { command: spoken, awake: true, justWoke: false };
    }

    // Heard, and deliberately ignored. This is the common case while the
    // microphone is open and nobody is talking to the cat.
    return { command: null, awake: false, justWoke: false };
  }

  /** Close the window early — used when a command is cancelled or Loaf sleeps. */
  reset(): void {
    this.awakeUntil = 0;
  }
}

/**
 * The wake words added to the spoken vocabulary.
 *
 * Kept separate from `spokenPhrases` because they are only worth listening for
 * when always-on listening is switched on; push-to-talk already knows you are
 * talking to it, and hearing "hey Loaf" through a button press would just be a
 * phrase that does nothing.
 */
export function wakePhrases(custom?: string | null): readonly string[] {
  return [...wakeWordsFor(custom)];
}
