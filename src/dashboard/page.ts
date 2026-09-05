import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Tracker } from "../tracker/tracker";
import {
  dashboardBody,
  DASHBOARD_STYLES,
  unavailableRadar,
  isDashboardView,
} from "./html";
import type { RadarSnapshot } from "./html";
import type { Platform } from "./html";
import type { DashboardView } from "./html";
import {
  CLOSET_CHANGED_EVENT,
  CLOSET_PICK_EVENT,
  CLOSET_HELLO_EVENT,
  isClosetState,
  type ClosetPick,
} from "../closet/events";
import type { ClosetState } from "../closet/settings";
import type { EngineId } from "../voice/engine";
import type { ListenMode } from "../voice/mode";
import { spokenPhrases } from "../voice/phrases";
import {
  COMMAND_EVENT,
  TASK_COMMAND_EVENT,
  TASKS_CHANGED_EVENT,
  SPOKEN_EVENT,
  SPOKEN_REPLY_EVENT,
  STATS_CHANGED_EVENT,
  RADAR_STATE_EVENT,
  RADAR_HELLO_EVENT,
  MEETINGS_STATE_EVENT,
  MEETINGS_HELLO_EVENT,
  MEETING_FORGET_EVENT,
  isRadarSnapshot,
  isMeetingsSnapshot,
  type MeetingsSnapshot,
} from "./events";

/**
 * The dashboard window's entry point.
 *
 * This window does NOT own the tracker. It reads the same file, renders it, and
 * sends any button press to the companion window, which is the single owner of
 * the in-memory state. Two windows both mutating one JSON file is a lost-update
 * bug waiting for the user to press "Reset today" while the tracker is mid-tick;
 * having one owner and one writer removes the race rather than narrowing it.
 */

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const style = document.createElement("style");
style.textContent = DASHBOARD_STYLES;
document.head.appendChild(style);

async function detectPlatform(): Promise<Platform> {
  const name = await invoke<string>("platform_name").catch(() => "");
  if (name === "macos") return "macos";
  if (name === "windows") return "windows";
  return "other";
}

let platform: Platform = "other";

/**
 * The running build, asked for once.
 *
 * Empty until the binary answers, and the footer simply omits the line until
 * then — a version that appears a beat late is invisible; a wrong one ends up
 * in a bug report.
 */
let version = "";

/**
 * The task list, as the companion last broadcast it.
 *
 * Held rather than read: this window renders what it is told, and the
 * notetaker's storage belongs to the companion like everything else with state.
 */
let tasks: Array<{ title: string; priority: string; minutesLeft: number | null }> = [];

/**
 * What the companion last said about the radar.
 *
 * Unavailable until it answers, which is also the truthful state if it never
 * does: this window cannot read a tab and must not imply otherwise.
 */
let radar: RadarSnapshot = unavailableRadar();

/**
 * Which section is open.
 *
 * Held here rather than in the markup because `render` replaces the entire
 * body on every stats tick; without this, the page would snap back to Today
 * under the reader's cursor several times a minute.
 */
let activeView: DashboardView = "today";

/**
 * Everything the companion owns that is not screen time, or undefined until
 * it says anything. Undefined renders no controls rather than a guess — see
 * the note on `DashboardOptions.settings`.
 */
let settings: ClosetState | undefined;

/**
 * What is recording, as the companion last said.
 *
 * Undefined until it answers, and rendered as "asking…" rather than "nothing
 * recorded" — this window must never state that a microphone is off on the
 * strength of not having heard yet.
 */
let meetings: MeetingsSnapshot | undefined;

/** Whether a microphone button is worth showing at all. See the note below. */
let micUsable = false;

async function render(): Promise<void> {
  let json: string | null;
  try {
    json = await invoke<string | null>("read_stats");
  } catch (err) {
    // Say so rather than rendering an empty dashboard. "Nothing tracked yet" and
    // "we could not open your history" look identical on screen and mean very
    // different things.
    console.error("could not read screen time", err);
    root!.innerHTML =
      `<div class="wrap"><h1>🐾 Loaf</h1>` +
      `<p class="empty">Couldn't read your history file just now. ` +
      `Nothing has been changed or lost — try reopening this window.</p></div>`;
    return;
  }

  const tracker = new Tracker({ json });
  try {
    root!.innerHTML = dashboardBody(tracker, {
      radar,
      platform,
      version,
      tasks: tasks as never,
      tabs: browserTabs,
      tabsRead,
      view: activeView,
      settings,
      meetings,
    });
    // The button is recreated on every render, so the decision to show it has
    // to be made again — otherwise it appears once and vanishes at the next
    // stats tick.
    if (micUsable) document.getElementById("ask-mic")?.removeAttribute("hidden");
  } catch (err) {
    throw err;
  }
}

/**
 * One delegated listener for the whole page.
 *
 * The markup carries `data-loaf-cmd` and `data-loaf-tab` instead of inline
 * handlers — see the note in `html.ts`. This is the other half of that.
 */
root.addEventListener("click", (ev) => {
  const target = ev.target;
  if (!(target instanceof Element)) return;

  const viewTab = target.closest<HTMLElement>("[data-loaf-view]");
  if (viewTab) {
    const which = viewTab.dataset.loafView!;
    if (isDashboardView(which)) {
      // Remembered before the panels are switched, so the next stats tick —
      // which rebuilds this whole page — reopens where the reader was rather
      // than dropping them back on Today every few seconds.
      activeView = which;
      for (const b of root.querySelectorAll<HTMLElement>(".view-tab[data-loaf-view]")) {
        const on = b === viewTab;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      }
      for (const panel of root.querySelectorAll<HTMLElement>(".view")) {
        panel.hidden = panel.id !== `view-${which}`;
      }
    }
    return;
  }

  const tab = target.closest<HTMLElement>("[data-loaf-tab]");
  if (tab) {
    const which = tab.dataset.loafTab!;
    for (const b of root.querySelectorAll(".tab[data-loaf-tab]")) {
      b.classList.toggle("active", b === tab);
    }
    for (const panel of root.querySelectorAll<HTMLElement>(".strip-panel")) {
      panel.style.display = panel.id === which ? "flex" : "none";
    }
    return;
  }

  if (target.closest("[data-whisper-download]")) {
    sendPick({ kind: "engine.download" });
    return;
  }

  const ask = target.closest<HTMLElement>("[data-loaf-ask]");
  if (ask) {
    if (ask.dataset.loafAsk === "mic") void listenOnce();
    else sendAsk();
    return;
  }

  const tabClose = target.closest<HTMLElement>("[data-loaf-tabclose]");
  if (tabClose) {
    const index = Number(tabClose.dataset.loafTabclose);
    const title = browserTabs[index];
    if (title !== undefined) void closeBrowserTab(title, tabClose);
    return;
  }

  if (target.closest("[data-loaf-note]")) {
    sendNote();
    return;
  }

  const forget = target.closest<HTMLElement>("[data-loaf-forget]");
  if (forget) {
    void emit(MEETING_FORGET_EVENT, forget.dataset.loafForget);
    return;
  }

  const task = target.closest<HTMLElement>("[data-loaf-task]");
  if (task) {
    sendTask(task.dataset.loafTask!);
    return;
  }

  const cmd = target.closest<HTMLElement>("[data-loaf-cmd]");
  if (cmd) void emit(COMMAND_EVENT, cmd.dataset.loafCmd);
});

// The companion applies the command and saves, then says so. Re-reading rather
// than patching what is on screen keeps this window's picture identical to what
// is actually on disk.
void listen(STATS_CHANGED_EVENT, () => void render());
void listen(RADAR_STATE_EVENT, (e) => {
  // Rendered straight from the payload: the radar has never been on disk, so
  // there is nothing here to re-read even if this wanted to. Checked first —
  // this decides whether the page tells the user their domains are being read.
  if (!isRadarSnapshot(e.payload)) return;
  radar = e.payload;
  void render();
});

void detectPlatform()
  .then((p) => {
    platform = p;
  })
  // Asked for alongside the platform so both land before the first paint, and
  // the footer does not visibly gain a line a moment after opening.
  .then(() => invoke<string>("app_version").catch(() => ""))
  .then((v) => {
    version = v;
  })
  .then(render)
  .then(() => emit(RADAR_HELLO_EVENT))
  // The settings live here now, so this window has to ask who is on duty the
  // same way the closet always has — otherwise the Voice section sits empty
  // until something unrelated happens to change and trigger a broadcast.
  .then(() => emit(CLOSET_HELLO_EVENT))
  .then(() => emit(MEETINGS_HELLO_EVENT))
  .then(() => refreshTabs())
  .catch(() => {
    // No companion listening; the unavailable state above stands.
  });

/**
 * Turn a click on the task panel into a command for the companion.
 *
 * The row buttons carry an INDEX rather than an id, because the dashboard
 * renders from a broadcast list and has no business knowing about ids it did
 * not invent. The companion resolves the index against the same ordered list it
 * sent, which keeps this window a view of state rather than a second owner of
 * it.
 */
function sendTask(action: string): void {
  if (action === "add") {
    const titleEl = document.getElementById("tp-title") as HTMLInputElement | null;
    const priorityEl = document.getElementById("tp-priority") as HTMLSelectElement | null;
    const minutesEl = document.getElementById("tp-minutes") as HTMLInputElement | null;
    const title = titleEl?.value ?? "";
    // An empty box is not a mistake worth reporting — the user pressed Add
    // before typing, and the honest response is to do nothing visible.
    if (title.trim().length === 0) {
      titleEl?.focus();
      return;
    }
    void emit(TASK_COMMAND_EVENT, {
      kind: "task",
      action: "add",
      title,
      priority: priorityEl?.value ?? "soon",
      minutes: Number(minutesEl?.value ?? 0) || 0,
    });
    if (titleEl) titleEl.value = "";
    if (minutesEl) minutesEl.value = "";
    titleEl?.focus();
    return;
  }

  const [what, index] = action.split(":", 2);
  if ((what === "done" || what === "remove") && index !== undefined) {
    void emit(TASK_COMMAND_EVENT, { kind: "task", action: what, id: index });
  }
}

/**
 * Add whatever is in the notes composer.
 *
 * Separate from `sendTask` with its own element ids on purpose. Every panel is
 * rendered at once and all but one hidden, so the checklist composer on Today
 * and the note composer here are BOTH in the document at the same time — one
 * set of ids shared between them would mean `getElementById` returning
 * whichever came first in the markup, and one of the two boxes silently doing
 * nothing. The payload is identical; only the ids differ.
 */
function sendNote(): void {
  const titleEl = document.getElementById("nt-title") as HTMLTextAreaElement | null;
  const priorityEl = document.getElementById("nt-priority") as HTMLSelectElement | null;
  const minutesEl = document.getElementById("nt-minutes") as HTMLInputElement | null;
  const title = titleEl?.value ?? "";
  if (title.trim().length === 0) {
    titleEl?.focus();
    return;
  }
  void emit(TASK_COMMAND_EVENT, {
    kind: "task",
    action: "add",
    title,
    priority: priorityEl?.value ?? "soon",
    minutes: Number(minutesEl?.value ?? 0) || 0,
  });
  if (titleEl) titleEl.value = "";
  if (minutesEl) minutesEl.value = "";
  titleEl?.focus();
}

// Enter in the title box adds the task. Typing a sentence and reaching for the
// mouse to commit it is the friction this feature exists to remove.
//
// The notes composer takes Ctrl+Enter rather than Enter: it is a textarea, and
// a multi-line box where Enter submits is a box you cannot write a second
// paragraph in.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  const el = ev.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.id === "tp-title") {
    ev.preventDefault();
    sendTask("add");
    return;
  }
  if (el.id === "nt-title" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    sendNote();
  }
});

// The companion owns the list; this window redraws when it says so.
void listen(TASKS_CHANGED_EVENT, (e) => {
  if (Array.isArray(e.payload)) {
    tasks = e.payload as typeof tasks;
  }
  void render();
}).catch(() => {
  // The next render will be right regardless.
});

/**
 * Hand a sentence to the companion.
 *
 * This window does not parse it. Deciding what a sentence means and then asking
 * for that action would be a second place that knows what commands exist, and
 * the two would drift.
 */
function sendAsk(): void {
  const box = document.getElementById("ask-box") as HTMLInputElement | null;
  const text = box?.value ?? "";
  if (text.trim().length === 0) {
    box?.focus();
    return;
  }
  void emit(SPOKEN_EVENT, text);
  if (box) box.value = "";
  box?.focus();
}

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  const el = ev.target;
  if (el instanceof HTMLElement && el.id === "ask-box") {
    ev.preventDefault();
    sendAsk();
  }
});

// What it understood, shown where the examples were. The character says it too;
// this is for when the dashboard is what you are looking at.
// The closet's own broadcast already carries the engine, the microphone and
// the listening mode, and the companion is the single owner of all three. This
// window listens to the same announcement rather than asking separately, so
// the Voice section and the closet cannot disagree about what is switched on.
void listen(CLOSET_CHANGED_EVENT, (e) => {
  if (!isClosetState(e.payload)) return;
  // A re-render loses focus and the caret, so it is skipped while the wake-word
  // field is being typed in — the same rule the closet follows for the name
  // field, and for the same reason.
  settings = e.payload as unknown as ClosetState;
  if (document.activeElement?.hasAttribute("data-wake-word")) return;
  void render();
}).catch(() => {
  // No companion, no settings. Rendering nothing is the honest fallback.
});

// The settings moved into this window, but nothing about who owns them did:
// these are the SAME picks the closet has always emitted, and the companion is
// still the only thing that acts on them. A second owner would be a second
// answer to "is the microphone on".
function sendPick(pick: ClosetPick): void {
  void emit(CLOSET_PICK_EVENT, pick).catch((err) => {
    console.error("the dashboard could not reach the companion", err);
  });
}

root.addEventListener("change", (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLElement)) return;

  if (el instanceof HTMLInputElement && el.dataset.habit !== undefined) {
    sendPick({ kind: "habit", habit: el.dataset.habit, on: el.checked });
    return;
  }
  if (el instanceof HTMLInputElement && el.dataset.sound !== undefined) {
    // Checked means "make a noise", so the stored value is the opposite.
    sendPick({ kind: "muted", on: !el.checked });
    return;
  }
  if (el instanceof HTMLInputElement && el.hasAttribute("data-listen-on")) {
    // Switching ON means the wake word, because that is what the switch says
    // it means.
    //
    // THIS LANDED ON PUSH-TO-TALK AND IT WAS WRONG. The reasoning was that a
    // checkbox should not open a permanent microphone — defensible in the
    // abstract, and in practice it meant someone who switched on "listen for
    // me", read the label, and said the wake word got nothing at all, because
    // no wake session was running. Worse, push mode opens the microphone on
    // hover, so moving the character started a recording: the exact "I move it
    // and the microphone wakes up" behaviour that took three rounds to explain.
    //
    // A control that quietly does something other than what it says is not
    // safer than one that does what it says. The disclosure lives next to it —
    // the mode description, the badge, and the spoken confirmation all state
    // that the microphone is open — and the picker beside it is how someone
    // chooses the narrower modes instead.
    sendPick({ kind: "listenMode", mode: el.checked ? "always" : "off" });
    return;
  }
  if (el instanceof HTMLSelectElement && el.hasAttribute("data-retention")) {
    sendPick({ kind: "retention", days: Number(el.value) });
    return;
  }
  if (el instanceof HTMLSelectElement && el.hasAttribute("data-listen-mode")) {
    // Sent as-is; the companion validates it before opening anything, because
    // this is the one pick that decides whether a microphone is used.
    sendPick({ kind: "listenMode", mode: el.value as ListenMode });
    return;
  }
  if (el instanceof HTMLSelectElement && el.hasAttribute("data-engine")) {
    sendPick({ kind: "engine", id: el.value as EngineId });
    return;
  }
  if (el instanceof HTMLSelectElement && el.hasAttribute("data-hold")) {
    sendPick({ kind: "hoverListenMs", ms: Number(el.value) });
    return;
  }
  if (el instanceof HTMLSelectElement && el.hasAttribute("data-voice")) {
    // Empty means "let Loaf choose", which is not the same as a voice named "".
    sendPick({ kind: "voice", name: el.value === "" ? null : el.value });
    return;
  }
  if (el instanceof HTMLInputElement && el.hasAttribute("data-wake-word")) {
    // On change rather than per keystroke: each send restarts the speech
    // session to recompile the grammar, and doing that per letter would be a
    // microphone opening and closing while you type.
    const typed = el.value.trim();
    sendPick({ kind: "wakeWord", word: typed.length === 0 ? null : typed });
  }
});

void listen(MEETINGS_STATE_EVENT, (e) => {
  // Checked rather than trusted: this decides whether the page tells someone
  // their microphone is on.
  if (!isMeetingsSnapshot(e.payload)) return;
  meetings = e.payload;
  void render();
}).catch(() => {
  // No companion, so the panel keeps saying it is still asking.
});

void listen(SPOKEN_REPLY_EVENT, (e) => {
  const hint = document.getElementById("ask-reply");
  if (hint && typeof e.payload === "string") hint.textContent = e.payload;
}).catch(() => {
  // The character still answers.
});

/**
 * What the recogniser heard, as a discriminated union from Rust.
 *
 * Mirrored rather than shared because it crosses a language boundary; the
 * `kind` tag is what `speech.rs` serialises.
 */
type Heard =
  | { kind: "text"; text: string; confidence: string }
  | { kind: "nothing" }
  | { kind: "unavailable"; why: string };

let listening = false;

/**
 * Listen once, then hand the words to the same place typing does.
 *
 * The button is the push in push-to-talk: there is no wake word and nothing
 * listens until this runs. It is disabled while a recognition is in flight,
 * because two overlapping recognisers is a way to get one sentence acted on
 * twice.
 */
/** The browser tabs, as last read. Titles only. */
let browserTabs: string[] = [];
/** False when Loaf could not read them, which is a different answer to none. */
let tabsRead = false;

async function refreshTabs(): Promise<void> {
  try {
    const tabs = await invoke<string[]>("list_tabs");
    browserTabs = tabs;
    tabsRead = true;
  } catch {
    tabsRead = false;
  }
  void render();
}

/**
 * Close one tab, by the title Loaf read.
 *
 * The list is re-read afterwards rather than patched: the browser is the owner
 * of what is open, and guessing that our row disappeared would show a list that
 * disagrees with the tab strip the moment anything else changes it.
 */
async function closeBrowserTab(title: string, button: HTMLElement): Promise<void> {
  button.setAttribute("disabled", "true");
  try {
    const closed = await invoke<boolean>("close_tab", { title });
    if (!closed) {
      const hint = document.getElementById("ask-reply");
      if (hint) hint.textContent = "That tab is not open any more.";
    }
  } catch (e) {
    const hint = document.getElementById("ask-reply");
    if (hint) hint.textContent = String(e);
  }
  await refreshTabs();
}

async function listenOnce(): Promise<void> {
  if (listening) return;
  const mic = document.getElementById("ask-mic");
  const hint = document.getElementById("ask-reply");
  listening = true;
  mic?.classList.add("listening");
  if (hint) hint.textContent = "Listening…";

  try {
    // The vocabulary goes WITH the request. Windows recognises free
    // speech only through its online recogniser, so the phrase list is
    // what keeps this on the machine — see voice/phrases.ts.
    const heard = await invoke<Heard>("listen_once", { phrases: spokenPhrases(programNames) });
    if (heard.kind === "text") {
      // Straight to the companion, exactly as a typed sentence would go. The
      // parser does not know or care which way the words arrived.
      if (hint) hint.textContent = `Heard: “${heard.text}”`;
      void emit(SPOKEN_EVENT, heard.text);
    } else if (heard.kind === "nothing") {
      if (hint) hint.textContent = "I didn't catch that.";
    } else if (hint) {
      hint.textContent = heard.why;
    }
  } catch (e) {
    // The reason, not a shrug. "Speech isn't available here" for every failure
    // is what made a missing model, a busy microphone and a refused permission
    // all look like the same dead button.
    if (hint) hint.textContent = String(e);
  } finally {
    listening = false;
    mic?.classList.remove("listening");
  }
}

/**
 * The names of the programs on this machine, for the spoken vocabulary.
 *
 * Read once. A closed grammar cannot contain "Notepad" unless something told
 * it the word, so this is what makes "open Notepad" work without falling back
 * to Windows' online dictation. Empty until it arrives, and an empty list
 * simply means program names are not heard yet.
 */
let programNames: readonly string[] = [];

void invoke<{ name: string }[]>("list_apps")
  .then((apps) => {
    programNames = apps.map((a) => a.name);
  })
  .catch(() => {
    // Voice still works for everything that is not a program name.
  });

// The microphone button only exists where a microphone can actually be used.
// Offering one that always fails is worse than not offering one.
//
// EITHER recogniser counts. This asked only about Windows speech, so a machine
// with Whisper installed and no Windows speech pack got no microphone button
// at all — while the mode picker cheerfully offered "when I press the
// microphone button", naming a button that was not on the screen.
void invoke<boolean>("speech_available")
  .then((ok) => {
    // Windows speech is what the button uses, so it is what decides whether
    // the button exists. Whisper no longer takes dictation — see
    // PICKABLE_ENGINES.
    micUsable = ok;
    if (micUsable) {
      document.getElementById("ask-mic")?.removeAttribute("hidden");
    }
  })
  .catch(() => {
    // Stays hidden, which is the right answer.
  });
