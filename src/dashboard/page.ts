import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Tracker } from "../tracker/tracker";
import { dashboardBody, DASHBOARD_STYLES, unavailableRadar } from "./html";
import type { RadarSnapshot } from "./html";
import type { Platform } from "./html";
import {
  COMMAND_EVENT,
  TASK_COMMAND_EVENT,
  TASKS_CHANGED_EVENT,
  SPOKEN_EVENT,
  SPOKEN_REPLY_EVENT,
  STATS_CHANGED_EVENT,
  RADAR_STATE_EVENT,
  RADAR_HELLO_EVENT,
  isRadarSnapshot,
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
    });
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

  if (target.closest("[data-loaf-ask]")) {
    sendAsk();
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

// Enter in the title box adds the task. Typing a sentence and reaching for the
// mouse to commit it is the friction this feature exists to remove.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  const el = ev.target;
  if (el instanceof HTMLElement && el.id === "tp-title") {
    ev.preventDefault();
    sendTask("add");
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
void listen(SPOKEN_REPLY_EVENT, (e) => {
  const hint = document.getElementById("ask-reply");
  if (hint && typeof e.payload === "string") hint.textContent = e.payload;
}).catch(() => {
  // The character still answers.
});
