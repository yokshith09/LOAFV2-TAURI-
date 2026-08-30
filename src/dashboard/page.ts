import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Tracker } from "../tracker/tracker";
import { dashboardBody, DASHBOARD_STYLES, unavailableRadar } from "./html";
import type { Platform } from "./html";
import { COMMAND_EVENT, STATS_CHANGED_EVENT } from "./events";

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
  root!.innerHTML = dashboardBody(tracker, {
    // The radar is not ported yet, and saying "off — turn it on" would put a
    // button here that does nothing.
    radar: unavailableRadar(),
    platform,
  });
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

  const cmd = target.closest<HTMLElement>("[data-loaf-cmd]");
  if (cmd) void emit(COMMAND_EVENT, cmd.dataset.loafCmd);
});

// The companion applies the command and saves, then says so. Re-reading rather
// than patching what is on screen keeps this window's picture identical to what
// is actually on disk.
void listen(STATS_CHANGED_EVENT, () => void render());

void detectPlatform()
  .then((p) => {
    platform = p;
  })
  .then(render);
