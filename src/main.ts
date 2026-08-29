/**
 * Phase 0 / Phase 1 entry point.
 *
 * Proves the window behaves like a desktop pet on both platforms, and drives
 * the ported companions. Feature work (tracking, tantrums, the timer) still
 * lives outside this file.
 */

import { COMPANIONS } from "./companions/registry";
import { renderScene } from "./render/scene";
import { ALL_MOODS, type Mood, type SceneState } from "./core/types";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
const probeEl = document.getElementById("probe") as HTMLDivElement | null;

if (!canvas) throw new Error("missing #stage canvas");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context unavailable — webview is too old");

let characterIndex = 0;
let moodIndex = 0;
let companion = COMPANIONS[characterIndex]!;

/** Diagnostics are off unless asked for — a tester should see a cat, not a HUD. */
let debugVisible = new URLSearchParams(location.search).has("debug");

/** Blink on a human-ish rhythm rather than a metronome. */
let nextBlinkAt = 2000;
let blinkUntil = -1;

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

/**
 * Size the backing store to the device pixel ratio so the art is crisp on a
 * Retina Mac and a 150%-scaled Windows display alike.
 *
 * Re-run on every DPR change, not just on resize: dragging the window between a
 * Retina and a non-Retina display changes devicePixelRatio without ever firing
 * a resize, and the canvas stays at the old backing size — which looks exactly
 * like the "slightly pixelated" a Mac tester reported.
 */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas!.width = Math.round(w * dpr);
  canvas!.height = Math.round(h * dpr);
  canvas!.style.width = `${w}px`;
  canvas!.style.height = `${h}px`;
}

/** Fires whenever devicePixelRatio changes, then re-arms for the new value. */
function watchPixelRatio(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onChange = (): void => {
    resize();
    watchPixelRatio();
  };
  mq.addEventListener("change", onChange, { once: true });
}

function frame(nowMs: number): void {
  const dpr = window.devicePixelRatio || 1;
  const phase = prefersReducedMotion ? 0 : nowMs / 1000;

  if (nowMs > nextBlinkAt) {
    blinkUntil = nowMs + 130;
    nextBlinkAt = nowMs + 2500 + Math.random() * 4000;
  }

  const state: SceneState = {
    mood: ALL_MOODS[moodIndex]! as Mood,
    phase,
    blinking: nowMs < blinkUntil,
  };

  ctx!.save();
  ctx!.scale(dpr, dpr);
  renderScene(
    ctx as unknown as Parameters<typeof renderScene>[0],
    companion,
    state,
    window.innerWidth,
    window.innerHeight,
  );
  ctx!.restore();

  requestAnimationFrame(frame);
}

/**
 * Drag to move, click to interact.
 *
 * A desktop pet needs both, and they share the same mouse button, so the two
 * are told apart by distance: past a few pixels of travel it is a drag and the
 * OS takes over the window; below that it is a click.
 *
 * This is why there is no drag region in the CSS — a region covering the window
 * would swallow every click, and a pet you cannot click is just a sticker.
 */
function wireInteraction(): void {
  const DRAG_THRESHOLD_PX = 4;
  let downAt: { x: number; y: number } | null = null;
  let dragging = false;

  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    downAt = { x: e.screenX, y: e.screenY };
    dragging = false;
  });

  window.addEventListener("mousemove", (e) => {
    if (!downAt || dragging) return;
    const moved = Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y);
    if (moved < DRAG_THRESHOLD_PX) return;
    dragging = true;
    // Hand the window to the OS. From here the webview stops seeing the
    // gesture, so there is no mouseup to wait for — reset on the way out.
    void invokeSafe("start_drag");
    downAt = null;
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    const wasClick = downAt !== null && !dragging;
    downAt = null;
    if (!wasClick) return;

    if (e.shiftKey) {
      characterIndex = (characterIndex + 1) % COMPANIONS.length;
      companion = COMPANIONS[characterIndex]!;
    } else {
      moodIndex = (moodIndex + 1) % ALL_MOODS.length;
    }
    updateProbeLabel();
  });

  // A way to see diagnostics without shipping them switched on.
  window.addEventListener("keydown", (e) => {
    if (e.key === "d" || e.key === "D") {
      debugVisible = !debugVisible;
      updateProbeLabel();
    }
  });
}

let lastProbeLine = "";

function updateProbeLabel(extra?: string): void {
  if (!probeEl) return;
  if (extra !== undefined) lastProbeLine = extra;
  probeEl.hidden = !debugVisible;
  if (!debugVisible) return;
  probeEl.textContent = `${companion.defaultName} · ${ALL_MOODS[moodIndex]}\n${lastProbeLine}`;
}

/** Call a Tauri command, tolerating running in a plain browser. */
async function invokeSafe<T>(cmd: string): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(cmd)) as T;
  } catch {
    return null;
  }
}

async function pollPlatform(): Promise<void> {
  const report = await invokeSafe<{
    app: { name: string; pid: number } | null;
    reason: string | null;
    platform: string;
  }>("foreground_app");

  if (!report) {
    updateProbeLabel("no tauri host (browser preview)");
    return;
  }
  updateProbeLabel(
    report.app
      ? `${report.platform}: ${report.app.name || "(unnamed)"} #${report.app.pid}`
      : `${report.platform}: ${report.reason ?? "nothing focused"}`,
  );
}

window.addEventListener("resize", resize);
resize();
watchPixelRatio();
wireInteraction();
updateProbeLabel("starting…");
void pollPlatform();
setInterval(() => void pollPlatform(), 3000);
requestAnimationFrame(frame);
