/**
 * Drawing the recap card.
 *
 * A square, because square survives every place a picture gets posted without
 * being cropped into nonsense. 1080 is the size those places expect, so the
 * card is authored at 540 and drawn at 2x — the same trick the rest of the app
 * uses for Retina.
 *
 * The character is drawn by the SAME `renderScene` the companion window uses,
 * in its current outfit. That is the whole reason this card is worth posting:
 * it is a picture of your pet with your week on it, not a chart with a mascot
 * stuck in the corner.
 */

import type { Ctx2D } from "../core/types";
import { css } from "../core/color";
import type { WrappedStats } from "./wrapped";
import { wrappedLines } from "./wrapped";

/** Authored size. The exported PNG is this times `CARD_SCALE`. */
export const CARD_SIZE = 540;
export const CARD_SCALE = 2;

/**
 * Where the character stands on the card.
 *
 * Bottom-right, facing into the text rather than out of the frame. The design
 * space is 170x190, so this is the box that space is fitted into.
 */
export const CHARACTER_BOX = { x: 300, y: 250, width: 210, height: 235 };

const INK = { r: 35, g: 32, b: 27, a: 1 };
const SOFT = { r: 111, g: 102, b: 86, a: 1 };
const PAPER = { r: 245, g: 241, b: 230, a: 1 };
const ACCENT = { r: 168, g: 114, b: 31, a: 1 };

/** A short, human date range: `25–31 Aug`. */
export function rangeLabel(from: string, to: string): string {
  const parse = (key: string): Date | null => {
    const parts = key.split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return new Date(parts[0]!, parts[1]! - 1, parts[2]!);
  };
  const a = parse(from);
  const b = parse(to);
  if (a === null || b === null) return "";
  const month = b.toLocaleDateString(undefined, { month: "short" });
  const sameMonth = a.getMonth() === b.getMonth();
  return sameMonth
    ? `${a.getDate()}–${b.getDate()} ${month}`
    : `${a.getDate()} ${a.toLocaleDateString(undefined, { month: "short" })} – ${b.getDate()} ${month}`;
}

/**
 * Draw the whole card.
 *
 * `drawCharacter` is passed in rather than imported so this file stays testable
 * against a recording context: the scene renderer needs a real companion and a
 * real fit transform, and neither belongs in a test about layout.
 */
export function drawCard(
  ctx: Ctx2D,
  stats: WrappedStats,
  opts: {
    readonly name: string;
    readonly drawCharacter?: (ctx: Ctx2D) => void;
  },
): void {
  const S = CARD_SIZE;

  ctx.save();

  // Ground.
  ctx.fillStyle = css(PAPER);
  ctx.fillRect?.(0, 0, S, S);

  // Eyebrow.
  ctx.fillStyle = css(ACCENT);
  ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
  if ("textBaseline" in ctx) ctx.textBaseline = "alphabetic";
  ctx.fillText("MY WEEK WITH LOAF", 44, 66);

  // The date range does the work a title would, and is more honest than one.
  ctx.fillStyle = css(SOFT);
  ctx.font = "400 17px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(rangeLabel(stats.from, stats.to), 44, 92);

  // The numbers. Value large, label small underneath — a pairing that reads at
  // thumbnail size, which is how most people will first see this.
  const lines = wrappedLines(stats).slice(0, 5);
  let y = 152;
  for (const line of lines) {
    ctx.fillStyle = css(INK);
    ctx.font = "700 40px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(line.value, 44, y);

    ctx.fillStyle = css(SOFT);
    ctx.font = "400 15px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(line.label, 44, y + 22);
    y += 68;
  }

  // The character, in whatever it is wearing today.
  if (opts.drawCharacter) {
    ctx.save();
    opts.drawCharacter(ctx);
    ctx.restore();
  }

  // The pet's name, under it.
  ctx.fillStyle = css(SOFT);
  ctx.font = "600 16px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(opts.name, CHARACTER_BOX.x + 12, S - 52);

  // Footer. States what the product is, and the claim that makes it worth
  // stating — which is the only advertising on a card the user chose to post.
  ctx.fillStyle = css(SOFT);
  ctx.font = "400 13px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Loaf · a desktop pet that tracks your time", 44, S - 30);
  ctx.fillText("Everything measured on this card stayed on my computer.", 44, S - 12);

  ctx.restore();
}
