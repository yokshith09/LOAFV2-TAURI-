import { defaultBehaviourSettings, type BehaviourSettings } from "./settings";
import type { SettingsStore } from "../closet/settings";

/**
 * The four habits a user can switch on and off, and remembering their answer.
 * Ported from the Habits submenu in `AppDelegate.swift`.
 *
 * `settings.ts` deliberately holds no storage — it is the behaviour's dials and
 * nothing else. This is the thin layer that persists the four the user is
 * offered, leaving the timings alone: nobody wants a menu item for "seconds
 * between loaves", and exposing one would make every other number in that file
 * look like a setting too.
 */

export const HABITS = ["loafing", "playing", "wandering", "drifting"] as const;
export type Habit = (typeof HABITS)[number];

export function isHabit(v: unknown): v is Habit {
  return typeof v === "string" && (HABITS as readonly string[]).includes(v);
}

/** Menu labels, in the reference's own words. */
export const HABIT_LABELS: Readonly<Record<Habit, string>> = {
  loafing: "Curl up into a loaf",
  playing: "Play with a fur ball",
  wandering: "Wander around the screen",
  drifting: "Drift about (they're a ghost)",
};

/**
 * What he says when a habit is toggled.
 *
 * Only the two that change where he physically is get a line. A confirmation
 * bubble for every switch would be a pet that talks back at you for using its
 * own settings.
 */
export function habitLine(habit: Habit, on: boolean): string | null {
  if (habit === "wandering") {
    return on ? "I'll stretch my legs occasionally.\nI won't go far." : "Staying put.";
  }
  if (habit === "drifting") {
    return on ? "Off I go, then. 👻" : "Anchored. Unnatural, but fine.";
  }
  return null;
}

const KEY = "behaviour.habits";

/**
 * Load the saved habits over the defaults.
 *
 * Only the four booleans are read back, and each only if it is actually a
 * boolean. Everything else in `BehaviourSettings` — the timings, the leash, the
 * speeds — comes from the defaults every launch, so a stale or hand-edited file
 * cannot leave the pet walking at forty points a second.
 */
export function loadHabits(store: SettingsStore): BehaviourSettings {
  const settings = defaultBehaviourSettings();
  const raw = store.getItem(KEY);
  if (!raw) return settings;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return settings;
    const saved = parsed as Record<string, unknown>;
    for (const habit of HABITS) {
      if (typeof saved[habit] === "boolean") settings[habit] = saved[habit];
    }
  } catch {
    // A corrupt file costs the user their four toggles, not their launch.
  }
  return settings;
}

export function saveHabits(store: SettingsStore, settings: BehaviourSettings): void {
  const out: Record<string, boolean> = {};
  for (const habit of HABITS) out[habit] = settings[habit];
  store.setItem(KEY, JSON.stringify(out));
}

/**
 * Which habits to show for this character.
 *
 * Drifting is only offered to characters that actually drift — otherwise it is
 * a switch wired to nothing, and its default is the opposite of wandering's,
 * which would be baffling sitting next to it on a cat.
 */
export function habitsFor(drifts: boolean): Habit[] {
  return HABITS.filter((h) => h !== "drifting" || drifts);
}
