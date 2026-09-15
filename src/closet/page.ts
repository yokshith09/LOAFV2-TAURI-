import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { COMPANIONS, findCompanion } from "../companions/registry";
import { findOutfit, seasonalOutfit } from "../outfits/registry";
import { renderScene } from "../render/scene";
import { renderPixelScene } from "../render/pixelate";
import { CLOSET_CSS, closetBody, THUMB } from "./view";
import { ClosetSettings, browserStore, isSeasonal, NO_OUTFIT } from "./settings";
import type { ClosetState } from "./settings";
import {
  CLOSET_PICK_EVENT,
  CLOSET_CHANGED_EVENT,
  CLOSET_HELLO_EVENT,
  isClosetState,
  type ClosetPick,
} from "./events";
import { asCtx2D, type Companion, type Outfit } from "../core/types";
import {
  browserImageLoader,
  FAILURE_NOTES,
  loadPacks,
  mergeCompanions,
  type LoadFailure,
  type RawPack,
} from "../sprites/load";


/**
 * The closet window.
 *
 * Decides nothing, exactly as the reference's own header says: it reports what
 * was clicked and re-renders when told the state changed. The companion window
 * owns the live character and the stored preferences.
 *
 * Storage gives the first paint so the closet is never blank, and the companion
 * is asked immediately afterwards for the authoritative answer. Reading storage
 * alone would assume every platform's webview keeps one live localStorage
 * across separate windows, which is not something this can verify.
 */

const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = CLOSET_CSS;
document.head.appendChild(style);

const settings = new ClosetSettings(browserStore());

/**
 * The built-ins, plus whatever the user has drawn.
 *
 * A `Companion` carries real draw functions, closures over a decoded `Image`
 * — not something an `emit()` payload can carry across the window boundary,
 * since that goes through Tauri's own JSON serialisation. So this window
 * asks Rust for the same raw sprite-pack bytes the companion window does,
 * and builds its own roster locally, rather than being handed one.
 */
let roster: readonly Companion[] = COMPANIONS;
let lastState: ClosetState = settings.read();
/** A pack that loaded off disk but did not make it onto the shelf, and why. */
let packFailures: readonly LoadFailure[] = [];

/**
 * Load hand-drawn characters into the shelf.
 *
 * Runs after the first paint — packs arrive after a round trip to disk and
 * an image decode, and the closet must not sit blank waiting on a folder
 * that is usually empty. A pack that fails is named in the console with the
 * reason; the ones that were fine still show up. Logged rather than swallowed
 * on every failure path — an invoke error included — because a pack that
 * silently never appears is indistinguishable from one that was never drawn.
 */
async function loadSpritePacks(): Promise<void> {
  let raw: RawPack[];
  try {
    raw = await invoke<RawPack[]>("sprite_packs");
  } catch (err) {
    console.warn("could not ask Rust for sprite packs", err);
    return;
  }
  if (raw.length === 0) return;
  const { companions, failures } = await loadPacks(raw, browserImageLoader());
  for (const failure of failures) {
    console.warn(`character "${failure.folder}" was skipped: ${FAILURE_NOTES[failure.reason]}`);
  }
  packFailures = failures;
  if (companions.length === 0 && failures.length === 0) return;
  roster = mergeCompanions(COMPANIONS, companions);
  render(lastState);
  void fit();
}

function findInRoster(id: string): Companion {
  return roster.find((c) => c.id === id) ?? findCompanion(id);
}

function send(pick: ClosetPick): void {
  void emit(CLOSET_PICK_EVENT, pick).catch((err) => {
    console.error("the closet could not reach the companion", err);
  });
}

/** The outfit every thumbnail wears: whatever is currently selected. */
function wornOutfit(state: ClosetState): Outfit | null {
  if (state.outfitId === NO_OUTFIT) return null;
  if (isSeasonal(state.outfitId)) return seasonalOutfit();
  return findOutfit(state.outfitId);
}

/**
 * Draw every card.
 *
 * The same renderer the desktop uses, so the picker cannot lie: what is in the
 * card is what turns up in the corner of the screen, current outfit and pixel
 * setting included. Mood is pinned to idle — the live character reacts to your
 * scrolling, and a closet opened mid-scroll would show eighteen companions all
 * clutching scrolls.
 */
function paintThumbnails(state: ClosetState): void {
  const dpr = window.devicePixelRatio || 1;
  const outfit = wornOutfit(state);
  const scene = { mood: "idle" as const, phase: 0, blinking: false };

  for (const canvas of root.querySelectorAll<HTMLCanvasElement>("canvas[data-thumb]")) {
    const companion = findInRoster(canvas.dataset.thumb!);
    canvas.width = Math.round(THUMB.width * dpr);
    canvas.height = Math.round(THUMB.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.scale(dpr, dpr);
    // No badge on a thumbnail: the tab alert is about right now, and a closet
    // full of characters mid-tantrum is not a picker.
    // The pixel pass rasterises through an offscreen canvas and needs the real
    // context; the vector pass takes the narrowed one. Same split as main.ts.
    if (state.pixelated) {
      renderPixelScene(ctx, companion, scene, THUMB.width, THUMB.height, outfit);
    } else {
      renderScene(asCtx2D(ctx), companion, scene, THUMB.width, THUMB.height, outfit);
    }
  }
}

function render(state: ClosetState): void {
  lastState = state;
  root.innerHTML = closetBody(state, roster, packFailures);
  paintThumbnails(state);

  root.querySelectorAll<HTMLElement>("[data-companion]").forEach((el) => {
    el.addEventListener("click", () =>
      send({ kind: "companion", id: el.dataset.companion! }),
    );
  });
  root.querySelectorAll<HTMLElement>("[data-outfit]").forEach((el) => {
    el.addEventListener("click", () => send({ kind: "outfit", id: el.dataset.outfit! }));
  });

  root.querySelectorAll<HTMLInputElement>("[data-habit]").forEach((el) => {
    el.addEventListener("change", () =>
      send({ kind: "habit", habit: el.dataset.habit!, on: el.checked }),
    );
  });

  const pixel = root.querySelector<HTMLInputElement>("#pixel");
  pixel?.addEventListener("change", () =>
    send({ kind: "pixelated", on: pixel.checked }),
  );

  const opacity = root.querySelector<HTMLInputElement>("#opacity");
  // On "input", not "change": a slider should show what it is doing as you
  // drag it, not only once you let go.
  opacity?.addEventListener("input", () =>
    send({ kind: "opacity", percent: Number(opacity.value) }),
  );

  const name = root.querySelector<HTMLInputElement>("#petname");
  // On `change`, not on every keystroke: a rename per character would rewrite
  // storage eighteen times for one word and re-render the whole closet under
  // the cursor while it was still being typed.
  name?.addEventListener("change", () => send({ kind: "rename", name: name.value }));
  name?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") name.blur();
  });
}

/** Size the window to the page, so a new shelf is never clipped. */
async function fit(): Promise<void> {
  const wrap = root.querySelector("#wrap");
  if (!wrap) return;
  await invoke("fit_closet", {
    height: Math.ceil(wrap.getBoundingClientRect().height) + 8,
  }).catch(() => {
    // Not running in the app. The window is whatever size it is.
  });
}

render(settings.read());
void fit();
void loadSpritePacks();

void listen(CLOSET_CHANGED_EVENT, (e) => {
  // Fall back to storage if the payload is malformed, rather than rendering
  // nothing: a closet that stops updating is worse than one a version behind.
  const next = isClosetState(e.payload) ? e.payload : settings.read();
  // A re-render loses focus and caret position in the name field, so it is
  // skipped while the user is typing in it — the companion has already applied
  // the change, and the closet is only catching up to it.
  if (document.activeElement?.id === "petname") return;
  render(next);
  void fit();
});

// Ask the owner what is actually on duty.
void emit(CLOSET_HELLO_EVENT).catch(() => {
  // No companion listening. The storage read above stands.
});
