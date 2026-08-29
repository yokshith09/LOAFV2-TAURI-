import type { Companion, CompanionGroup } from "../core/types";
import { CatCompanion } from "./catCompanion";
import { CAT_COATS } from "./catBreeds";
import { DogCompanion } from "./dogCompanion";
import { DOG_BREEDS } from "./dogBreeds";
import { GhostCompanion } from "./companionGhost";
import { CapybaraCompanion } from "./companionCapybara";
import { DuckCompanion } from "./companionDuck";
import {
  DroidCompanion,
  PlaneCompanion,
  RobotCompanion,
} from "./companionMachines";

/**
 * The closet's stock. Order here is the order they appear in the picker.
 *
 * Ported from the `Companions` enum in `Companion.swift`. The cats and dogs are
 * generated from coat/breed data rather than hand-drawn one by one — that is
 * what keeps a dozen animals from becoming a dozen near-identical 350-line
 * files, and it means an improvement to the anatomy improves every one at once.
 *
 * Adding a character is one file plus a line in this list. If it ever needs
 * more than that, the `Companion` contract has been broken somewhere.
 */
export const COMPANIONS: readonly Companion[] = [
  ...CAT_COATS.map((c) => new CatCompanion(c)),
  ...DOG_BREEDS.map((b) => new DogCompanion(b)),
  new DroidCompanion(),
  new RobotCompanion(),
  new PlaneCompanion(),
  new GhostCompanion(),
  new CapybaraCompanion(),
  new DuckCompanion(),
];

export const DEFAULT_COMPANION_ID = "cat-ginger";

/**
 * Look up by id, falling back to the default rather than throwing.
 *
 * A user's saved companion can legitimately disappear — an uninstalled sprite
 * pack, a renamed id — and that must not be fatal on launch.
 */
export function findCompanion(id: string): Companion {
  return COMPANIONS.find((c) => c.id === id) ?? COMPANIONS[0]!;
}

/** Shelf ordering for the closet. */
export const GROUP_ORDER: readonly CompanionGroup[] = [
  "cats",
  "dogs",
  "machines",
  "elsewhere",
];

/** A line of shelf copy, in Loaf's register. */
export const GROUP_NOTES: Readonly<Record<CompanionGroup, string>> = {
  cats: "Same loaf, different coat.",
  dogs: "Louder about the tabs.",
  machines: "No fur. Still judging.",
  elsewhere: "Not every companion is an animal.",
};

/** Companions bucketed by shelf, skipping shelves that are still empty. */
export function grouped(): Array<{
  group: CompanionGroup;
  members: Companion[];
}> {
  return GROUP_ORDER.map((group) => ({
    group,
    members: COMPANIONS.filter((c) => c.group === group),
  })).filter((g) => g.members.length > 0);
}
