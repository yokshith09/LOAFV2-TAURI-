import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Tracker } from "../tracker/tracker";
import { miniBody, MINI_STYLES, unavailableRadar } from "../dashboard/html";
import { BUBBLE_CSS, speechBubbleHTML, TEXT_WIDTH } from "./render";
import { BUBBLE_SHOW_EVENT, BUBBLE_HIDE_EVENT, type BubblePayload } from "./events";

/**
 * The bubble window's entry point.
 *
 * One window serves both the speech bubble and the hover preview. They differ
 * only in what they render and whether they take the mouse, and running two
 * transparent always-on-top windows to say two kinds of sentence would double
 * the platform surface for no gain.
 *
 * The page measures itself and asks Rust to size and place the window around
 * it. The reference does the same thing through a `loafSize` script message,
 * for the same reason it gives: a fixed pixel height is a guess that content
 * overflows the moment a prompt gets a word longer.
 */

const root = document.getElementById("root")!;
const style = document.createElement("style");
document.head.appendChild(style);

/** Cleared on every show, so a preview cannot inherit a speech bubble's timer. */
let hideTimer: number | undefined;

function clearTimer(): void {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

async function hide(): Promise<void> {
  clearTimer();
  await invoke("hide_bubble").catch(() => {
    // The window is already gone, or going. Nothing to do about it here.
  });
}

async function show(p: BubblePayload): Promise<void> {
  clearTimer();

  if (p.kind === "speech") {
    style.textContent = BUBBLE_CSS;
    document.body.className = "";
    // Rendered with the tail centred first: the real offset needs the placed
    // origin, which needs the size, which needs this render. The second pass
    // below corrects it once there is something to measure.
    root.innerHTML = speechBubbleHTML(p.text, "above", TEXT_WIDTH / 2);
  } else {
    style.textContent = MINI_STYLES + PREVIEW_CSS;
    document.body.className = "mini";
    const tracker = new Tracker({ json: p.stats });
    root.innerHTML = miniBody(tracker, {
      radar: unavailableRadar(),
      tasks: (p.tasks ?? []) as never,
    });
  }

  // Two frames: one for layout, one for the fonts and the flex pass to settle.
  // Measuring in the same frame as the write returns the previous content's
  // box, which shows up as a bubble sized for whatever it said last time.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);

  // `offsetWidth`/`offsetHeight`, NOT `getBoundingClientRect()`.
  //
  // The card opens with a `scale(.92)` pop, and a rect INCLUDES transforms — so
  // measuring two frames in, while that 160ms animation is still running,
  // returned about 93% of the real size. The window was then built around a
  // card mid-pop, and the finished card overflowed it: clipped figures and two
  // scrollbars on something that is supposed to be a glance. The offset
  // properties report the laid-out border box and ignore transforms entirely.
  const card = root.firstElementChild as HTMLElement | null;
  const width = card ? card.offsetWidth : TEXT_WIDTH;
  const height = card ? card.offsetHeight : 60;

  const placed = await invoke<{ side: "above" | "below"; tailX: number }>(
    "place_bubble",
    { width, height, interactive: p.kind === "speech" },
  ).catch(() => null);

  if (placed && p.kind === "speech") {
    // Re-render with the tail where the character actually is. Only the speech
    // bubble has one; the preview card's tail is fixed in its own CSS. This
    // happens BEFORE the window is revealed, so nobody sees the first guess.
    root.innerHTML = speechBubbleHTML(p.text, placed.side, placed.tailX);
  }

  await invoke("reveal_bubble").catch(() => {
    // Nothing to reveal — running outside the app, most likely.
  });

  if (p.seconds && p.seconds > 0) {
    hideTimer = window.setTimeout(() => void hide(), p.seconds * 1000);
  }
}

/** The preview card is laid out for a window sized exactly to it. */
const PREVIEW_CSS = `
  body.mini { height: auto; display: block; }
  body.mini .wrap { margin-bottom: 0; }
  /* The preview borrows the DASHBOARD's stylesheet, which is deliberately
     scrollable — it is a long page. A glance card is not: at this size a
     scrollbar is a grey slab down two edges of a 228px window, and it appears
     over a rounding error. The window is sized to this card, so anything that
     would scroll is a bug to see in the layout, not to let the user drag. */
  html, body.mini { overflow: hidden; }
`;

// Clicking the bubble dismisses it, as in the reference. The preview ignores
// the mouse entirely — Rust sets that per show — so this only ever fires for
// speech.
root.addEventListener("click", () => void hide());

void listen<BubblePayload>(BUBBLE_SHOW_EVENT, (e) => void show(e.payload));
void listen(BUBBLE_HIDE_EVENT, () => void hide());
