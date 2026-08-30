import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { FOCUS_CSS, focusBody } from "./markup";
import { frameFor, type FocusSnapshot } from "./view";
import {
  FOCUS_COMMAND_EVENT,
  FOCUS_STATE_EVENT,
  FOCUS_HELLO_EVENT,
  isFocusSnapshot,
  parseCommand,
} from "./events";

/**
 * The focus window.
 *
 * Holds no timer of its own — the companion owns it, because that timer already
 * persists across a quit and already drives the ring drawn at the character's
 * feet. A second copy here would be a second answer to "how long is left".
 *
 * What it holds is the *snapshot*: a state, a duration, and an absolute
 * deadline. From those it derives the clock locally, once a second, so the
 * companion only has to speak when something actually changes. The reference
 * pushes a JSON frame four times a second through `evaluateJavaScript`; this
 * needs none of that, because the timer was already counting to a wall clock.
 */

const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = FOCUS_CSS;
document.head.appendChild(style);

/** Until the companion answers, an idle timer at the default length. */
let snapshot: FocusSnapshot = {
  state: "idle",
  duration: 30 * 60,
  endsAt: null,
  pausedRemaining: null,
};

let built = false;

/**
 * Update in place rather than rebuilding.
 *
 * Assignments only — no layout, nothing that could move a button out from under
 * the cursor mid-click. The full rebuild happens once, on the first frame.
 */
function apply(): void {
  const frame = frameFor(snapshot, Date.now());

  if (!built) {
    root.innerHTML = focusBody(frame);
    wire();
    built = true;
    void fit();
  }

  document.body.dataset.state = frame.state;
  const clock = document.getElementById("clock")!;
  clock.textContent = frame.clock;
  // Once an hour is on the clock the string is two characters longer than the
  // dial can hold at full size.
  clock.classList.toggle("long", frame.long);
  document.getElementById("sub")!.textContent = frame.words.sub;
  document.getElementById("pill")!.textContent = frame.words.pill;
  document.getElementById("title")!.textContent = frame.words.title;
  document.getElementById("note")!.textContent = frame.words.note;
  document.getElementById("act")!.textContent = frame.words.action;
  document.getElementById("arc")!.setAttribute("stroke-dashoffset", String(frame.dash));

  for (const chip of root.querySelectorAll<HTMLElement>(".preset[data-min]")) {
    chip.classList.toggle("on", Number(chip.dataset.min) === frame.minutes);
  }
}

function wire(): void {
  root.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const el = target.closest<HTMLElement>("[data-focus-cmd]");
    if (!el) return;
    const command = parseCommand(el.dataset.focusCmd!);
    if (command) void emit(FOCUS_COMMAND_EVENT, command);
  });
}

async function fit(): Promise<void> {
  const wrap = root.querySelector("#wrap");
  if (!wrap) return;
  await invoke("fit_focus", {
    height: Math.ceil(wrap.getBoundingClientRect().height) + 8,
  }).catch(() => {
    // Not running in the app.
  });
}

void listen(FOCUS_STATE_EVENT, (e) => {
  if (!isFocusSnapshot(e.payload)) return;
  snapshot = e.payload;
  apply();
});

apply();
void emit(FOCUS_HELLO_EVENT).catch(() => {
  // No companion listening; the placeholder above stands.
});

// Once a second is enough for a clock that shows minutes and seconds. The
// reference redraws four times a second because it is being pushed frames it
// does not control; here the page decides, and a second is the resolution the
// display actually has.
setInterval(() => {
  if (snapshot.state === "running") apply();
}, 1000);
