import type { Outfit } from "../core/types";
import { OUTFIT_STYLES } from "./styles";

/**
 * The wardrobe half of the character closet. Ported from `Outfits.swift`.
 *
 * Concrete garments live in `styles.ts`; this is the registry and the "dress
 * for the season" logic, so adding a hat never means touching selection code.
 */

export const OUTFITS: readonly Outfit[] = OUTFIT_STYLES;

/** Sentinel stored in preferences when the companion should follow the calendar. */
export const SEASONAL_ID = "seasonal";

/** Sentinel for "wearing nothing". */
export const BARE_ID = "none";

/**
 * What the calendar says to wear on `date`.
 *
 * Returns null if this month has nothing assigned — an empty month must read as
 * "no outfit", not as the first item in the list. September is deliberately
 * bare, and the party hat has no month at all: a party is something you
 * declare, not something the calendar hands you.
 *
 * `month` is 1-12 to match the Swift; JS Date months are 0-based, so this takes
 * a Date and converts rather than letting the off-by-one loose.
 */
export function seasonalOutfit(date: Date = new Date()): Outfit | null {
  const month = date.getMonth() + 1;
  return OUTFITS.find((o) => o.months.has(month)) ?? null;
}

/**
 * Resolve a stored preference to a garment.
 *
 * null, undefined and "none" all mean bare. The seasonal sentinel defers to the
 * calendar. An unknown id resolves to bare rather than throwing — a preference
 * can outlive the garment it names.
 */
export function findOutfit(
  id: string | null | undefined,
  date: Date = new Date(),
): Outfit | null {
  if (!id || id === BARE_ID) return null;
  if (id === SEASONAL_ID) return seasonalOutfit(date);
  return OUTFITS.find((o) => o.id === id) ?? null;
}

/** Label for the closet's seasonal chip, e.g. "Seasonal · Cosy scarf". */
export function seasonalLabel(date: Date = new Date()): string {
  const outfit = seasonalOutfit(date);
  return outfit ? `Seasonal · ${outfit.name}` : "Seasonal · nothing this month";
}
