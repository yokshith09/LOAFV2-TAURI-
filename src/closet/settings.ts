import { DEFAULT_COMPANION_ID } from "../companions/registry";
import { SEASONAL_ID } from "../outfits/registry";
import { DEFAULT_LISTEN_MODE, type ListenMode } from "../voice/mode";
import { DEFAULT_ENGINE, type EngineId, type EngineAvailability } from "../voice/engine";

/**
 * What the closet remembers. Ported from `ClosetSettings` in the reference.
 *
 * The store is injected and every read is defended, because these values
 * survive across versions: an id that was valid last release can be missing in
 * this one, and the answer to that is a default, never a crash on launch.
 */

export interface SettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class MemorySettingsStore implements SettingsStore {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

/**
 * `localStorage`, or nothing at all.
 *
 * A private window or a webview with storage disabled throws on access rather
 * than returning null, and a pet that refuses to start because it could not
 * remember which hat it was wearing has its priorities wrong.
 */
export function browserStore(): SettingsStore {
  return {
    getItem: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // Choices last for this session only.
      }
    },
  };
}

const K_COMPANION = "closet.companion";
const K_OUTFIT = "closet.outfit";
const K_PIXELATED = "closet.pixelated";
const K_NAMES = "closet.names";

/** The sentinel for "no outfit", so the stored value is never an empty string. */
export const NO_OUTFIT = "none";

/** How long a rename may be. Matches the reference's `maxlength`. */
export const MAX_NAME_LENGTH = 24;

export interface ClosetState {
  readonly companionId: string;
  /** `"none"`, the seasonal sentinel, or a garment id. Never null. */
  readonly outfitId: string;
  readonly pixelated: boolean;
  /** Custom names by companion id. Absent means "call it what it ships as". */
  readonly names: Readonly<Record<string, string>>;
  /**
   * The four habits, as the closet needs to draw them.
   *
   * Carried here rather than read from `behaviour/habits` by the page, so the
   * closet renders from one payload and cannot show a checkbox that disagrees
   * with the pet it is standing next to.
   */
  readonly habits: Readonly<Record<string, boolean>>;
  /** Global mute, carried alongside the habits because it sits with them. */
  readonly muted: boolean;
  /** How much of the time Loaf may listen. See voice/mode.ts. */
  readonly listenMode: ListenMode;
  /** Local speech voices on this machine. Remote ones never appear. */
  readonly voices: readonly string[];
  /** The chosen voice, or null for whichever Loaf picks. */
  readonly voice: string | null;
  /** A wake word of your own, or null for the built-in ones. */
  readonly wakeWord: string | null;
  readonly hoverListenMs: number;
  readonly engine: EngineId;
  readonly engineAvailability: EngineAvailability;
  readonly whisperDownload: { downloaded: number; total: number } | null;
}

/**
 * Trim a rename to something that will fit on a card.
 *
 * Returns null for anything that is only whitespace, which is how the user
 * clears a name — the reference treats an empty field as the reset, and a name
 * of three spaces is an empty field with extra steps.
 */
export function normaliseName(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
}

export class ClosetSettings {
  /**
   * Set by the companion before broadcasting. The habits live in
   * `behaviour/habits`, which owns their storage; this only carries them.
   */
  habits: Readonly<Record<string, boolean>> = {};
  muted = false;
  /** Carried, not owned: `behaviour/habits` stores it. */
  listenMode: ListenMode = DEFAULT_LISTEN_MODE;
  /** Local voices only; the companion filters the remote ones out. */
  voices: readonly string[] = [];
  voice: string | null = null;
  wakeWord: string | null = null;
  hoverListenMs = 5000;
  engine: EngineId = DEFAULT_ENGINE;
  whisperDownload: { downloaded: number; total: number } | null = null;
  engineAvailability: EngineAvailability = {
    whisperModel: false,
    hostedConnected: false,
    builtinReady: false,
  };

  constructor(private readonly store: SettingsStore) {}

  read(): ClosetState {
    return {
      companionId: this.store.getItem(K_COMPANION) ?? DEFAULT_COMPANION_ID,
      outfitId: this.store.getItem(K_OUTFIT) ?? NO_OUTFIT,
      pixelated: this.store.getItem(K_PIXELATED) === "1",
      names: this.readNames(),
      habits: this.habits,
      muted: this.muted,
      listenMode: this.listenMode,
      voices: this.voices,
      voice: this.voice,
      wakeWord: this.wakeWord,
      hoverListenMs: this.hoverListenMs,
      engine: this.engine,
      engineAvailability: this.engineAvailability,
      whisperDownload: this.whisperDownload,
    };
  }

  private readNames(): Record<string, string> {
    const raw = this.store.getItem(K_NAMES);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
        // Anything that is not a usable name is dropped rather than rendered.
        // These end up as the character's displayed name, and a `null` there
        // would show the user the word "null" on their own pet.
        if (typeof name !== "string") continue;
        const clean = normaliseName(name);
        if (clean) out[id] = clean;
      }
      return out;
    } catch {
      return {};
    }
  }

  setCompanion(id: string): void {
    this.store.setItem(K_COMPANION, id);
  }

  setOutfit(id: string | null): void {
    this.store.setItem(K_OUTFIT, id ?? NO_OUTFIT);
  }

  setPixelated(on: boolean): void {
    this.store.setItem(K_PIXELATED, on ? "1" : "0");
  }

  /**
   * Name one character, or clear its name with null.
   *
   * Names are kept per id rather than as one "the pet's name", because the
   * reference promises exactly that on the closet card: renaming this one does
   * not rename the rest. Switching to a dog and back should find the cat still
   * called whatever you called it.
   */
  setName(companionId: string, name: string | null): void {
    const names = this.readNames();
    if (name === null) {
      delete names[companionId];
    } else {
      names[companionId] = name;
    }
    this.store.setItem(K_NAMES, JSON.stringify(names));
  }
}

/** What to call a companion: the user's name for it, or the one it ships with. */
export function displayName(
  state: ClosetState,
  companionId: string,
  defaultName: string,
): string {
  return state.names[companionId] ?? defaultName;
}

/** True when the stored outfit means "follow the calendar". */
export function isSeasonal(outfitId: string): boolean {
  return outfitId === SEASONAL_ID;
}
