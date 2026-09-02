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
import { Speaker, browserSynth, saveVoice, loadVoice } from "./voice/speak";
import { WakeGate, wakePhrases, wakeWordsFor, normaliseWakeWord } from "./voice/wake";
import { spokenPhrases } from "./voice/phrases";
import { usesWakeWord, NEEDS_MICROPHONE, type ListenMode } from "./voice/mode";
import {
  resolveEngine,
  leavesMachine,
  audioLine,
  type EngineAvailability,
} from "./voice/engine";
import { resolveLicence, licenceInputs } from "./behaviour/licence";
import { HABITS, loadHabits, saveHabits, habitLine, isHabit } from "./behaviour/habits";
import { resolveMood } from "./behaviour/mood";
import { ScrollEnergy } from "./behaviour/scroll";
import { WorkingWatch, WORTH_MENTIONING_SECONDS } from "./behaviour/working";
import { Bakery } from "./bakery/bakery";
import { drawLoaf } from "./render/loafDraw";
import { collectWrapped, worthMaking, WEEK_DAYS } from "./wrapped/wrapped";
import { drawCard, CARD_SIZE, CARD_SCALE, CHARACTER_BOX } from "./wrapped/card";
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
import { Tracker, TICK_INTERVAL, formatDuration, dayKeyFor } from "./tracker/tracker";
import {
  MemoryStatsStore,
  TauriStatsStore,
  hasTauriHost,
  type StatsStore,
} from "./tracker/statsStore";
import { emit, listen } from "@tauri-apps/api/event";
import {
  COMMAND_EVENT,
  STATS_CHANGED_EVENT,
  TASK_COMMAND_EVENT,
  TASKS_CHANGED_EVENT,
  SPOKEN_EVENT,
  SPOKEN_REPLY_EVENT,
  isCommand,
  isTaskCommand,
} from "./dashboard/events";
import { TaskList, isPriority, type Priority } from "./tasks/tasks";
import {
  parseIntent,
  acknowledge,
  needsConfirmation,
  isAffirmative,
  type Intent,
} from "./voice/commands";
import { BUBBLE_SHOW_EVENT, BUBBLE_HIDE_EVENT, type BubblePayload } from "./bubble/events";
import {
  BREAK_PROMPTS,
  BREAK_BUBBLE_SECONDS,
  HOVER_DWELL_MS,
  PromptRotation,
  mayNudge,
  tantrumLine,
  sessionDoneLine,
  closetGreeting,
  renameLine,
  aboutLine,
  LINES,
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
import {
  PrivacyRadar,
  loadRadarSettings,
  saveRadarSettings,
  type ProbeOutcome,
} from "./radar/radar";
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
  WaterGuide,
  WATER_PROMPTS,
  HyperfocusWatch,
  HYPERFOCUS_PROMPTS,
} from "./behaviour/water";
import { gazeToward, easeGaze, LOOKING_AHEAD, type Gaze } from "./behaviour/gaze";
import {
  AppSwitchWatch,
  OncePer,
  hoppingLine,
  tunnelLine,
  lateNightLine,
  overworkLine,
} from "./insights/behaviour";
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
    case "companion": {
      closet.setCompanion(raw.id);
      const arrived = roster.find((c) => c.id === raw.id);
      if (arrived) {
        makeNoise("greeting");
        say({
          kind: "speech",
          text: closetGreeting(
            displayName(closet.read(), arrived.id, arrived.defaultName),
            arrived.species,
          ),
          seconds: 7,
        });
      }
      break;
    }
    case "outfit":
      closet.setOutfit(raw.id);
      break;
    case "pixelated":
      closet.setPixelated(raw.on);
      say({ kind: "speech", text: raw.on ? LINES.pixelOn : LINES.pixelOff, seconds: 6 });
      break;
    case "rename": {
      // Names are per character: renaming the cat must not rename the dog.
      const chosen = normaliseName(raw.name);
      closet.setName(closetState.companionId, chosen);
      say({
        kind: "speech",
        text: renameLine(chosen ?? companion.defaultName, chosen === null),
        seconds: 6,
      });
      break;
    }
    case "listenMode":
      setListenMode(raw.mode);
      return;
    case "wakeWord": {
      // Validated here rather than trusted: an unusable word would leave Loaf
      // listening for something nobody can say, which looks exactly like a
      // broken microphone.
      const cleaned = raw.word === null ? null : normaliseWakeWord(raw.word);
      if (raw.word !== null && cleaned === null) {
        say({
          kind: "speech",
          text: "That one would not work as a wake word. Try two short words.",
          seconds: 8,
        });
        announceCloset();
        return;
      }
      behaviour.wakeWord = cleaned;
      saveHabits(browserStore(), behaviour);
      wakeGate.words = wakeWordsFor(cleaned);
      announceCloset();
      // The grammar is fixed for the life of a session, so a new word needs a
      // new one. Off then on, rather than a restart that could silently fail.
      if (usesWakeWord(behaviour.listenMode)) {
        void (async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("stop_wake").catch(() => {});
          wakeRunning = false;
          await syncListening();
        })();
      }
      return;
    }
    case "hoverListenMs":
      behaviour.hoverListenMs = raw.ms;
      saveHabits(browserStore(), behaviour);
      announceCloset();
      return;
    case "engine":
      // Only ever set to something that can actually run. resolveEngine falls
      // back to the local recogniser, never to the hosted one.
      behaviour.engine = resolveEngine(raw.id, engineAvailability());
      saveHabits(browserStore(), behaviour);
      announceCloset();
      if (leavesMachine(behaviour.engine)) {
        say({ kind: "speech", text: audioLine(behaviour.engine), seconds: 10 });
      }
      return;
    case "voice":
      // Null is "let Loaf choose", which pickVoice already does.
      speaker.preferred = raw.name;
      saveVoice(browserStore(), raw.name);
      saveHabits(browserStore(), behaviour);
      announceCloset();
      return;
    case "muted":
      sound.settings.muted = raw.on;
      saveSoundSettings(browserStore(), sound.settings);
      // A noise confirming that noises are back on, and silence confirming
      // silence — the switch demonstrates itself.
      if (!raw.on) makeNoise("greeting");
      say({ kind: "speech", text: raw.on ? LINES.muted : LINES.unmuted, seconds: 5 });
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

/**
 * Draw the week and write it to a file.
 *
 * Rendered on an offscreen canvas rather than the companion's, so the pet on
 * screen does not flicker while a 1080px image is composed over the top of it.
 */
async function saveRecap(): Promise<void> {
  if (!tracker) return;

  const history = tracker.history(WEEK_DAYS);
  if (!worthMaking(history)) {
    say({
      kind: "speech",
      text: "Not enough of a week yet.\nAsk me again in a few days.",
      seconds: 7,
    });
    return;
  }

  const dayKeys = history.map((d) => dayKeyFor(d.date));
  const stats = collectWrapped({
    history,
    loaves: bakery.loaves,
    // Across the WEEK, not today. This read `tracker.today` and printed it
    // under a heading that says "my week" — the wrong number on the one thing
    // other people see.
    appTotals: tracker.appTotalsAcross(dayKeys),
    peakTabsByDay: tracker.peakTabsAcross(dayKeys),
    dayKeys,
  });
  if (stats === null) return;

  const canvas = document.createElement("canvas");
  canvas.width = CARD_SIZE * CARD_SCALE;
  canvas.height = CARD_SIZE * CARD_SCALE;
  const cardCtx = canvas.getContext("2d");
  if (!cardCtx) return;
  cardCtx.scale(CARD_SCALE, CARD_SCALE);

  drawCard(asCtx2D(cardCtx), stats, {
    name: companionName(),
    drawCharacter: () => {
      // The same renderer the window uses, fitted into the card's box, so the
      // character on the card is the one you have been looking at all week —
      // right coat, right species, right everything.
      cardCtx.save();
      cardCtx.translate(CHARACTER_BOX.x, CHARACTER_BOX.y);
      renderScene(
        asCtx2D(cardCtx),
        companion,
        { mood: "happy", phase: 0, blinking: false },
        CHARACTER_BOX.width,
        CHARACTER_BOX.height,
        currentOutfit(),
      );
      cardCtx.restore();
    },
  });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return;
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));

  const path = await invokeSafe<string>("save_recap", {
    png: bytes,
    name: `loaf-week-${stats.to}.png`,
  });
  say({
    kind: "speech",
    text:
      path === null
        ? "I could not save that, sorry."
        : `Saved your week.
It is in ${path.replace(/^.*[\/]/, "")}, in the Recaps folder.`,
    seconds: 10,
  });
}

/**
 * The median of the days before today, or null when there are too few.
 *
 * The same definition the dashboard's pattern notes use, so "a long day by your
 * standards" and "more than usual" can never disagree with each other.
 */
function usualDaySeconds(): number | null {
  if (!tracker) return null;
  const past = tracker
    .history(30)
    .filter((d) => d.hasData && !d.isToday)
    .map((d) => d.total)
    .sort((a, b) => a - b);
  if (past.length < 3) return null;
  const mid = Math.floor(past.length / 2);
  return past.length % 2 === 1 ? past[mid]! : (past[mid - 1]! + past[mid]!) / 2;
}

/**
 * A destructive intent waiting for a yes, and when it expires.
 *
 * Held for a short while only. An unanswered "reset today?" that stayed armed
 * would let an unrelated "yes" ten minutes later delete somebody's history, and
 * a confirmation nobody remembers giving is not a confirmation.
 */
let pendingIntent: { intent: Intent; until: number } | null = null;
const CONFIRM_WINDOW_MS = 30_000;

/**
 * Act on a sentence, from the command box or one day from a microphone.
 *
 * Everything it does routes through the same functions the menu and the
 * dashboard call. There is no second path that could drift from the first, and
 * nothing here can do something a button cannot.
 */
function applySpoken(raw: unknown): void {
  if (typeof raw !== "string") return;

  const replyWith = (text: string): void => {
    say({ kind: "speech", text, seconds: 8 });
    if (hasTauriHost()) void emit(SPOKEN_REPLY_EVENT, text).catch(() => {});
  };

  // An outstanding confirmation takes the next sentence, whatever it is.
  if (pendingIntent !== null) {
    const { intent, until } = pendingIntent;
    pendingIntent = null;
    if (Date.now() > until) {
      replyWith("That took a while — ask me again if you still want it.");
      return;
    }
    if (!isAffirmative(raw)) {
      replyWith("Left it alone.");
      return;
    }
    runIntent(intent);
    return;
  }

  const intent = parseIntent(raw);
  if (intent === null) {
    // Says so rather than doing the closest thing. See commands.ts, rule 1.
    replyWith("I didn't catch that.");
    return;
  }
  if (needsConfirmation(intent)) {
    pendingIntent = { intent, until: Date.now() + CONFIRM_WINDOW_MS };
    replyWith(acknowledge(intent));
    return;
  }
  replyWith(acknowledge(intent));
  runIntent(intent);
}

function runIntent(intent: Intent): void {
  switch (intent.kind) {
    case "focus.start":
      focus.setDurationMinutes(intent.minutes);
      focus.start();
      announceFocus();
      break;
    case "focus.stop":
      if (focus.isActive) bakery.abandon();
      focus.reset();
      announceFocus();
      break;
    case "task.add":
      tasks.add(intent.title, intent.priority, intent.minutes ?? undefined);
      announceTasks();
      break;
    case "sleep":
      applyCommand("sleep");
      break;
    case "wake":
      applyCommand("wake");
      break;
    case "open":
      applyCommand(
        intent.what === "closet"
          ? "open:closet"
          : intent.what === "timer"
            ? "open:focus"
            : "open:dashboard",
      );
      break;
    case "volume.set":
      void machine("set_volume", { percent: intent.percent });
      break;
    case "volume.mute":
      void machine("set_muted", { on: intent.on });
      break;
    case "brightness.set":
      void machine("set_brightness", { percent: intent.percent });
      break;
    case "media":
      void machine("press_keys", { combo: intent.key });
      break;
    case "click":
      void clickOnScreen(intent.target);
      break;
    case "level.ask":
      void reportLevel(intent.what);
      break;
    case "type":
      void machine("type_text", { text: intent.text });
      break;
    case "app.open":
      void openProgram(intent.app);
      break;
    case "app.close":
      void closeProgram(intent.app);
      break;
    case "recap":
      void saveRecap();
      break;
    case "report.today":
      if (tracker) say({ kind: "speech", text: tracker.statsMessage(), seconds: 10 });
      break;
    case "reset.today":
      applyCommand("reset");
      break;
    case "forget.sites":
      applyCommand("sites:forget");
      break;
  }
}

/**
 * Start a program by the name that was heard.
 *
 * The matching happens in Rust, where the installed list lives and where the
 * "near miss launches the wrong thing" rule is tested. A miss is reported as a
 * miss rather than as the closest guess.
 */
/**
 * One machine command, reporting the reason if it will not work.
 *
 * Brightness on a desktop is the common failure: external monitors are driven
 * over DDC/CI and most implement it badly or not at all, so Windows simply
 * does not answer. Saying so is better than a command that silently does
 * nothing.
 */
async function machine(cmd: string, args: Record<string, unknown>): Promise<void> {
  if (!hasTauriHost()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd, args);
  } catch (e) {
    say({ kind: "speech", text: String(e), seconds: 8 });
  }
}

/**
 * Click something in the window that is in front, by name.
 *
 * False means nothing by that name was there, which is a normal answer: the
 * window may have changed since the grammar was built.
 */
/** Say how loud or how bright it currently is. */
async function reportLevel(what: "volume" | "brightness"): Promise<void> {
  if (!hasTauriHost()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const level = await invoke<number>(what === "volume" ? "get_volume" : "get_brightness");
    const name = what === "volume" ? "Volume" : "Brightness";
    say({ kind: "speech", text: `${name} is ${level}.`, seconds: 6 });
  } catch (e) {
    say({ kind: "speech", text: String(e), seconds: 8 });
  }
}

async function clickOnScreen(target: string): Promise<void> {
  if (!hasTauriHost()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const hit = await invoke<boolean>("click_element", { name: target });
    if (!hit) {
      say({ kind: "speech", text: `I could not find ${target} on screen.`, seconds: 6 });
    }
  } catch (e) {
    say({ kind: "speech", text: String(e), seconds: 8 });
  }
}

async function openProgram(name: string): Promise<void> {
  if (!hasTauriHost()) return;
  // Not invokeSafe: that swallows the reason, and the reason here is the
  // message worth saying out loud.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_app", { name });
  } catch (e) {
    say({ kind: "speech", text: String(e), seconds: 8 });
  }
}

/**
 * Ask a program to close.
 *
 * Zero windows asked is a normal answer meaning it was not running, and it is
 * said out loud rather than passing silently — otherwise a misheard program
 * name looks exactly like a program that ignored the request.
 */
async function closeProgram(name: string): Promise<void> {
  if (!hasTauriHost()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const asked = await invoke<number>("close_app", { name });
    if (asked === 0) {
      say({ kind: "speech", text: `${name} was not open.`, seconds: 6 });
    }
  } catch (e) {
    say({ kind: "speech", text: String(e), seconds: 8 });
  }
}

/** Tell the closet what the state is now. It renders from this, not from storage. */
function announceCloset(): void {
  if (!hasTauriHost()) return;
  // The habits live in `behaviour`, not in the closet's own storage, so they
  // are attached here rather than read there.
  closet.muted = sound.settings.muted;
  // Built from HABITS rather than listed by hand.
  //
  // Listing them by hand is what broke the two habits added most recently: the
  // toggles rendered, the clicks arrived, `behaviour` updated — and this
  // function kept broadcasting a four-key object, so the closet re-rendered
  // from a state that had never heard of them and every press appeared to do
  // nothing. Derived from the list, a new habit cannot be forgotten here.
  closet.habits = Object.fromEntries(HABITS.map((h) => [h, behaviour[h]]));
  closet.listenMode = behaviour.listenMode;
  // Local voices only. speaker.voices() has already filtered the remote
  // ones out, so nothing here needs a warning label.
  closet.voices = speaker.voices().map((v) => v.name);
  closet.voice = speaker.preferred;
  closet.wakeWord = behaviour.wakeWord;
  closet.hoverListenMs = behaviour.hoverListenMs;
  closet.engine = behaviour.engine;
  closet.engineAvailability = engineAvailability();
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
  const loaf = bakery.bake(planned / 60, dayKeyFor(new Date()));
  say({
    kind: "speech",
    text: `${sessionDoneLine(planned)}
That's a ${loaf.kind}. ${bakery.total} on the shelf.`,
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
      // Stopping early collapses the loaf and records NOTHING. See bakery.ts:
      // a shelf that also counted what you burned is a scoreboard to hide from.
      if (focus.isActive) bakery.abandon();
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

/** The water reminder, on its own clock. See `water.ts` for why it is separate. */
const water = new WaterGuide();
const waterPrompts = new PromptRotation(WATER_PROMPTS);

/** Notices a very long unbroken stretch, and mentions it once. */
const hyperfocus = new HyperfocusWatch();
const hyperfocusPrompts = new PromptRotation(HYPERFOCUS_PROMPTS);

/** Which application, how often it changed, and how long it has been the one. */
const switches = new AppSwitchWatch();

/**
 * The gate that keeps a companion from becoming an alarm.
 *
 * Every behaviour note is worth hearing once and unbearable on a loop. Two
 * hours between any two of the same kind, and they compete with each other for
 * one slot per tick rather than queueing up.
 */
const behaviourGate = new OncePer(2 * 60 * 60);

/**
 * Sent to sleep by hand, and staying there until told otherwise.
 *
 * Distinct from the idle-detected sleep, which un-sleeps the moment you touch
 * the keyboard. Someone who chose "go to sleep" wants him down while they keep
 * working, so only an explicit wake ends it.
 */
let toldToSleep = false;

/** Where the eyes are pointing, and where they are heading. */
let gaze: Gaze = LOOKING_AHEAD;
let gazeTarget: Gaze = LOOKING_AHEAD;
let lastFrameMs: number | null = null;
let secondsSinceTyping: number | null = null;

/**
 * How faint he goes when unattended.
 *
 * Faint enough that a line of text behind him is readable, solid enough that he
 * still reads as a character rather than a smudge someone forgot to clean off
 * the screen. Below about 0.4 the outline goes and he stops being recognisable.
 */
const FADED_ALPHA = 0.55;
let alpha = 1;
let foregroundCpu: number | null = null;

/**
 * What he says when a long job finishes.
 *
 * Proportionate to the wait: the same line after forty seconds and after twenty
 * minutes would be the tell that nobody was really watching.
 */
function finishedLine(seconds: number): string {
  if (seconds >= 600) return "Finally. That was a long one. ☕";
  if (seconds >= 180) return "Done at last. Welcome back.";
  return "That took a moment. All finished.";
}

/** Ticks between saves. The whole file is rewritten, so not every tick. */
const SAVE_EVERY = 12; // once a minute at a five-second tick

async function loadHistory(): Promise<void> {
  try {
    tracker = new Tracker({ json: await statsStore.load() });
    // The radar files its domains into the tracker, so it cannot exist before
    // the history has been read — the ledger it writes to is that object.
    radar = new PrivacyRadar(tracker);
    // What was chosen last time. Without this the consent screen reappears
    // every launch and the tantrum threshold silently returns to 40.
    radar.settings = loadRadarSettings(browserStore());
    radar.onTantrumBegan = (alert) => {
      makeNoise("tantrum");
      say({ kind: "speech", text: tantrumLine(alert.count, alert.browser), seconds: 10 });
    };
    radar.onTantrumEnded = (count) => {
      makeNoise("praise");
      proudUntil = Date.now() + PROUD_SECONDS * 1000;
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

  // `tantrum:<n>` carries a value, so it is handled before the exact matches.
  if (cmd.startsWith("tantrum:")) {
    const n = Number(cmd.slice("tantrum:".length));
    if (radar && Number.isFinite(n)) {
      radar.settings.tabThreshold = n;
      persistRadar();
      announceRadar();
    }
    return;
  }

  switch (cmd) {
    case "reset":
      tracker.resetToday();
      say({ kind: "speech", text: LINES.resetToday, seconds: 6 });
      break;
    case "sites:forget":
      tracker.forgetAllSites();
      radar?.forget();
      announceRadar();
      say({ kind: "speech", text: LINES.forgetSites, seconds: 7 });
      break;
    // The dashboard reaching the rest of the app. These go through the same
    // commands the menu uses, so there is one way to open each window.
    case "open:closet":
      void invokeSafe("open_closet");
      return;
    case "open:focus":
      void invokeSafe("open_focus");
      return;
    case "open:sounds":
      void invokeSafe("open_sounds_folder");
      return;
    case "open:packs":
      void invokeSafe("open_packs_folder");
      return;
    case "recap":
      void saveRecap();
      return;
    case "sleep":
      toldToSleep = true;
      // Nothing is said. A character who announces that he is going to sleep
      // has not gone to sleep.
      hush();
      // And nothing is currently being said either — a bubble left on screen
      // over a sleeping character is the loudest thing about him.
      moodOverride = null;
      return;
    case "wake":
      toldToSleep = false;
      return;
    case "open:star":
      void invokeSafe("open_star");
      return;
    case "open:feedback":
      void invokeSafe("open_feedback");
      return;
    case "radar:on":
      // Opens the consent screen rather than switching it on. See onboardingStep.
      void invokeSafe("open_onboarding");
      return;
    case "about":
      makeNoise("greeting");
      say({ kind: "speech", text: aboutLine(companionName()), seconds: 10 });
      return;
    case "radar:off":
      if (radar) radar.settings.enabled = false;
      persistRadar();
      announceRadar();
      say({ kind: "speech", text: LINES.radarOff, seconds: 8 });
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
  // Silent while asleep, for the same reason. The one exception is the greeting
  // that plays as you wake him, which is a reply to your own tap.
  if (toldToSleep && occasion !== "greeting") return;
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

/**
 * Write the radar's choice down.
 *
 * Called after every mutation rather than on a timer or at exit: the settings
 * are two fields, and a consent that survives only a clean shutdown is a
 * consent the user will be asked for again after any crash.
 */
function persistRadar(): void {
  if (radar) saveRadarSettings(browserStore(), radar.settings);
}
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
      say({ kind: "speech", text: LINES.radarDeclined, seconds: 9 });
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
  persistRadar();
  announceRadar();
  say({ kind: "speech", text: LINES.radarOn, seconds: 8 });

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
  if (radar.settings.enabled) {
  }
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

/**
 * Epoch ms until which he looks pleased with you.
 *
 * A deadline rather than a flag: the praise is a moment, and a flag would need
 * something to remember to clear it. Set when enough tabs close to end a
 * tantrum, which is the only thing in the app that earns it.
 */
let proudUntil = 0;

/**
 * The scrolling pose's trigger.
 *
 * Polled rather than pushed: the platform reports only how long since the wheel
 * last moved, which is all it is allowed to know. Five times a second is enough
 * for a pose that takes about four tenths of a second to strike, and it is a
 * cheap in-process call on both platforms.
 */
const scrollEnergy = new ScrollEnergy();

/**
 * The typing pose, driven by exactly the same machinery as the scroll pose.
 *
 * Reusing `ScrollEnergy` rather than writing a second rise-and-decay: both
 * answer "has this input happened recently enough to hold a pose", the tuning
 * that stops a stray event flicking him into it is the same tuning, and one
 * tested implementation beats two similar ones.
 */
const typingEnergy = new ScrollEnergy();

/** Whether the machine in front of you is busy. See behaviour/working.ts. */
const workingWatch = new WorkingWatch();

/** The oven and the shelf. A focus session bakes; abandoning one collapses. */
const bakery = new Bakery(browserStore());

/** The notetaker. The companion owns it, like everything else with state. */
const tasks = new TaskList(browserStore());

/**
 * What the dashboard and the hover card are shown.
 *
 * Built from `visible()` so both surfaces agree, and the index a click comes
 * back with means the same thing in both directions.
 */
function taskViews(): Array<{ title: string; priority: Priority; minutesLeft: number | null }> {
  const now = Date.now();
  return tasks.visible().map((t) => ({
    title: t.title,
    priority: t.priority,
    minutesLeft:
      t.dueAt === null ? null : Math.max(0, Math.round((t.dueAt - now) / 60_000)),
  }));
}

/** Tell every window the list changed. */
function announceTasks(): void {
  if (!hasTauriHost()) return;
  void emit(TASKS_CHANGED_EVENT, taskViews()).catch(() => {
    // The dashboard re-reads when it next renders.
  });
}

/**
 * Apply a task command from the dashboard.
 *
 * `done` and `remove` carry an INDEX into the visible list rather than an id,
 * because the dashboard renders from a broadcast and should not be inventing
 * ids. Resolving it here keeps this the only place that knows what a task's
 * identity is.
 */
function applyTaskCommand(raw: unknown): void {
  if (!isTaskCommand(raw)) return;

  switch (raw.action) {
    case "add": {
      const priority = isPriority(raw.priority) ? raw.priority : "soon";
      const minutes =
        typeof raw.minutes === "number" && raw.minutes > 0 ? raw.minutes : undefined;
      const added = tasks.add(raw.title ?? "", priority, minutes);
      if (added === null) return;
      break;
    }
    case "done":
    case "remove": {
      const index = Number(raw.id);
      if (!Number.isInteger(index) || index < 0) return;
      const target = tasks.visible()[index];
      if (target === undefined) return;
      if (raw.action === "done") tasks.complete(target.id);
      else tasks.remove(target.id);
      break;
    }
    case "clear-done":
      tasks.clearDone();
      break;
  }
  announceTasks();
}
let secondsSinceScroll: number | null = null;
const SCROLL_POLL_MS = 200;
const PROUD_SECONDS = 6;

function currentMood(): Mood {
  return resolveMood({
    hovering,
    tabAlert: radar?.tabAlert != null,
    proud: Date.now() < proudUntil,
    scrolling: scrollEnergy.isScrolling,
    typing: typingEnergy.isScrolling,
    working: workingWatch.busy,
    override: moodOverride,
    // Told to sleep counts the same as having drifted off, so the ladder stays
    // one ladder — hovering still wakes a face, a tantrum still outranks a nap.
    sleeping: sleeping || toldToSleep,
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

/**
 * Loaf's voice, for the habit that lets it read its bubbles aloud.
 *
 * Local voices only, and silence rather than a remote one — see voice/speak.ts.
 */

/**
 * Whether a phrase heard by the always-on session was meant for Loaf.
 *
 * The microphone being open and Loaf ACTING are deliberately different things.
 * See voice/wake.ts for the timing rules and what this does not protect.
 */
const wakeGate = new WakeGate();

/** True while a one-shot listen is in flight, so two cannot overlap. */
let listeningOnce = false;

/**
 * Open the microphone for exactly one sentence.
 *
 * Used by the click and hover modes. Unlike the always-on session this opens
 * the device, takes one phrase and closes it again, which is why it needs no
 * wake word: touching the character IS the wake word.
 */
async function listenOnce(): Promise<void> {
  if (listeningOnce || !hasTauriHost()) return;
  if (!NEEDS_MICROPHONE[behaviour.listenMode]) return;
  if (usesWakeWord(behaviour.listenMode)) return; // the session already has it
  listeningOnce = true;
  micOpen = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // What is clickable in the front window RIGHT NOW. Only the one-shot
    // modes can do this: the always-on grammar is compiled once, and by the
    // time you speak the front window will be a different one.
    const onScreen = (await invoke<string[]>("clickables").catch(() => [])) ?? [];
    const heard = await invoke<{ kind: string; text?: string; why?: string }>("listen_once", {
      phrases: spokenPhrases(programNames, onScreen),
    });
    if (heard.kind === "text" && heard.text) {
      applySpoken(heard.text);
    } else if (heard.kind === "unavailable" && heard.why) {
      say({ kind: "speech", text: heard.why, seconds: 10 });
    }
    // "nothing" is silent on purpose: in hover mode this fires whenever the
    // cursor rests on him, and "I didn't catch that" every time would be a
    // character that complains about being looked at.
  } catch {
    // A failed listen is not worth a bubble; the character is still there.
  } finally {
    listeningOnce = false;
    micOpen = false;
  }
}

/** Whether a microphone is open right now, for the indicator. */
let micOpen = false;

export function isMicOpen(): boolean {
  return micOpen || wakeRunning;
}

/** True while the wake session is up, so we do not start it twice. */
let wakeRunning = false;

/**
 * Bring always-on listening into line with the habit.
 *
 * Called whenever the habit changes and once at startup. The phrase list is
 * the same closed vocabulary push-to-talk uses, plus the wake words — an empty
 * list is refused by Rust rather than started, because the fallback for an
 * empty grammar is continuous dictation.
 */
/**
 * Change how much of the time Loaf may listen.
 *
 * Exported through the closet rather than set directly, so that widening
 * access always passes through one place that can say so out loud.
 */
export function setListenMode(mode: ListenMode): void {
  const before = behaviour.listenMode;
  if (before === mode) return;
  behaviour.listenMode = mode;
  saveHabits(browserStore(), behaviour);
  announceCloset();
  void syncListening();
}

async function syncListening(): Promise<void> {
  if (!hasTauriHost()) return;
  const want = usesWakeWord(behaviour.listenMode);
  if (want === wakeRunning) return;
  const { invoke } = await import("@tauri-apps/api/core");
  if (want) {
    // The gate and the grammar must agree, or Loaf would listen for one word
    // and answer to another.
    wakeGate.words = wakeWordsFor(behaviour.wakeWord);
    const phrases = [...spokenPhrases(programNames), ...wakePhrases(behaviour.wakeWord)];
    try {
      await invoke("start_wake", { phrases });
      wakeRunning = true;
      const word = wakeGate.words[0] ?? "hey loaf";
      say({ kind: "speech", text: `Listening. Say \u201c${word}\u201d.`, seconds: 6 });
    } catch (e) {
      wakeRunning = false;
      behaviour.listenMode = "off";
      announceCloset();
      say({ kind: "speech", text: String(e), seconds: 10 });
    }
  } else {
    try {
      await invoke("stop_wake");
    } catch {
      // Already stopped is not a problem worth reporting.
    }
    wakeRunning = false;
    wakeGate.reset();
  }
}

/**
 * Program names, for the spoken vocabulary.
 *
 * The companion needs its own copy because it owns the wake session; the
 * dashboard reads its own for push-to-talk.
 */
let programNames: readonly string[] = [];

/**
 * What each recogniser needs before it can run.
 *
 * Whisper and the hosted engine are both listed and both unavailable: the
 * model is not bundled yet and nothing is connected through MCP. They are
 * shown rather than hidden so the answer to "can Loaf do dictation" is a
 * reason rather than a silence.
 */
function engineAvailability(): EngineAvailability {
  return {
    builtinReady: speechAvailable,
    whisperModel: false,
    hostedConnected: false,
  };
}

/** Set once the Windows recogniser has proved it can compile a constraint. */
let speechAvailable = false;

const speaker = new Speaker(browserSynth());
// Restored before anything can speak, so a chosen voice survives a restart.
speaker.preferred = loadVoice(browserStore());

function say(payload: BubblePayload): void {
  if (!hasTauriHost()) return;
  // ASLEEP MEANS QUIET. One gate, here, rather than a condition at every call
  // site — the nudge, the water reminder, the tantrum, the finished-job line
  // and anything added later all pass through this function, and a rule
  // enforced in six places is a rule that will be forgotten in the seventh.
  //
  // The preview card is exempt: it only appears because the cursor is on him,
  // which is a question, not an interruption.
  if (toldToSleep && payload.kind !== "preview") return;
  // Spoken here rather than at the call sites, for the same reason the sleep
  // gate is here: one place that every bubble passes through. A preview card
  // is never spoken — it appears because the cursor is resting on him, and
  // reading a hover card aloud would be startling.
  if (payload.kind === "speech") {
    speaker.enabled = behaviour.talking;
    speaker.speak(payload.text);
  }
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
  scrollEnergy.tick(secondsSinceScroll, dt);
  typingEnergy.tick(secondsSinceTyping, dt);
  const work = workingWatch.tick(foregroundCpu, dt);
  if (work.justFinished !== null && work.justFinished >= WORTH_MENTIONING_SECONDS) {
    // Only worth remarking on if it was actually a wait. Nothing is said about
    // a four-second build, and nothing is said over something already speaking.
    if (moodOverride === null && !toldToSleep) {
      say({ kind: "speech", text: finishedLine(work.justFinished), seconds: 6 });
    }
  }
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
  // "Wander around the screen" is the MASTER switch, and drift is a style of
  // wandering rather than an exception to it.
  //
  // It was not, and the bug was exactly what you would predict: drift defaults
  // ON, so a drifting character kept walking after the user had turned the one
  // obvious control off. Two independent switches where the user reasonably
  // reads one as "does he move" is a bug even when both behave as written.
  const drifting = behaviour.wandering && companion.drifts && behaviour.drifting;
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

  // Seconds since the last frame, clamped: a window that was hidden or a
  // machine that slept hands back a gap of minutes, and easing across that in
  // one step would snap the eyes rather than move them.
  const dt = lastFrameMs === null ? 0 : Math.min(0.1, (nowMs - lastFrameMs) / 1000);
  lastFrameMs = nowMs;

  if (nowMs > nextBlinkAt) {
    blinkUntil = nowMs + 130;
    nextBlinkAt = nowMs + 2500 + Math.random() * 4000;
  }

  const mood = currentMood();
  tickAmbient(nowMs, mood);

  bakery.tick(dt);
  if (focus.isActive) bakery.noteProgress(focus.progress);
  gaze = easeGaze(gaze, gazeTarget, dt);

  // Fade toward a ghost of himself when nobody is looking.
  //
  // Eased rather than switched: a companion that snapped between solid and
  // faded would flash every time the cursor crossed him on its way somewhere
  // else. Dragging and speaking both force him solid — you cannot aim at
  // something you can see through, and a bubble over a half-there character
  // reads as a rendering fault.
  const wantSolid =
    !behaviour.fading || hovering || draggingWindow || moodOverride !== null;
  const targetAlpha = wantSolid ? 1 : FADED_ALPHA;
  alpha += (targetAlpha - alpha) * Math.min(1, dt * 6);
  canvas!.style.opacity = alpha.toFixed(3);

  const state: SceneState = {
    mood,
    phase,
    blinking: nowMs < blinkUntil,
    gaze,
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
  // The loaf shares the design space with the ring and the ball, so it goes
  // through the same fit transform and needs the same reason to open the block.
  const bake = bakery.peek(session ? focus.progress : null, focus.duration / 60);
  if ((ball && !pixelated) || session || bake) {
    ctx!.save();
    applyFit(
      ctx as unknown as Parameters<typeof applyFit>[0],
      computeFit(window.innerWidth, window.innerHeight),
    );
    // Under the ring and the ball, so nothing it overlaps is hidden by it.
    drawLoaf(ctx as unknown as Parameters<typeof drawLoaf>[0], bake);
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

  // Pointer events WITH CAPTURE, not mouse events.
  //
  // The window is 134x150. A drag leaves those bounds within a few pixels, and
  // once the pointer is outside them plain `mousemove` stops being delivered —
  // so the threshold below was never reached and the window could never be
  // picked up at all. `setPointerCapture` keeps events coming to this element
  // wherever the pointer goes, which is exactly what a drag needs.
  canvas!.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas!.setPointerCapture(e.pointerId);
    downAt = { x: e.screenX, y: e.screenY };
    dragging = false;
  });

  canvas!.addEventListener("pointermove", (e) => {
    if (!downAt || dragging) return;
    const moved = Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y);
    if (moved < DRAG_THRESHOLD_PX) return;
    dragging = true;
    // Hand the pointer back BEFORE the OS takes the gesture. Once
    // `start_dragging` runs, Windows owns the drag and no `pointerup` ever
    // reaches this window — so a capture still held here is never released, and
    // every later gesture is delivered to a element that is still capturing.
    // That is what made the drag work once and then stop.
    if (canvas!.hasPointerCapture(e.pointerId)) {
      canvas!.releasePointerCapture(e.pointerId);
    }
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
  //
  // Bound to the CANVAS, not to `window`. `mouseenter` does not bubble and is
  // not delivered to `window` in Chromium, so the card could never appear and
  // `hovering` never became true — which also kept the "happy" mood rung, the
  // one the hover is supposed to trigger, permanently unreachable.
  let dwell: number | undefined;
  /** Separate from `dwell`: the card and the microphone have different bars. */
  let listenDwell: number | undefined;
  canvas!.addEventListener("mouseenter", () => {
    hovering = true;
    // Hovering shows the card on the short dwell; LISTENING waits for a much
    // longer hold. The cursor passes over the companion on its way to
    // everything else in that corner, and a microphone that opened on the same
    // dwell as the card would be open most of the day. Holding still for
    // several seconds is a deliberate act; crossing him is not.
    clearTimeout(listenDwell);
    if (behaviour.listenMode === "hover") {
      listenDwell = window.setTimeout(() => {
        if (hovering) void listenOnce();
      }, behaviour.hoverListenMs);
    }
    clearTimeout(dwell);
    dwell = window.setTimeout(() => {
      // Only if still hovering, and never on top of something being said.
      if (!hovering || !tracker || moodOverride !== null) return;
      // The card is a setting now. Someone who wants the character and not the
      // statistics should be able to have that, and hovering still wakes him —
      // the fade and the happy face happen either way.
      if (!behaviour.preview) return;
      say({ kind: "preview", stats: tracker.serialize(), tasks: taskViews() });
    }, HOVER_DWELL_MS);
  });
  canvas!.addEventListener("mouseleave", () => {
    hovering = false;
    clearTimeout(dwell);
    clearTimeout(listenDwell);
    // Only the preview follows the cursor away. A nudge you moved the mouse
    // past is a nudge you have not read yet, so it keeps its own timer.
    if (moodOverride === null) hush();
  });

  // If capture is lost for any reason — the OS taking it, a pointercancel — the
  // gesture is over. Without this, `downAt` stays set and the next click is read
  // as the continuation of a drag that is no longer happening.
  for (const ending of ["pointercancel", "lostpointercapture"] as const) {
    canvas!.addEventListener(ending, () => {
      downAt = null;
      dragging = false;
    });
  }

  // Right-click anywhere on the character shows the whole menu.
  //
  // This is the entry point people find. The tray icon is the other one, and on
  // Windows it is hidden in an overflow flyout by default, which made the
  // closet and the focus timer unreachable for a real user on a real machine.
  // The menu here is the same one the tray builds, so it can never offer less.
  window.addEventListener("contextmenu", (e) => {
    // Otherwise the webview's own "Reload / Inspect" menu appears over ours.
    e.preventDefault();
    void invokeSafe("show_companion_menu");
  });

  // Two taps put the dashboard away. This arrives after both `click` events, so
  // the first has already opened it and this closes it again.
  canvas!.addEventListener("dblclick", () => {
    void invokeSafe("close_dashboard");
  });

  canvas!.addEventListener("pointerup", (e) => {
    if (canvas!.hasPointerCapture(e.pointerId)) {
      canvas!.releasePointerCapture(e.pointerId);
    }
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
      if (toldToSleep) {
        // A tap on a sleeping character wakes him, and does nothing else. The
        // dashboard would bury the one thing you were looking at — whether he
        // woke up.
        toldToSleep = false;
        makeNoise("greeting");
        updateProbeLabel();
        return;
      }
      makeNoise("greeting");
      // Opens IMMEDIATELY. This used to wait 260ms to see whether a second tap
      // was coming, and the first Mac testers reported the click "doesn't work"
      // and rage-clicked. They were right, and the delay caused the very thing
      // that defeated it: nothing happens, so you click again — and the second
      // click both cancelled the pending open and fired `dblclick`, which
      // closes. Rage-clicking was guaranteed to produce nothing at all.
      //
      // A deliberate double tap now opens and immediately closes, which flashes.
      // That is a far smaller sin than a character that appears not to respond:
      // one is a blink, the other makes the whole app feel broken.
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
    // Idle ticks are not switches: coming back to the same app after lunch
    // has not changed anything.
    if (lastTickResult !== "idle") switches.note(report.app?.name ?? null, Date.now());
    sleeping = lastTickResult === "idle";
    if (lastTickResult === "breakDue") nudge();

    // Suppressed while a focus session runs, while he is asleep, and while
    // something is already being said — the clock still resets, so a skipped
    // reminder is skipped rather than saved up to arrive in a burst later.
    const busy =
      (focus.display !== null && !focus.display.paused) ||
      moodOverride !== null ||
      toldToSleep ||
      lastTickResult === "idle";
    // Asked BEFORE water, and it suppresses it: two reminders in the same tick
    // is one companion talking over itself. This is the rarer and larger of the
    // two, so it wins the moment they collide.
    const idled = lastTickResult === "idle";
    const checkIn = hyperfocus.tick(idled ? 0 : TICK_INTERVAL, idled);
    if (checkIn && !busy) {
      say({
        kind: "speech",
        text: hyperfocusPrompts.next(),
        seconds: BREAK_BUBBLE_SECONDS,
      });
    }

    // At most ONE behaviour remark per tick, and only when nothing louder is
    // happening. Ordered by how much it took to notice: a long day beats a long
    // stretch in one app, which beats a burst of switching.
    if (!busy && !checkIn) {
      const nowMs = Date.now();
      const app = switches.app;
      const usual = usualDaySeconds();
      // Each candidate carries a STABLE kind, and the gate keys on that.
      //
      // It used to key on the first twelve characters of the message, which
      // three of these four lines begin with a number that moves: "4h 30m
      // today" and "4h 45m today" are different keys, so the long-day remark
      // re-fired every time the figure ticked. A gate that a changing number
      // walks straight through is not a gate, and the failure it let through is
      // exactly the one it exists to prevent.
      const candidates: ReadonlyArray<readonly [string, string | null]> = [
        ["overwork", usual !== null ? overworkLine(tracker.totalToday, usual, formatDuration) : null],
        ["tunnel", app !== null ? tunnelLine(app, switches.streakSeconds(nowMs) / 60) : null],
        ["hopping", hoppingLine(switches.recent(nowMs))],
        ["late", lateNightLine(new Date().getHours())],
      ];
      for (const [kind, remark] of candidates) {
        if (remark === null) continue;
        if (behaviourGate.allow(kind, nowMs)) {
          say({ kind: "speech", text: remark, seconds: BREAK_BUBBLE_SECONDS });
        }
        // One per tick either way: a remark that is gated does not hand its
        // turn to the next one down, or a quiet kind would speak on behalf of
        // a loud one every two hours.
        break;
      }
    }

    // A task whose timer has come up says so, whatever else is going on: you
    // asked to be told at a particular moment, and this is that moment.
    //
    // `due()` clears the timer on EVERY ready task, so every one of them has to
    // be accounted for here. An earlier version said the first and stopped,
    // which silently swallowed a second reminder that came up in the same
    // minute — the worst possible failure for a feature whose only job is to
    // tell you a thing at a time you chose.
    const ready = tasks.due();
    if (ready.length > 0) {
      const first = ready[0]!;
      const others =
        ready.length > 1
          ? `
(and ${ready.length - 1} more just came up)`
          : "";
      say({
        kind: "speech",
        text: `${first.title}
— you asked me to say.${others}`,
        seconds: BREAK_BUBBLE_SECONDS,
      });
      announceTasks();
    }

    if (water.askNow(busy || checkIn)) {
      say({ kind: "speech", text: waterPrompts.next(), seconds: BREAK_BUBBLE_SECONDS });
    }

    // Away from the keyboard means the browser is not earning time either, so
    // the radar sits out idle ticks rather than crediting a domain for a lunch
    // break.
    void pollRadar(
      report.app?.raw ?? null,
      report.app?.name ?? "",
      lastTickResult === "idle" ? 0 : TICK_INTERVAL,
    );
    ticksSinceSave++;
    if (ticksSinceSave >= SAVE_EVERY) saveHistory();
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
  // A dashboard that just opened knows nothing yet. It says hello, and this is
  // where everything it needs gets sent.
  //
  // Tasks were missing from this, which is why a freshly-opened dashboard said
  // "Nothing on the list" however many notes were outstanding: the list only
  // arrived on the next CHANGE, so the window that had never seen a change
  // showed an empty panel and there was no way to tick anything off.
  void listen(RADAR_HELLO_EVENT, () => {
    announceRadar();
    announceTasks();
  }).catch(() => {
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
  // Everything the always-on session matched. Most of it is ignored: the gate
  // decides what was addressed to Loaf, and while the microphone is open and
  // nobody is talking to the cat, "ignored" is the normal outcome.
  void listen<{ text: string }>("loaf://voice/heard", (e) => {
    const verdict = wakeGate.heard(e.payload.text);
    if (verdict.justWoke) {
      say({ kind: "speech", text: "Mm?", seconds: 4 });
      return;
    }
    if (verdict.command !== null) applySpoken(verdict.command);
  }).catch(() => {
    // No host, no listening.
  });

  // The session can end without being asked — a device change, a sleep. The
  // habit is turned back off so the indicator cannot claim a microphone that
  // is not open.
  void listen<string>("loaf://voice/stopped", (e) => {
    wakeRunning = false;
    wakeGate.reset();
    if (usesWakeWord(behaviour.listenMode)) {
      behaviour.listenMode = "off";
      announceCloset();
      if (e.payload) say({ kind: "speech", text: e.payload, seconds: 10 });
    }
  }).catch(() => {
    // No host, no listening.
  });

  // The program list first, then listening: starting a wake session before the
  // names arrive would compile a grammar that cannot hear "open Notepad", and
  // the grammar is fixed for the life of the session.
  void invokeSafe<boolean>("speech_available").then((ok) => {
    speechAvailable = ok === true;
    announceCloset();
  });

  void invokeSafe<{ name: string }[]>("list_apps").then((apps) => {
    // Voice still works for everything that is not a program name, so a null
    // here needs no message.
    if (apps) programNames = apps.map((a) => a.name);
    // Restores a mode the user chose in an earlier session. syncListening is
    // the only thing that opens a microphone, and it does nothing unless the
    // stored mode is "always".
    void syncListening();
  });

  void listen(SPOKEN_EVENT, (e) => applySpoken(e.payload)).catch(() => {
    // The command box is one of two ways in; the menu still works.
  });

  void listen(TASK_COMMAND_EVENT, (e) => applyTaskCommand(e.payload)).catch(() => {
    // Without this the notetaker has no front door, which is how it shipped.
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
setInterval(() => {
  // Where to look next. Polled rather than read per frame: the eyes ease toward
  // this over several frames anyway, so asking the OS 144 times a second would
  // buy nothing but IPC traffic.
  void invokeSafe<[number, number] | null>("cursor_pos").then((c) => {
    const frame = hostWindow.getFrame();
    gazeTarget = gazeToward(
      c === null ? null : { x: c[0], y: c[1] },
      // The face sits in the upper half of the window, not its middle.
      { x: frame.x + frame.width / 2, y: frame.y + frame.height * 0.4 },
    );
  });

  void invokeSafe<number | null>("seconds_since_typing").then((s) => {
    secondsSinceTyping = s;
  });

  // Asked on the slow timer, and it SLEEPS for a moment inside the command to
  // take its second sample — which is exactly why it is an async command and
  // not on the render path.
  void invokeSafe<number | null>("foreground_cpu").then((c) => {
    foregroundCpu = c;
  });

  void invokeSafe<number | null>("seconds_since_scroll").then((s) => {
    secondsSinceScroll = s;
  });
}, SCROLL_POLL_MS);
setInterval(() => {
}, 5000);
requestAnimationFrame(frame);
