/**
 * Loaf saying its replies out loud.
 *
 * THE SAME PRIVACY RULE AS LISTENING, AND THE SAME WAY OF GETTING IT WRONG.
 * The browser's speech synthesis exposes two kinds of voice through one list.
 * Voices with `localService === true` are installed on the machine and speak
 * without a network. Voices with `localService === false` — on Windows these
 * are the ones named "Online (Natural)" — send the text to a server to be
 * spoken. They sound considerably better, and using one would quietly turn a
 * local feature into a network one, which is exactly the mistake this codebase
 * already made once in `speech.rs`.
 *
 * So `pickVoice` accepts ONLY local voices and returns null rather than falling
 * back to a remote one. Silence is the correct failure here.
 *
 * WHY THIS IS THE FRONTEND'S JOB. Unlike recognition, speaking needs no native
 * code, no permission and no platform branch: the WebView already has the
 * machine's installed voices. That also makes the one decision worth testing —
 * which voice — a pure function, which is what the tests below exercise.
 */

/** The parts of a `SpeechSynthesisVoice` this module actually reads. */
export interface VoiceInfo {
  readonly name: string;
  readonly lang: string;
  /** True when the voice runs on this machine. The whole rule turns on it. */
  readonly localService: boolean;
}

/**
 * The narrowed synthesiser this module needs, so tests can supply one.
 *
 * Structural rather than `SpeechSynthesis` itself: the real interface carries
 * events and queue state nothing here touches, and depending on them would
 * make the tests describe the browser rather than Loaf.
 */
export interface Synth {
  getVoices(): VoiceInfo[];
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
}

export interface SpeechUtteranceLike {
  text: string;
  voice?: VoiceInfo | null;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/**
 * Choose a voice to speak with, or null to stay quiet.
 *
 * Preference order, all within local voices only:
 *  1. one the user named, if it is local
 *  2. one matching the page's language
 *  3. any English one
 *  4. any local voice at all
 *
 * A named voice that turns out to be remote is refused rather than downgraded
 * silently, because someone who picked a voice should be told why they did not
 * get it.
 */
export function pickVoice(
  voices: readonly VoiceInfo[],
  preferredName?: string | null,
  lang = "en-US",
): VoiceInfo | null {
  const local = voices.filter((v) => v.localService === true);
  if (local.length === 0) return null;

  if (preferredName) {
    const named = local.find((v) => v.name === preferredName);
    if (named) return named;
    // Deliberately falls through rather than returning null: the request was
    // for a voice, not for silence. The caller reports the substitution.
  }

  const exact = local.find((v) => v.lang === lang);
  if (exact) return exact;

  const sameLanguage = local.find((v) => v.lang.split("-")[0] === lang.split("-")[0]);
  if (sameLanguage) return sameLanguage;

  const english = local.find((v) => v.lang.toLowerCase().startsWith("en"));
  return english ?? local[0]!;
}

/** True when a named voice exists but is not local, so nothing will use it. */
export function isRemoteOnly(voices: readonly VoiceInfo[], name: string): boolean {
  const match = voices.find((v) => v.name === name);
  return match !== undefined && match.localService === false;
}

/** Every voice Loaf is willing to use, for a settings list. */
export function localVoices(voices: readonly VoiceInfo[]): VoiceInfo[] {
  return voices.filter((v) => v.localService === true);
}

/**
 * Trim a bubble down to something worth hearing.
 *
 * Bubbles carry punctuation and emoji that read well and speak badly, and a
 * very long line spoken aloud is worse than one not spoken at all — the user
 * cannot skim it, and it talks over whatever they are doing.
 */
export const MAX_SPOKEN_CHARS = 140;

export function speakable(text: string): string | null {
  const cleaned = text
    // Emoji and pictographs: they are punctuation to a synthesiser, or worse,
    // a literal reading of the character's name.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > MAX_SPOKEN_CHARS) return null;
  // A line with no letters is a number or a symbol and means nothing spoken.
  if (!/[a-z]/i.test(cleaned)) return null;
  return cleaned;
}

/**
 * Loaf's voice.
 *
 * Off unless switched on. `cancel` before every utterance so a fast series of
 * bubbles does not build a queue that goes on talking long after the thing it
 * was describing has finished.
 */
export class Speaker {
  enabled = false;
  /** The voice the user chose, if any. */
  preferred: string | null = null;

  constructor(
    private readonly synth: Synth | null,
    private readonly make: (text: string) => SpeechUtteranceLike = (text) => ({ text }),
  ) {}

  /** Whether speaking is possible at all here. */
  get available(): boolean {
    return this.synth !== null && localVoices(this.synth.getVoices()).length > 0;
  }

  /** Voices offered in settings. Local only, by construction. */
  voices(): VoiceInfo[] {
    return this.synth === null ? [] : localVoices(this.synth.getVoices());
  }

  /**
   * Say something, if speaking is on and there is a local voice.
   *
   * Returns what was actually spoken, or null. Null is a normal answer and the
   * caller should not treat it as a failure: the bubble is still on screen,
   * which was always the primary channel.
   */
  speak(text: string): string | null {
    if (!this.enabled || this.synth === null) return null;
    const line = speakable(text);
    if (line === null) return null;
    const voice = pickVoice(this.synth.getVoices(), this.preferred);
    // No local voice means no speaking. Never a remote one.
    if (voice === null) return null;

    const utterance = this.make(line);
    utterance.voice = voice;
    // Slightly slow and slightly high: a small character, and easier to catch
    // a misheard command in.
    utterance.rate = 0.95;
    utterance.pitch = 1.15;
    this.synth.cancel();
    this.synth.speak(utterance);
    return line;
  }

  /** Stop mid-sentence — used when Loaf is told to sleep. */
  hush(): void {
    this.synth?.cancel();
  }
}

/** The real browser synthesiser, or null where there is not one. */
export function browserSynth(): Synth | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const native = window.speechSynthesis;
  return {
    getVoices: () =>
      native.getVoices().map((v) => ({
        name: v.name,
        lang: v.lang,
        localService: v.localService,
      })),
    speak: (u) => {
      const utterance = new SpeechSynthesisUtterance(u.text);
      if (u.voice) {
        // Match back to the real voice object by name; the narrowed type above
        // is a copy, and the browser will only accept its own.
        utterance.voice = native.getVoices().find((v) => v.name === u.voice!.name) ?? null;
      }
      utterance.rate = u.rate ?? 1;
      utterance.pitch = u.pitch ?? 1;
      utterance.volume = u.volume ?? 1;
      native.speak(utterance);
    },
    cancel: () => native.cancel(),
  };
}

/**
 * Remembering which voice was chosen.
 *
 * Kept here rather than with the habits because it belongs to the speaker, and
 * because a voice name that no longer exists on the machine has to degrade to
 * "let Loaf choose" rather than to silence — `pickVoice` already does exactly
 * that with an unknown name.
 */
const VOICE_KEY = "voice.preferred";

export interface VoiceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function saveVoice(store: VoiceStore, name: string | null): void {
  if (name === null) {
    store.removeItem?.(VOICE_KEY);
    // Not every store implements removeItem; an empty string reads back as null.
    if (!store.removeItem) store.setItem(VOICE_KEY, "");
    return;
  }
  store.setItem(VOICE_KEY, name);
}

export function loadVoice(store: VoiceStore): string | null {
  const raw = store.getItem(VOICE_KEY);
  return raw === null || raw.trim().length === 0 ? null : raw;
}
