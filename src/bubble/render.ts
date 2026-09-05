import { escapeHTML } from "../dashboard/html";
import type { BubbleSide } from "./geometry";

/**
 * The speech bubble itself. Ported from `BubbleView.draw` in
 * `BubbleWindow.swift`, where it is one bezier path with the tail appended to
 * it; here it is a rounded box plus a rotated square, which gets the same
 * picture without a canvas.
 */

/** Text column width, before padding. Matches the reference's 208pt. */
export const TEXT_WIDTH = 208;
const INSET = 14;
const TAIL = 10;
/** The rotated square's side. Its diagonal is what actually shows. */
const TAIL_BOX = 12;

export const BUBBLE_CSS = `
  :root {
    --paper: rgba(255, 249, 242, 0.98);
    --edge: #E8D9C4;
    --ink: #4A3626;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: transparent;
    -webkit-user-select: none; user-select: none;
    /* The reference names -apple-system only; Segoe UI keeps Windows off Times. */
    font-family: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    overflow: hidden;
  }
  /* The tail hangs off the side facing the character, so the padding that makes
     room for it goes on THAT side. Putting it on the other one leaves a gap
     above the card and the tail overlapping the text. */
  #bubble {
    position: relative;
    display: inline-block;
    padding-bottom: ${TAIL}px;
  }
  #bubble.below { padding-bottom: 0; padding-top: ${TAIL}px; }

  #card {
    background: var(--paper);
    border: 1px solid var(--edge);
    border-radius: 14px;
    padding: ${INSET}px;
    color: var(--ink);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.45;
    white-space: pre-wrap;
    /* The window has no shadow of its own — it is transparent — so the card
       casts one, or the bubble reads as a sticker pasted on the wallpaper. */
    box-shadow: 0 6px 18px rgba(20, 14, 40, 0.28);
  }
  /* Centred reads as a greeting; left-aligned reads as a list. The reference
     switches on exactly this, and it is the difference between a stats readout
     looking deliberate and looking ragged. */
  #card.centre { text-align: center; }

  /*
   * A rotated square, not a bordered triangle.
   *
   * The triangle version needs a second, slightly offset triangle behind it to
   * fake the 1px outline, and the two collapse into a faint crease at this
   * size. A square carrying the card's own border on two adjacent sides gets a
   * properly outlined arrow, and its unbordered half tucks under the card and
   * hides the seam.
   */
  .tail {
    position: absolute;
    width: ${TAIL_BOX}px;
    height: ${TAIL_BOX}px;
    background: var(--paper);
    border: 1px solid var(--edge);
    transform: rotate(45deg);
  }
  #bubble .tail { bottom: ${TAIL - TAIL_BOX / 2}px; border-top: none; border-left: none; }
  #bubble.below .tail {
    top: ${TAIL - TAIL_BOX / 2}px; bottom: auto;
    border: 1px solid var(--edge);
    border-bottom: none; border-right: none;
  }

  /*
   * The answer buttons.
   *
   * A question with no way to answer it is not a question. The confirmation
   * pipeline behind this one accepts a spoken or typed "yes", and for a while
   * that was the whole interface — which meant anyone not using voice, and not
   * looking at the dashboard's command box, got a bubble that asked something
   * and offered nothing. If Loaf asks, Loaf shows the buttons.
   */
  #answers { display: flex; gap: 8px; margin-top: 10px; justify-content: center; }
  #card.centre #answers { justify-content: center; }
  .answer {
    font-family: inherit; font-size: 12px; font-weight: 600;
    border-radius: 8px; padding: 5px 14px; cursor: pointer;
    border: 1px solid var(--edge); background: rgba(0,0,0,0.03); color: var(--ink);
  }
  .answer.yes { background: #FFB25E; border-color: #DD9A4E; color: #2B1D0E; }
  .answer:hover { filter: brightness(0.96); }
  .answer:focus-visible { outline: 2px solid #DD9A4E; outline-offset: 1px; }

  @media (prefers-reduced-motion: no-preference) {
    #bubble { animation: pop .14s ease-out; }
    @keyframes pop {
      from { opacity: 0; transform: scale(.94); }
      to { opacity: 1; transform: scale(1); }
    }
  }
`;

/**
 * The bubble's markup for a line of speech.
 *
 * `side` decides which edge the tail hangs from, and `tailX` where along that
 * edge — both come from the geometry, because a bubble that has been pushed
 * sideways to stay on screen still has to point at the character.
 */
export function speechBubbleHTML(
  text: string,
  side: BubbleSide,
  tailX: number,
  choices: readonly BubbleChoice[] = [],
): string {
  // Multi-line text is a list — a stats readout, a menu of something. Centring
  // it makes every line a different length from a different origin.
  const alignment = text.includes("\n") ? "" : " centre";
  const answers =
    choices.length > 0
      ? `<div id="answers">${choices
          .map(
            (c) =>
              `<button type="button" class="answer${c.primary ? " yes" : ""}" ` +
              `data-answer="${escapeHTML(c.value)}">${escapeHTML(c.label)}</button>`,
          )
          .join("")}</div>`
      : "";
  return (
    `<div id="bubble" class="${side === "below" ? "below" : "above"}">` +
    `<div id="card" class="card${alignment}" style="max-width:${TEXT_WIDTH + INSET * 2}px">` +
    `${escapeHTML(text)}${answers}</div>` +
    `<span class="tail" style="left:${tailX - TAIL_BOX / 2}px"></span>` +
    `</div>`
  );
}

/** One button on a bubble that asked something. */
export interface BubbleChoice {
  /** What the button says. */
  readonly label: string;
  /** What it means — fed to the same parser a spoken answer goes through. */
  readonly value: string;
  /** The affirmative one, styled to stand out. */
  readonly primary?: boolean;
}
