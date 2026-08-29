/**
 * Phase 0 entry point.
 *
 * Proves three things and nothing more:
 *   1. the window is transparent, always-on-top and undecorated,
 *   2. the ported companion renders and animates in a webview canvas,
 *   3. the Rust platform adapter answers "what app is in front?".
 *
 * Feature work (tracking, tantrums, the timer) deliberately does NOT live here
 * yet — the point of a spike is to be thrown away if the architecture fails.
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

/** Blink on a human-ish rhythm rather than a metronome. */
let nextBlinkAt = 2000;
let blinkUntil = -1;

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

/**
 * Size the backing store to the device pixel ratio so the art is crisp on a
 * Retina Mac and a 150%-scaled Windows display alike. Getting this wrong is the
 * single most common reason a canvas pet looks soft.
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

function frame(nowMs: number): void {
  const dpr = window.devicePixelRatio || 1;
  const phase = prefersReducedMotion ? 0 : nowMs / 1000;

  if (nowMs > nextBlinkAt) {
    blinkUntil = nowMs + 130;
    // 2.5s–6.5s until the next one.
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

/** Phase 0 affordance: click cycles mood, shift-click cycles character. */
function wireSpikeControls(): void {
  window.addEventListener("click", (e) => {
    if (e.shiftKey) {
      characterIndex = (characterIndex + 1) % COMPANIONS.length;
      companion = COMPANIONS[characterIndex]!;
    } else {
      moodIndex = (moodIndex + 1) % ALL_MOODS.length;
    }
    updateProbeLabel();
  });
}

let lastProbeLine = "";

function updateProbeLabel(extra?: string): void {
  if (!probeEl) return;
  if (extra !== undefined) lastProbeLine = extra;
  probeEl.hidden = false;
  probeEl.textContent = `${companion.defaultName} · ${ALL_MOODS[moodIndex]}\n${lastProbeLine}`;
}

/**
 * Poll the Rust side. Kept slow and unconditional for the spike; the real
 * tracker will be event-driven and will respect the radar being switched off.
 */
async function pollPlatform(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const report = (await invoke("foreground_app")) as {
      app: { name: string; pid: number } | null;
      reason: string | null;
      platform: string;
    };
    const label = report.app
      ? `${report.platform}: ${report.app.name || "(unnamed)"} #${report.app.pid}`
      : `${report.platform}: ${report.reason ?? "nothing focused"}`;
    updateProbeLabel(label);
  } catch {
    // Running in a plain browser (vite dev without Tauri) — expected.
    updateProbeLabel("no tauri host (browser preview)");
  }
}

window.addEventListener("resize", resize);
resize();
wireSpikeControls();
updateProbeLabel("starting…");
void pollPlatform();
setInterval(() => void pollPlatform(), 3000);
requestAnimationFrame(frame);
