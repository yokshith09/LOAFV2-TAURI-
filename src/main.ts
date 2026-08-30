/**
 * The companion window — the pet itself, and the owner of everything the other
 * windows only display.
 *
 * It draws the character, runs the ambient layer, ticks the tracker, and is the
 * single writer of both the screen-time file and the closet's choices. The
 * dashboard, bubble and closet windows send it validated events and render what
 * it broadcasts back; none of them writes state of its own.
 */

import { COMPANIONS, findCompanion } from "./companions/registry";
import { OUTFITS, findOutfit, SEASONAL_ID, seasonalOutfit } from "./outfits/registry";
import { renderScene } from "./render/scene";
import { renderPixelScene } from "./render/pixelate";
import { CurlDirector, canCurl } from "./behaviour/curl";
import { PlayDirector } from "./behaviour/play";
import { WanderController } from "./behaviour/wander";
import { drawBall, drawSwipe } from "./behaviour/furBall";
import { resolveLicence, licenceInputs } from "./behaviour/licence";
import { loadHabits, saveHabits, habitLine, isHabit } from "./behaviour/habits";
import { resolveMood } from "./behaviour/mood";
import { TauriMovableWindow } from "./platform/tauriWindow";
import { applyFit, computeFit } from "./render/scene";
import { FocusTimer } from "./focus/timer";
import {
  FOCUS_COMMAND_EVENT,
  FOCUS_STATE_EVENT,
  FOCUS_HELLO_EVENT,
  isFocusCommand,
} from "./focus/events";
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
  tantrumLine,
  sessionDoneLine,
} from "./bubble/prompts";
import {
  CLOSET_PICK_EVENT,
  CLOSET_CHANGED_EVENT,
  CLOSET_HELLO_EVENT,
  isClosetPick,
} from "./closet/events";
import {
  ClosetSettings,
  browserStore,
  displayName,
  isSeasonal,
  normaliseName,
  NO_OUTFIT,
} from "./closet/settings";
import { PrivacyRadar, type ProbeOutcome } from "./radar/radar";
import {
  loadPacks,
  mergeCompanions,
  browserImageLoader,
  FAILURE_NOTES,
  type RawPack,
} from "./sprites/load";
import { SoundKit, loadSoundSettings, saveSoundSettings } from "./sound/soundKit";
import {
  ONBOARD_DECISION_EVENT,
  ONBOARD_STATE_EVENT,
  ONBOARD_HELLO_EVENT,
  isDecision,
} from "./onboarding/events";
import type { OnboardingStep, OnboardingPlatform } from "./onboarding/view";
import { isOccasion, type Occasion } from "./sound/voice";
import { unavailableRadar, type RadarSnapshot } from "./dashboard/html";
import { RADAR_STATE_EVENT, RADAR_HELLO_EVENT } from "./dashboard/events";
import {
  ALL_MOODS,
  asCtx2D,
  type Companion,
  type Mood,
  type Outfit,
  type SceneState,
} from "./core/types";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
const probeEl = document.getElementById("probe") as HTMLDivElement | null;

if (!canvas) throw new Error("missing #stage canvas");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context unavailable — webview is too old");

/**
 * Overridden by the alt-click development shortcut, and nothing else.
 *
 * Sits at the bottom of the ladder in `currentMood`, in place of `idle`, so
 * cycling through the faces still works while every real signal keeps
 * precedence over it.
 */
let debugMood: Mood | null = null;

// --- The wardrobe ------------------------------------------------------------

/**
 * The closet's choices, and the only writer of them.
 *
 * The closet window reports clicks and this applies them, exactly as the
 * reference divides it. Everything here used to be a debug key-cycle; the
 * characters and garments were all ported and tested but a real user had no way
 * to reach any of them.
 */
/**
 * The closet's stock: the eighteen shipped characters, plus whatever the user
 * has drawn.
 *
 * Mutable because packs arrive after a round trip to disk — the app starts on
 * the built-ins and the drawn ones join a moment later, rather than the window
 * waiting on a folder that is usually empty.
 */
let roster: readonly Companion[] = COMPANIONS;

/**
 * Load hand-drawn characters and put them on the shelf.
 *
 * A pack that fails is named in the console with the reason, and costs nothing
 * else — the app has already started on the built-ins by the time this runs.
 */
async function loadSpritePacks(): Promise<void> {
  const raw = await invokeSafe<RawPack[]>("sprite_packs");
  if (!raw || raw.length === 0) return;

  const { companions, failures } = await loadPacks(raw, browserImageLoader());
  for (const failure of failures) {
    console.warn(`character "${failure.folder}" was skipped: ${FAILURE_NOTES[failure.reason]}`);
  }
  if (companions.length === 0) return;

  roster = mergeCompanions(COMPANIONS, companions);
  // A pack replacing the character already on duty has to take over now, not at
  // the next restart.
  adoptClosetState();
  announceCloset();
}

const closet = new ClosetSettings(browserStore());
let closetState = closet.read();
let companion = findCompanion(closetState.companionId);
let pixelated = closetState.pixelated;

/**
 * The keyboard cycle, kept for development only.
 *
 * Walks bare -> each garment -> seasonal -> bare. The closet is the real way in
 * now, so this exists to flip through eighteen characters quickly while working
 * on the art, not as a feature.
 */
const OUTFIT_CYCLE: ReadonlyArray<string | null> = [
  null,
  ...OUTFITS.map((o) => o.id),
  SEASONAL_ID,
];

function currentOutfit(): Outfit | null {
  if (closetState.outfitId === NO_OUTFIT) return null;
  // Resolved every frame rather than cached, so someone who leaves Loaf running
  // across a month boundary sees the wardrobe change under them — the same
  // reason the reference re-checks this on every tick.
  if (isSeasonal(closetState.outfitId)) return seasonalOutfit();
  return findOutfit(closetState.outfitId);
}

/** What this character is called: the user's name for it, or its own. */
function companionName(): string {
  return displayName(closetState, companion.id, companion.defaultName);
}

/**
 * Apply a click from the closet window, persist it, and say so.
 *
 * The broadcast is what keeps the closet's selection and its thumbnails — which
 * all wear the current outfit — in step with the character in the corner.
 */
function applyClosetPick(raw: unknown): void {
  if (!isClosetPick(raw)) return;
  switch (raw.kind) {
    case "companion":
      closet.setCompanion(raw.id);
      break;
    case "outfit":
      closet.setOutfit(raw.id);
      break;
    case "pixelated":
      closet.setPixelated(raw.on);
      break;
    case "rename":
      // Names are per character: renaming the cat must not rename the dog.
      closet.setName(closetState.companionId, normaliseName(raw.name));
      break;
    case "muted":
      sound.settings.muted = raw.on;
      saveSoundSettings(browserStore(), sound.settings);
      // A noise confirming that noises are back on, and silence confirming
      // silence — the switch demonstrates itself.
      if (!raw.on) makeNoise("greeting");
      break;
    case "habit": {
      if (!isHabit(raw.habit)) return;
      behaviour[raw.habit] = raw.on;
      saveHabits(browserStore(), behaviour);
      // Only the two that change where he physically is get a line — a bubble
      // for every switch is a pet that talks back at you for using its settings.
      const line = habitLine(raw.habit, raw.on);
      if (line) say({ kind: "speech", text: line, seconds: 7 });
      break;
    }
  }
  adoptClosetState();
  announceCloset();
}

/** Tell the closet what the state is now. It renders from this, not from storage. */
function announceCloset(): void {
  if (!hasTauriHost()) return;
  // The habits live in `behaviour`, not in the closet's own storage, so they
  // are attached here rather than read there.
  closet.muted = sound.settings.muted;
  closet.habits = {
    loafing: behaviour.loafing,
    playing: behaviour.playing,
    wandering: behaviour.wandering,
    drifting: behaviour.drifting,
  };
  closetState = closet.read();
  void emit(CLOSET_CHANGED_EVENT, closetState).catch(() => {
    // The closet will still be right the next time it is opened.
  });
}

/** Re-read the stored choices and make the live character match. */
function adoptClosetState(): void {
  closetState = closet.read();
  // Resolved against the roster, not just the built-ins, so a drawn character
  // can be the one on duty.
  const next =
    roster.find((c) => c.id === closetState.companionId) ??
    findCompanion(closetState.companionId);
  if (next.id !== companion.id) {
    companion = next;
    // Curling is a property of the animal — a plane does not loaf — so this has
    // to be re-asked on every change, not once at startup.
    curlDirector.canLoaf = canCurl(companion);
  }
  pixelated = closetState.pixelated;
}

// --- The ambient layer -------------------------------------------------------

const behaviour = loadHabits(browserStore());
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

/**
 * The session ending is the whole promise.
 *
 * The focus window says "He'll say something when it runs out" in as many
 * words, and until now nothing was wired to `onFinish` — so a session ended in
 * silence and the window was lying. The number quoted is the time the session
 * actually took, which is why the timer keeps `duration` at spent + left even
 * when a "-5" cuts it short.
 *
 * It also lands as the break the fifteen-minute nudge stood down for: this is
 * the interruption the user chose, arriving at the moment they chose it.
 */
focus.onFinish = (planned) => {
  makeNoise("finish");
  moodOverride = "happy";
  say({
    kind: "speech",
    text: sessionDoneLine(planned),
    seconds: 12,
  });
  window.setTimeout(() => {
    moodOverride = null;
  }, 12_000);
  announceFocus();
};

/**
 * Apply a click from the focus window and broadcast where the timer now is.
 *
 * Same division as the closet: that window owns no timer, because this one
 * already has one that persists across a quit and draws the ring at the
 * character's feet.
 */
function applyFocusCommand(raw: unknown): void {
  if (!isFocusCommand(raw)) return;
  switch (raw.kind) {
    case "preset":
      focus.setDurationMinutes(raw.minutes);
      break;
    case "adjust":
      focus.adjust(raw.minutes);
      break;
    case "toggle":
      focus.toggle();
      break;
    case "reset":
      focus.reset();
      break;
  }
  announceFocus();
}

function announceFocus(): void {
  if (!hasTauriHost()) return;
  void emit(FOCUS_STATE_EVENT, focus.snapshot).catch(() => {
    // The window recomputes from its last snapshot; a dropped broadcast costs a
    // stale state name, not a wrong clock.
  });
}

/**
 * The state the focus window last heard about.
 *
 * Compared each tick so a session ending on its own — nobody clicked anything —
 * still reaches the window. Only the state is watched: the clock needs no
 * message at all, because the window derives it from the deadline.
 */
let lastAnnouncedFocusState: string | null = null;

function pollFocusState(): void {
  if (focus.state === lastAnnouncedFocusState) return;
  lastAnnouncedFocusState = focus.state;
  announceFocus();
}

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
    // The radar files its domains into the tracker, so it cannot exist before
    // the history has been read — the ledger it writes to is that object.
    radar = new PrivacyRadar(tracker);
    radar.onTantrumBegan = (alert) => {
      makeNoise("tantrum");
      say({ kind: "speech", text: tantrumLine(alert.count, alert.browser), seconds: 10 });
    };
    radar.onTantrumEnded = (count) => {
      makeNoise("praise");
      say({ kind: "speech", text: `Down to ${count}. Thank you. Genuinely.`, seconds: 7 });
    };
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
      radar?.forget();
      announceRadar();
      break;
    case "radar:on":
      // Opens the consent screen rather than switching it on. See onboardingStep.
      void invokeSafe("open_onboarding");
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

// --- Noise -------------------------------------------------------------------

const sound = new SoundKit({ settings: loadSoundSettings(browserStore()) });

/**
 * Load whatever the user put in the Sounds folder.
 *
 * Their files win over the synthesised placeholders — that is the whole point
 * of the folder. Fetched as bytes and wrapped in a blob rather than played from
 * a path, so no filesystem path ever reaches a window and nothing has to open
 * the asset protocol to a directory.
 */
async function loadUserSounds(): Promise<void> {
  const available = await invokeSafe<string[]>("user_sounds");
  if (!available) return;
  for (const name of available) {
    if (!isOccasion(name)) continue;
    const file = await invokeSafe<[string, number[]] | null>("read_sound", {
      occasion: name,
    });
    if (!file) continue;
    const [mime, bytes] = file;
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    sound.userSounds.set(name, url);
  }
}

function makeNoise(occasion: Occasion): void {
  sound.play(occasion);
}

// --- The privacy radar -------------------------------------------------------

/**
 * Off by default and unbuilt on Windows.
 *
 * The radar is the one part of Loaf that needs a permission, so it is the one
 * part that has to be switched on deliberately. `supported` is asked once at
 * startup: telling someone the radar is "off, turn it on" when this build
 * cannot read a tab at all would be a button that does nothing.
 */
let radar: PrivacyRadar | null = null;
let radarSupported = false;
let radarReadsInsideBrowser = true;

function announceRadar(): void {
  if (!hasTauriHost()) return;
  void emit(RADAR_STATE_EVENT, radarSnapshot()).catch(() => {
    // The dashboard shows what it last heard; it is a refresh behind, not wrong.
  });
}

/**
 * Which screen the consent window is on, and whether it has ever been answered.
 *
 * The radar is never switched on without this: the dashboard's "turn on privacy
 * radar" button opens the screen rather than flipping the setting, because a
 * feature that reads what sites you visit should not be one click away from
 * being on before the deal has been read.
 */
let onboardingStep: OnboardingStep = { step: "intro" };
const K_ONBOARDED = "radar.onboarded";

function announceOnboarding(): void {
  if (!hasTauriHost()) return;
  void emit(ONBOARD_STATE_EVENT, {
    step: onboardingStep,
    platform: onboardingPlatform,
  }).catch(() => {});
}

let onboardingPlatform: OnboardingPlatform = "other";

/**
 * Answer the consent screen.
 *
 * "No" is a real answer and is remembered: someone who declined should not be
 * asked again every launch, which is how a consent screen turns into nagging.
 */
function applyDecision(raw: unknown): void {
  if (!isDecision(raw)) return;
  switch (raw) {
    case "no":
      browserStore().setItem(K_ONBOARDED, "1");
      void invokeSafe("close_onboarding");
      return;
    case "settings":
      void invokeSafe("open_automation_settings");
      return;
    case "close":
      void invokeSafe("close_onboarding");
      return;
    case "yes":
      break;
  }

  browserStore().setItem(K_ONBOARDED, "1");
  if (!radar || !radarSupported) {
    void invokeSafe("close_onboarding");
    return;
  }
  radar.settings.enabled = true;
  announceRadar();
  say({ kind: "speech", text: "Radar on. Domains only — never the page.", seconds: 8 });

  // The screen stays up through the asking so the user can see what happened,
  // and lands on a list of which browsers answered.
  onboardingStep = { step: "asking" };
  announceOnboarding();
  void finishOnboarding();
}

/**
 * Ask every known browser once, then report back.
 *
 * On macOS each of these raises the OS's own Automation prompt, which is why
 * the screen says so and why it waits. On Windows nothing is prompted and this
 * simply finds out what can be read.
 */
async function finishOnboarding(): Promise<void> {
  const report = await invokeSafe<{ app: { name: string; raw: string } | null }>(
    "foreground_app",
  );
  if (radar && report?.app) {
    // Only the browser in front, as ever: nothing here may launch one.
    await pollRadar(report.app.raw, report.app.name, 0);
  }
  onboardingStep = { step: "done", statuses: radar?.statusRows() ?? [] };
  announceOnboarding();
  announceRadar();
}

function radarSnapshot(): RadarSnapshot {
  if (!radar || !radarSupported) return unavailableRadar();
  return {
    available: true,
    readsInsideBrowser: radarReadsInsideBrowser,
    enabled: radar.settings.enabled,
    tabThreshold: radar.settings.tabThreshold,
    peakTabsNow: radar.peakTabsNow,
    statusRows: radar.statusRows(),
  };
}

/**
 * Ask the frontmost browser about its tabs, if it is one and if it is time.
 *
 * Only ever the app already in front: `tell application` would launch a browser
 * that was closed, and a pet that opens Chrome to count its tabs has become the
 * problem it was reporting on.
 */
async function pollRadar(raw: string | null, name: string, seconds: number): Promise<void> {
  if (!radar || raw === null) return;
  radar.expireStaleReadings();
  const browser = radar.target(raw);
  if (!browser) return;

  const outcome = await invokeSafe<ProbeOutcome>("probe_browser", {
    bundleId: browser.bundleId,
    safari: browser.flavour === "safari",
  });
  if (!outcome) return;
  radar.absorb(browser, name, outcome, seconds);
}

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

function currentMood(): Mood {
  return resolveMood({
    hovering,
    tabAlert: radar?.tabAlert != null,
    override: moodOverride,
    sleeping,
    debug: debugMood,
  });
}

/**
 * Away from the keyboard for longer than the tracker's idle threshold.
 *
 * The tracker has been reporting this on every tick since it landed and nobody
 * was listening, so the character stayed wide awake through a lunch break.
 */
let sleeping = false;

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
  pollFocusState();
  const licence = resolveLicence(
    licenceInputs({
      // `mood` reports happy while you are petting him even mid-tantrum — a
      // deliberate lie, and the right one for the FACE. The ambient layer gets
      // the truth: forty-seven tabs are still forty-seven tabs, and a ball
      // rolling around under a flashing badge undercuts its own warning.
      mood: radar?.tabAlert != null ? "tantrum" : mood,
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

  const mood = currentMood();
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
      asCtx2D(ctx!),
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
      // Development shortcut, routed through the closet so there is one writer
      // of the choice and it still survives a restart.
      const i = roster.findIndex((c) => c.id === companion.id);
      const next = roster[(i + 1) % roster.length]!;
      applyClosetPick({ kind: "companion", id: next.id });
    } else if (e.altKey) {
      const at = debugMood === null ? -1 : ALL_MOODS.indexOf(debugMood);
      const next = ALL_MOODS[(at + 1) % ALL_MOODS.length]!;
      debugMood = next === "idle" ? null : next;
    } else {
      // What the hover card has been promising since it landed: "Click for the
      // full dashboard →". Until now a click cycled the mood instead, which
      // made the card's own invitation a lie.
      makeNoise("greeting");
      void invokeSafe("open_dashboard");
    }
    updateProbeLabel();
  });

  // Development shortcuts. The closet window owns all of this properly now;
  // these stay because flipping through eighteen characters with a keypress is
  // how the art gets worked on.
  window.addEventListener("keydown", (e) => {
    switch (e.key.toLowerCase()) {
      case "d": // diagnostics, off unless asked for
        debugVisible = !debugVisible;
        break;
      case "o": {
        // Cycle the wardrobe: bare -> garments -> seasonal -> bare.
        const at = OUTFIT_CYCLE.indexOf(
          closetState.outfitId === NO_OUTFIT ? null : closetState.outfitId,
        );
        const next = OUTFIT_CYCLE[(at + 1) % OUTFIT_CYCLE.length];
        applyClosetPick({ kind: "outfit", id: next ?? NO_OUTFIT });
        break;
      }
      case "p": // pixel art
        applyClosetPick({ kind: "pixelated", on: !pixelated });
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
  const wearing = currentOutfit()?.name ?? "bare";
  probeEl.textContent =
    `${companionName()} · ${currentMood()}` +
    `\n${wearing}${pixelated ? " · pixel" : ""}` +
    `\n${lastProbeLine}`;
}

/** Call a Tauri command, tolerating running in a plain browser. */
async function invokeSafe<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(cmd, args)) as T;
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
    app: { name: string; raw: string; pid: number } | null;
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
    sleeping = lastTickResult === "idle";
    if (lastTickResult === "breakDue") nudge();

    // Away from the keyboard means the browser is not earning time either, so
    // the radar sits out idle ticks rather than crediting a domain for a lunch
    // break.
    void pollRadar(
      report.app?.raw ?? null,
      report.app?.name ?? "",
      lastTickResult === "idle" ? 0 : TICK_INTERVAL,
    );
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
  void listen(FOCUS_COMMAND_EVENT, (e) => applyFocusCommand(e.payload)).catch((err) => {
    console.error("focus commands unavailable", err);
  });
  void listen(ONBOARD_DECISION_EVENT, (e) => applyDecision(e.payload)).catch(() => {
    // The consent screen falls back to doing nothing, which is the safe way for
    // this particular window to fail.
  });
  void listen(ONBOARD_HELLO_EVENT, () => announceOnboarding()).catch(() => {});
  void listen(RADAR_HELLO_EVENT, () => announceRadar()).catch(() => {
    // The dashboard falls back to showing the radar as unavailable.
  });
  void listen(FOCUS_HELLO_EVENT, () => announceFocus()).catch(() => {
    // The focus window falls back to showing an idle timer.
  });
  void listen(CLOSET_PICK_EVENT, (e) => applyClosetPick(e.payload)).catch((err) => {
    console.error("closet picks unavailable", err);
  });
  // A freshly opened closet asks who is on duty rather than assuming its own
  // storage is in step with this window's.
  void listen(CLOSET_HELLO_EVENT, () => announceCloset()).catch(() => {
    // The closet falls back to reading storage itself.
  });
  void listen(COMMAND_EVENT, (e) => applyCommand(e.payload)).catch((err) => {
    // Not fatal — it only means the dashboard is read-only.
    console.error("dashboard commands unavailable", err);
  });
}

void loadHistory()
  .then(async () => {
    const support = await invokeSafe<{
      supported: boolean;
      readsInsideBrowser: boolean;
    }>("browser_probe_supported");
    void loadUserSounds();
    void loadSpritePacks();
    radarSupported = support?.supported ?? false;
    radarReadsInsideBrowser = support?.readsInsideBrowser ?? true;
    onboardingPlatform = radarReadsInsideBrowser ? "macos" : "windows";
    announceRadar();
  })
  .then(() => void pollPlatform());
// Five seconds, matching the reference: the interval IS the unit of time
// credited, so changing it changes what a recorded second means.
setInterval(() => void pollPlatform(), TICK_INTERVAL * 1000);
requestAnimationFrame(frame);
