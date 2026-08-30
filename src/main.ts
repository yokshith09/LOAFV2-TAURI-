/**
 * Phase 0 / Phase 1 entry point.
 *
 * Proves the window behaves like a desktop pet on both platforms, and drives
 * the ported companions. Feature work (tantrums, the closet, the dashboard)
 * still lives outside this file.
 */

import { COMPANIONS } from "./companions/registry";
import { OUTFITS, findOutfit, SEASONAL_ID } from "./outfits/registry";
import { renderScene } from "./render/scene";
import { renderPixelScene } from "./render/pixelate";
import { CurlDirector, canCurl } from "./behaviour/curl";
import { PlayDirector } from "./behaviour/play";
import { WanderController } from "./behaviour/wander";
import { drawBall, drawSwipe } from "./behaviour/furBall";
import { resolveLicence, licenceInputs } from "./behaviour/licence";
import { defaultBehaviourSettings } from "./behaviour/settings";
import { TauriMovableWindow } from "./platform/tauriWindow";
import { applyFit, computeFit } from "./render/scene";
import { FocusTimer } from "./focus/timer";
import { drawFocusRing, drawFocusPill } from "./render/focusRing";
import { Tracker, TICK_INTERVAL, formatDuration } from "./tracker/tracker";
import {
  MemoryStatsStore,
  TauriStatsStore,
  hasTauriHost,
  type StatsStore,
} from "./tracker/statsStore";
import { emit, listen } from "@tauri-apps/api/event";
import { COMMAND_EVENT, STATS_CHANGED_EVENT, isCommand } from "./dashboard/events";
import { BUBBLE_SHOW_EVENT, BUBBLE_HIDE_EVENT, type BubblePayload } from "./bubble/events";
import {
  BREAK_PROMPTS,
  BREAK_BUBBLE_SECONDS,
  HOVER_DWELL_MS,
  PromptRotation,
  mayNudge,
} from "./bubble/prompts";
import { ALL_MOODS, type Mood, type Outfit, type SceneState } from "./core/types";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
const probeEl = document.getElementById("probe") as HTMLDivElement | null;

if (!canvas) throw new Error("missing #stage canvas");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context unavailable — webview is too old");

let characterIndex = 0;
let moodIndex = 0;
let companion = COMPANIONS[characterIndex]!;

/**
 * Wardrobe selection, as the closet will store it: null = bare, the seasonal
 * sentinel = follow the calendar, anything else = a garment id. Cycling walks
 * bare -> each garment -> seasonal -> bare.
 */
const OUTFIT_CYCLE: ReadonlyArray<string | null> = [
  null,
  ...OUTFITS.map((o) => o.id),
  SEASONAL_ID,
];
let outfitIndex = 0;

/** Style toggle, not a second set of sprites — see render/pixelate.ts. */
let pixelated = false;

function currentOutfit(): Outfit | null {
  return findOutfit(OUTFIT_CYCLE[outfitIndex]!);
}

// --- The ambient layer -------------------------------------------------------

const behaviour = defaultBehaviourSettings();
/**
 * The focus timer persists through localStorage so a session survives a quit —
 * relaunch inside one and it is still counting.
 */
const focus = new FocusTimer({
  store: {
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
        // Private window, or storage disabled. The timer still runs; it just
        // will not survive a quit.
      }
    },
  },
});

// --- Screen time -------------------------------------------------------------

/**
 * Nothing is tracked until the file on disk has been read.
 *
 * The read is a round trip to Rust, so there is a window at launch with no
 * tracker at all. Deliberately: a tracker built before the read finishes would
 * hold an empty history, and its first save would put that empty file where
 * months of the user's data used to be. Losing the first few seconds of a
 * session is the cheaper mistake by a wide margin.
 */
const statsStore: StatsStore = hasTauriHost()
  ? new TauriStatsStore()
  : new MemoryStatsStore();
let tracker: Tracker | null = null;
let ticksSinceSave = 0;
let lastTickResult = "starting";

/** Ticks between saves. The whole file is rewritten, so not every tick. */
const SAVE_EVERY = 12; // once a minute at a five-second tick

async function loadHistory(): Promise<void> {
  try {
    tracker = new Tracker({ json: await statsStore.load() });
  } catch (err) {
    // A read that failed is NOT an empty history. Leaving `tracker` null means
    // we never save, so a file we could not open is never overwritten.
    console.error("could not read screen time; not tracking this session", err);
    lastTickResult = "history unreadable";
  }
}

function saveHistory(): void {
  if (!tracker) return;
  statsStore.save(tracker.serialize());
  ticksSinceSave = 0;
}

/**
 * Apply a command from the dashboard window.
 *
 * The companion window is the SINGLE OWNER of the tracker. The dashboard reads
 * the same file but never writes it: two windows mutating one JSON document
 * loses an update the first time someone presses "Reset today" while a tick is
 * in flight. So the dashboard asks, this applies and saves, and the reply tells
 * it to re-read.
 */
function applyCommand(cmd: unknown): void {
  if (!tracker || !isCommand(cmd)) return;
  switch (cmd) {
    case "reset":
      tracker.resetToday();
      break;
    case "sites:forget":
      tracker.forgetAllSites();
      break;
    case "radar:on":
      // No radar in this build. The dashboard knows and does not offer the
      // button; this arm exists so a stale window cannot silently do nothing
      // that looks like something.
      console.warn("the privacy radar is not in this build yet");
      return;
  }
  saveHistory();
  void emit(STATS_CHANGED_EVENT).catch(() => {
    // Only costs the dashboard a refresh; the change itself is already saved.
  });
}

const curlDirector = new CurlDirector();
const playDirector = new PlayDirector();
const wander = new WanderController();
const hostWindow = new TauriMovableWindow();

curlDirector.settings = behaviour;
playDirector.settings = behaviour;
curlDirector.canLoaf = canCurl(companion);

// --- Speaking ----------------------------------------------------------------

const breakPrompts = new PromptRotation(BREAK_PROMPTS);

/**
 * The mood the bubble is forcing, if any.
 *
 * The reference overrides the mood while a nudge is up and clears it when the
 * bubble hides, so the character looks like it means what it is saying. Held
 * here rather than in the bubble window because the mood belongs to the thing
 * being drawn.
 */
let moodOverride: Mood | null = null;

function say(payload: BubblePayload): void {
  if (!hasTauriHost()) return;
  void emit(BUBBLE_SHOW_EVENT, payload).catch((err) => {
    console.error("could not say that", err);
  });
}

/**
 * The fifteen-minute break nudge.
 *
 * Stands down during a focus session — see `mayNudge`. The streak has already
 * been reset by the tick that reported it, so skipping here costs one nudge
 * rather than deferring it to the moment the session ends, which is when the
 * timer's own finish message lands.
 */
function nudge(): void {
  // A PAUSED session does not suppress it, matching the reference's
  // `state != .running`. Someone who paused is already taking a break, and the
  // promise not to interrupt was about the part where they were working.
  const running = focus.display !== null && !focus.display.paused;
  if (!mayNudge(running)) return;
  moodOverride = "worried";
  say({
    kind: "speech",
    text: breakPrompts.next(),
    seconds: BREAK_BUBBLE_SECONDS,
  });
  // The bubble hides itself on its own timer or on a click, and this window is
  // not told. Matching the duration keeps the worried face and the bubble on
  // screen together; a shared "it hid" event would be exact, but it would also
  // let a dropped event strand the character mid-worry forever.
  window.setTimeout(() => {
    moodOverride = null;
  }, BREAK_BUBBLE_SECONDS * 1000);
}

function hush(): void {
  if (!hasTauriHost()) return;
  void emit(BUBBLE_HIDE_EVENT).catch(() => {
    // Nothing was listening. The bubble is already not on screen.
  });
}

/** Set while the user has the companion under the mouse or is moving it. */
let hovering = false;
let draggingWindow = false;

/** Timestamp of the last frame, for the ambient layer's dt. */
let lastTickMs: number | null = null;
let nextWanderAt: number | null = null;

function tickAmbient(nowMs: number, mood: Mood): void {
  const dt = lastTickMs === null ? 0 : Math.min(0.25, (nowMs - lastTickMs) / 1000);
  lastTickMs = nowMs;
  if (dt <= 0) return;

  focus.poll();
  const licence = resolveLicence(
    licenceInputs({
      mood,
      hovering,
      dragging: draggingWindow,
      focus: focus.display,
    }),
  );

  // One activity at a time: a curled-up animal cannot reach a ball, and neither
  // should be happening while the window is walking.
  const walking = wander.isMoving;
  curlDirector.tick(dt, licence, nowMs / 1000, nowMs, playDirector.isPlaying || walking);
  playDirector.tick(dt, licence, nowMs, curlDirector.curl > 0 || walking);

  tickWander(dt, nowMs, licence.mayWander, licence.mayBegin);
}

function tickWander(
  dt: number,
  nowMs: number,
  mayWander: boolean,
  mayBegin: boolean,
): void {
  hostWindow.poll(nowMs);
  if (!hostWindow.isReady) return;

  // A drifting character moves by nature. It reuses the whole wander machinery
  // — leash, screen clamping, abort-on-drag — and only changes the dials, so
  // drift inherits every guarantee the geometry was tested for rather than
  // opening a second way for a window to end up off-screen.
  const drifting = companion.drifts && behaviour.drifting;
  wander.linear = drifting;
  const leash = drifting ? behaviour.driftLeash : behaviour.wanderLeash;
  const speed = drifting ? behaviour.driftSpeed : behaviour.wanderSpeed;
  const every = drifting ? behaviour.driftEvery : behaviour.wanderEvery;
  const gap = (): number =>
    (every.min + (every.max - every.min) * Math.random()) * 1000;

  if (!(behaviour.wandering || drifting) || !mayWander) {
    // Stopped mid-stride by a tantrum or a drag. He stays where the
    // interruption caught him — inside the leash either way — and the next walk
    // is pushed out, so the moment a tantrum clears he does not set straight
    // off again.
    if (wander.isMoving) {
      wander.abort();
      nextWanderAt = nowMs + gap();
    }
    return;
  }

  if (wander.isMoving) {
    wander.step(dt, hostWindow);
    if (!wander.isMoving) nextWanderAt = nowMs + gap();
    return;
  }

  if (nextWanderAt === null) {
    nextWanderAt = nowMs + gap();
    return;
  }
  if (
    !mayBegin ||
    curlDirector.curl > 0 ||
    (!drifting && playDirector.ball !== null) ||
    nowMs < nextWanderAt
  ) {
    return;
  }
  if (!wander.begin(hostWindow, leash, speed)) {
    // Nowhere worth going right now — try again shortly rather than never.
    nextWanderAt = nowMs + (drifting ? 3000 : 20000);
  }
}

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

  // An override wins over the cycled mood: while the character is telling you
  // to drink water it should not be beaming.
  const mood = moodOverride ?? (ALL_MOODS[moodIndex]! as Mood);
  tickAmbient(nowMs, mood);

  const state: SceneState = {
    mood,
    phase,
    blinking: nowMs < blinkUntil,
  };

  ctx!.save();
  ctx!.scale(dpr, dpr);
  if (pixelated) {
    renderPixelScene(
      ctx!,
      companion,
      state,
      window.innerWidth,
      window.innerHeight,
      currentOutfit(),
    );
  } else {
    renderScene(
      ctx as unknown as Parameters<typeof renderScene>[0],
      companion,
      state,
      window.innerWidth,
      window.innerHeight,
      currentOutfit(),
    );
  }

  // The ball, the paw and the focus session share the companion's design space,
  // so they go through the same fit transform. The ball is skipped in pixel
  // mode — there it is rasterised with the character rather than drawn over the
  // top — but the ring and pill are always crisp: "24:31" at 56x63 is mush.
  const ball = playDirector.ball;
  const session = focus.display;
  if ((ball && !pixelated) || session) {
    ctx!.save();
    applyFit(
      ctx as unknown as Parameters<typeof applyFit>[0],
      computeFit(window.innerWidth, window.innerHeight),
    );
    if (session) {
      const shown = { ...session, progress: focus.progress };
      drawFocusRing(
        ctx as unknown as Parameters<typeof drawFocusRing>[0],
        shown,
        pixelated,
      );
      drawFocusPill(ctx as unknown as Parameters<typeof drawFocusPill>[0], shown);
    }
    if (ball && !pixelated) {
      drawBall(ctx as unknown as Parameters<typeof drawBall>[0], ball);
    }
    const swipe = playDirector.swipe;
    if (ball && swipe !== null) {
      drawSwipe(
        ctx as unknown as Parameters<typeof drawSwipe>[0],
        companion,
        playDirector.swipeSide,
        swipe,
        ball,
      );
    }
    ctx!.restore();
  }
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
    // The user is placing the window: stop any walk dead rather than animating
    // it out from under them, and treat where they drop it as the new home.
    draggingWindow = true;
    wander.abort();
    // Hand the window to the OS. From here the webview stops seeing the
    // gesture, so there is no mouseup to wait for — reset on the way out.
    void invokeSafe("start_drag");
    downAt = null;
    // The OS swallows the rest of the gesture, so the drag flag is cleared on a
    // short timer instead of a mouseup that will never arrive.
    window.setTimeout(() => {
      draggingWindow = false;
      const f = hostWindow.getFrame();
      if (hostWindow.isReady) wander.noteUserPlaced({ x: f.x, y: f.y });
    }, 600);
  });

  // The preview waits for a dwell rather than firing on entry: the cursor
  // crosses the companion on its way to everything in that corner of the
  // screen, and a card that appeared each time would be a strobe.
  let dwell: number | undefined;
  window.addEventListener("mouseenter", () => {
    hovering = true;
    clearTimeout(dwell);
    dwell = window.setTimeout(() => {
      // Only if still hovering, and never on top of something being said.
      if (!hovering || !tracker || moodOverride !== null) return;
      say({ kind: "preview", stats: tracker.serialize() });
    }, HOVER_DWELL_MS);
  });
  window.addEventListener("mouseleave", () => {
    hovering = false;
    clearTimeout(dwell);
    // Only the preview follows the cursor away. A nudge you moved the mouse
    // past is a nudge you have not read yet, so it keeps its own timer.
    if (moodOverride === null) hush();
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    const wasClick = downAt !== null && !dragging;
    downAt = null;
    if (!wasClick) return;

    if (e.shiftKey) {
      characterIndex = (characterIndex + 1) % COMPANIONS.length;
      companion = COMPANIONS[characterIndex]!;
      // The closet swapping the character out changes whether it can curl.
      curlDirector.canLoaf = canCurl(companion);
    } else {
      moodIndex = (moodIndex + 1) % ALL_MOODS.length;
    }
    updateProbeLabel();
  });

  // Spike controls, until the closet window exists to own these properly.
  window.addEventListener("keydown", (e) => {
    switch (e.key.toLowerCase()) {
      case "d": // diagnostics, off unless asked for
        debugVisible = !debugVisible;
        break;
      case "o": // cycle the wardrobe: bare -> garments -> seasonal -> bare
        outfitIndex = (outfitIndex + 1) % OUTFIT_CYCLE.length;
        break;
      case "p": // pixel art
        pixelated = !pixelated;
        break;
      case "b": // force a game of fetch, which otherwise takes minutes
        playDirector.forcePlay();
        break;
      case "l": // force a loaf, same reason
        curlDirector.forceCurl(performance.now(), 30);
        break;
      case "f": // start / pause a focus session
        focus.toggle();
        break;
      case "r": // back to the top of the chosen length
        focus.reset();
        break;
      default:
        return;
    }
    updateProbeLabel();
  });
}

let lastProbeLine = "";

function updateProbeLabel(extra?: string): void {
  if (!probeEl) return;
  if (extra !== undefined) lastProbeLine = extra;
  probeEl.hidden = !debugVisible;
  if (!debugVisible) return;
  const wearing = currentOutfit()?.name ?? OUTFIT_CYCLE[outfitIndex] ?? "bare";
  probeEl.textContent =
    `${companion.defaultName} · ${ALL_MOODS[moodIndex]}` +
    `\n${wearing}${pixelated ? " · pixel" : ""}` +
    `\n${lastProbeLine}`;
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

/**
 * One tracker tick: ask the OS what is in front and how long since you touched
 * anything, credit the time, and label the result.
 *
 * The foreground query and the idle query are the same round trip the debug
 * label already needed, so this replaced the separate probe poll rather than
 * running alongside it — two independent pollers would have asked the OS the
 * same question twice a second apart and disagreed about it in the UI.
 */
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

  const where = report.app
    ? `${report.platform}: ${report.app.name || "(unnamed)"} #${report.app.pid}`
    : `${report.platform}: ${report.reason ?? "nothing focused"}`;

  if (tracker) {
    // `null` for either reading means the OS would not say, which is not the
    // same as "nothing" — the tracker decides what to do with that, and it must
    // not be flattened into a guess on the way there.
    const idle = await invokeSafe<number | null>("idle_seconds");
    lastTickResult = tracker.tick(report.app?.name ?? null, idle ?? null);
    if (lastTickResult === "breakDue") nudge();
    if (++ticksSinceSave >= SAVE_EVERY) saveHistory();
  }

  updateProbeLabel(
    tracker
      ? `${where}\n${formatDuration(tracker.totalToday)} today · ${lastTickResult}`
      : `${where}\n${lastTickResult}`,
  );
}

window.addEventListener("resize", resize);
resize();
watchPixelRatio();
wireInteraction();
updateProbeLabel("starting…");

/**
 * The last chance to write. A quit between two saves would otherwise cost up to
 * a minute of the day, and `pagehide` is the event that actually fires when a
 * webview goes away — `beforeunload` is unreliable in an embedded one.
 */
window.addEventListener("pagehide", saveHistory);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveHistory();
});

// The dashboard window's buttons arrive here. Guarded rather than caught: in a
// plain browser preview there is no event bus at all, and a rejected promise on
// every launch would bury the errors that matter.
if (hasTauriHost()) {
  void listen(COMMAND_EVENT, (e) => applyCommand(e.payload)).catch((err) => {
    // Not fatal — it only means the dashboard is read-only.
    console.error("dashboard commands unavailable", err);
  });
}

void loadHistory().then(() => void pollPlatform());
// Five seconds, matching the reference: the interval IS the unit of time
// credited, so changing it changes what a recorded second means.
setInterval(() => void pollPlatform(), TICK_INTERVAL * 1000);
requestAnimationFrame(frame);
