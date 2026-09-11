import { notesFor } from "../insights/notes";
import { Tracker, formatDuration, dayKeyFor, type HistoryEntry } from "../tracker/tracker";
import {
  BASE_CSS,
  PLUS_CSS,
  MINI_CSS,
  MEETINGS_CSS,
  NOTES_CSS,
  MEETINGS_DELETE_CSS,
  MEMORY_CSS,
} from "./css";
import {
  TANTRUM_OPTIONS,
  type MeetingsSnapshot,
  type MemorySnapshot,
  type NoteView,
} from "./events";
import { NOTE_COLOURS, type NoteColour } from "../tasks/tasks";
import {
  listenRow,
  holdRow,
  engineRow,
  voiceRow,
  habitRows,
  soundRow,
  disclosurePanel,
  whisperDownloadRow,
  SETTINGS_CSS,
} from "../settings/panels";
import type { ClosetState } from "../closet/settings";
import { RETENTION_CHOICES, KEEP_FOREVER, retentionLabel } from "../meetings/meetings";
import {
  connectionsPanel,
  CONNECTIONS_CSS,
  EMPTY_CONNECTIONS,
  type ConnectionsState,
} from "../connections/connections";
import {
  searchPanel,
  SEARCH_CSS,
  EMPTY_SEARCH,
  type SearchState,
} from "../search/search";

/**
 * Both dashboard views, as self-contained HTML. Ported from `DashboardHTML.swift`.
 *
 * Regenerated fresh from the tracker every time one is opened — there is no
 * state here, and nothing to fetch.
 *
 * THE HONESTY RULE: every number on this page was measured.
 *
 * The reference did not hold to that. Days it had never recorded were filled
 * with a seeded 1.5–4.5h bar, hatched and captioned "(sample)", and the hour
 * chart fell back to an invented knowledge-worker curve until two real hours
 * had accumulated — so a fresh install opened onto a full-looking dashboard of
 * fiction. Both are gone. Charts start at the first day actually recorded,
 * unrecorded days inside that range are drawn empty, and no peak hour is named
 * until there is enough measured time to name one.
 *
 * The same rule already governed the site breakdown and still does: browser
 * time the radar could not attribute gets its own labelled row and is never
 * quietly distributed across the domains it did see. A guessed split reads as
 * data, and this is the one product that must not do that.
 *
 * TWO FURTHER DEPARTURES, both forced by the move off WebKit-on-macOS:
 *
 *  1. No inline event handlers. The reference wires buttons with
 *     `onclick="loaf('reset')"` calling `window.webkit.messageHandlers`, which
 *     does not exist here and which this app's CSP (`script-src 'self'`) would
 *     refuse to run anyway. Buttons carry `data-loaf-cmd` instead and the host
 *     page attaches one delegated listener. The generated document contains no
 *     script at all.
 *  2. Escaping covers quotes as well as angle brackets. The reference escapes
 *     `& < >` only; app names come from the OS and end up in attributes here.
 */

export type PermissionState = "granted" | "denied" | "unsupported" | "unknown";

export interface BrowserStatus {
  readonly name: string;
  readonly permission: PermissionState;
  readonly note?: string;
  /** Tabs open right now, or null if nothing has counted this browser yet. */
  readonly tabCount?: number | null;
}

/**
 * What the dashboard needs to know about the privacy radar.
 *
 * An interface rather than the radar itself, because the radar is not ported
 * yet and this does not need it to be — when it lands, it produces one of
 * these. `disabledRadar()` is the honest state until then.
 */
export interface RadarSnapshot {
  /**
   * Whether this build has a radar at all.
   *
   * Distinct from `enabled`: "off, turn it on" and "not written yet" are
   * different sentences, and rendering the first while meaning the second gives
   * the user a button that does nothing.
   */
  readonly available: boolean;
  /**
   * Whether the URL is truncated inside the browser (macOS) or read out of the
   * address bar and cut down here (Windows).
   *
   * Shown to the user, not just recorded: the two are a different promise, and
   * the weaker one has to be the one that says so.
   */
  readonly readsInsideBrowser: boolean;
  readonly enabled: boolean;
  /** Tabs open before the tantrum. 0 = tantrums off. */
  readonly tabThreshold: number;
  /** Tabs open right now, or null if nothing has counted them. */
  readonly tabsOpenNow: number | null;
  readonly statusRows: readonly BrowserStatus[];
}

/** The radar switched off in a build that has one. */
export function disabledRadar(): RadarSnapshot {
  return {
    available: true,
    readsInsideBrowser: true,
    enabled: false,
    tabThreshold: 0,
    tabsOpenNow: null,
    statusRows: [],
  };
}

/** The honest state until `PrivacyRadar.swift` is ported. */
export function unavailableRadar(): RadarSnapshot {
  return { ...disabledRadar(), available: false };
}

export type Platform = "macos" | "windows" | "other";

export interface DashboardOptions {
  readonly radar?: RadarSnapshot;
  readonly platform?: Platform;
  /**
   * Overrides the date shown in the header. Defaults to the tracker's own
   * clock, so the caption and the chart under it can never disagree.
   */
  readonly now?: Date;
  /**
   * The running build, e.g. "0.2.0".
   *
   * Optional, and omitted rather than guessed: this window renders in tests and
   * in the hover card, neither of which has a binary to ask. A dashboard that
   * printed "unknown" would put a wrong-looking version in a screenshot, which
   * is the one thing a version line exists to prevent.
   */
  readonly version?: string;
  /**
   * What you said you meant to do, highest priority first.
   *
   * Passed in rather than read here: this module renders and never owns state,
   * and the list belongs to the companion window like everything else.
   */
  readonly tasks?: readonly TaskView[];
  /**
   * Every note, in full, for the Notes wall — see `NOTES_CHANGED_EVENT`.
   *
   * A separate list from `tasks` above, which stays capped at three for the
   * pet's checklist. This one is the whole wall: every note, with the fields a
   * card needs to draw itself.
   */
  readonly notes?: readonly NoteView[];
  /**
   * The label the Notes wall is filtered to, or null for everything.
   *
   * View-only state, held by the dashboard window rather than the companion:
   * filtering which of your own already-downloaded notes are ON SCREEN is not
   * a fact about the notes, and sending it to the companion and back would
   * mean a label click waiting on a round trip to take effect.
   */
  readonly notesFilter?: string | null;
  /**
   * The id of the note currently expanded into its editor, or null when every
   * card is showing its closed, read-only face.
   *
   * View-only for the same reason as `notesFilter`: which card happens to be
   * open is a fact about this window, not about the note.
   */
  readonly notesEditing?: string | null;
  /**
   * Which section is open. Passed in rather than held here because the whole
   * body is re-rendered on every stats tick, and a view that reset itself to
   * "Today" every few seconds would be unusable.
   */
  readonly view?: DashboardView;
  /**
   * Everything the companion owns that is not screen time, or undefined
   * before it has said anything.
   *
   * Undefined renders no controls at all rather than a guess: a dashboard that
   * claims a microphone it has not confirmed, or shows "off" selected while
   * something is listening, is the exact failure the Voice section exists to
   * end.
   */
  readonly settings?: ClosetState;
  /**
   * What is recording and what already was, or undefined before the companion
   * has said. Undefined shows a waiting line rather than "nothing recorded",
   * which would be a claim this window has not earned yet.
   */
  readonly meetings?: MeetingsSnapshot;
  /**
   * What Loaf remembers, or undefined before the companion has said.
   *
   * Undefined renders nothing rather than "you have no memories", which would
   * be a claim this window has not earned.
   */
  readonly memory?: MemorySnapshot;
  /** Browser tab titles, for the panel that lets you close them. */
  readonly tabs?: readonly string[];
  /** False when Loaf could not read them — different from none open. */
  readonly tabsRead?: boolean;
  /** Tabs open right now, for the tab note. Null when the browser will not say. */
  readonly tabsNow?: number | null;
  /** The most tabs seen on each past day, oldest first. */
  readonly pastPeakTabs?: readonly number[];
  /**
   * The MCP servers the user has attached, or undefined before Rust has said.
   *
   * Undefined renders the tab as if nothing is connected, which is the truth
   * on a machine that has never opened it — unlike `meetings`, there is no
   * state here the window could be wrong about, because "no servers" and "not
   * asked yet" produce the same page and the same available actions.
   */
  readonly connections?: ConnectionsState;
  /**
   * The search box, its results, and the delete and export controls.
   *
   * Undefined renders an empty box inviting a search, which is exactly what a
   * machine that has not searched yet should see — unlike `meetings`, there is
   * nothing here the window could be wrong about.
   */
  readonly search?: SearchState;
}

/** Just enough of a task to draw one. */
export interface TaskView {
  readonly title: string;
  readonly priority: "now" | "soon" | "whenever";
  /** Minutes until its timer, rounded, or null when it has none. */
  readonly minutesLeft: number | null;
}

// --- Escaping ----------------------------------------------------------------

/**
 * Escape for both text content and attribute values.
 *
 * Quotes are included, unlike the reference. App names and domains arrive from
 * the operating system and from web pages — neither is ours — and they are
 * interpolated into `title="..."` here. Escaping only `& < >` leaves an
 * attribute a well-chosen window title can climb out of.
 */
export function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- History bars ------------------------------------------------------------

/**
 * Below this much recorded time, the chart is drawn but no peak is claimed.
 *
 * Not a threshold for inventing anything — the bars are always measured. It
 * gates only the sentence that says when you are sharpest, because calling that
 * off twenty minutes is a guess dressed as a finding.
 */
const CONFIDENT_AFTER = 2 * 3600;

interface DayBar {
  readonly label: string;
  readonly seconds: number;
  readonly isToday: boolean;
  /** Loaf was installed by this day but recorded nothing. Drawn empty. */
  readonly noData: boolean;
}

/**
 * Turn a history window into bars, dropping everything from before Loaf was
 * first recording.
 *
 * THE REFERENCE FILLED THOSE DAYS WITH INVENTED NUMBERS — a seeded 1.5–4.5h per
 * missing day, hatched and captioned "(sample)" — so a fresh install had a
 * full-looking chart. That is gone. A chart that shows made-up bars is asking
 * to be read as data, and the caption doing the disclaiming is smaller than the
 * bars doing the lying. Days before the first record are not shown at all;
 * days after it with nothing recorded are shown as empty slots, which is the
 * true statement.
 */
function dayBars(
  days: readonly HistoryEntry[],
  firstRecorded: string | null,
): DayBar[] {
  return days
    .filter((d) => firstRecorded !== null && dayKeyFor(d.date) >= firstRecorded)
    .map((d) => ({
      label: d.label,
      seconds: d.hasData ? d.total : 0,
      isToday: d.isToday,
      noData: !d.hasData,
    }));
}

function stripHTML(bars: readonly DayBar[], thin: boolean): string {
  if (bars.length === 0) {
    return `<p class="empty">No days recorded yet — this chart fills in as Loaf runs.</p>`;
  }
  const maxV = Math.max(...bars.map((b) => b.seconds), 1);
  return bars
    .map((bar, i) => {
      // An empty day gets the minimum stub too: a slot with nothing in it at all
      // is indistinguishable from the chart having fewer days than it does.
      const h = Math.max(3, Math.floor((bar.seconds / maxV) * 64));
      let cls = "wbar";
      if (bar.noData) cls += " nodata";
      if (bar.isToday) cls += " today";
      const showLabel = !thin || bar.isToday || i % 5 === 0;
      const widthClass = thin ? "wday thin" : "wday";
      const title = bar.noData
        ? `${bar.label}: nothing recorded`
        : `${bar.label}: ${formatDuration(bar.seconds)}`;
      return (
        `<div class="${widthClass}">` +
        `<div class="wbar-track"><div class="${cls}" style="height:${h}px" title="${escapeHTML(title)}"></div></div>` +
        `<span class="wlabel">${showLabel ? escapeHTML(bar.label) : ""}</span>` +
        `</div>`
      );
    })
    .join("");
}

/** "10–11 AM", or "11 AM–12 PM" when the hour straddles noon or midnight. */
export function hourRangeLabel(hour: number): string {
  const parts = (h: number): [number, string] => {
    const period = h % 24 < 12 ? "AM" : "PM";
    const d = h % 12 === 0 ? 12 : h % 12;
    return [d, period];
  };
  const [sd, sp] = parts(hour);
  const [ed, ep] = parts(hour + 1);
  return sp === ep ? `${sd}–${ed} ${sp}` : `${sd} ${sp}–${ed} ${ep}`;
}

// --- Shared fragments --------------------------------------------------------

/**
 * App rows, with each browser's domains nested underneath.
 *
 * The nesting is the point: a browser keeps its real total *and* stops being a
 * black box that swallowed five hours.
 */
function appRows(
  tracker: Tracker,
  apps: ReadonlyArray<[string, number]>,
  maxVal: number,
  limit: number,
  nested: boolean,
): string {
  return apps
    .slice(0, limit)
    .map(([name, seconds]) => {
      const pct = maxVal > 0 ? (seconds / maxVal) * 100 : 0;
      let children = "";
      const domains = nested ? tracker.todaySitesByBrowser[name] : undefined;
      if (domains && Object.keys(domains).length > 0) {
        const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]);
        const shown = sorted.slice(0, 4);
        children = shown
          .map(([domain, domainSeconds]) => {
            const share = seconds > 0 ? (domainSeconds / seconds) * 100 : 0;
            return (
              `<div class="subrow">` +
              `<div class="row-top"><span class="site-name">${escapeHTML(domain)}</span>` +
              `<span class="time">${formatDuration(domainSeconds)}</span></div>` +
              `<div class="bar-track thin"><div class="bar-fill site" style="width:${Math.min(share, 100)}%"></div></div>` +
              `</div>`
            );
          })
          .join("");
        if (sorted.length > shown.length) {
          children += `<div class="subrow more">+ ${sorted.length - shown.length} more sites</div>`;
        }
      }
      return (
        `<div class="row">` +
        `<div class="row-top"><span class="app">${escapeHTML(name)}</span>` +
        `<span class="time">${formatDuration(seconds)}</span></div>` +
        `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>` +
        `${children}</div>`
      );
    })
    .join("");
}

function sortedApps(tracker: Tracker): Array<[string, number]> {
  return Object.entries(tracker.today).sort((a, b) => b[1] - a[1]);
}

/**
 * Something that exists in the code but is not ready to be pointed at.
 *
 * Deliberately NOT a disabled button. A greyed-out control invites a click that
 * does nothing, which reads as broken; the folders these would open are also
 * empty until someone puts a file in them, so opening one shows a bare window
 * and no explanation. This says what the feature will be and that it is not
 * here yet, which is the honest version of both.
 */
function soonCard(title: string, blurb: string): string {
  return (
    `<div class="soon"><span class="soon-top">${escapeHTML(title)}` +
    `<span class="soon-tag">Soon</span></span>` +
    `<span class="soon-blurb">${escapeHTML(blurb)}</span></div>`
  );
}

/**
 * What Loaf has noticed, above the fold.
 *
 * Two notes at most. The whole value of an observation is that it was worth
 * making, and a list of six is a report — which is what the rest of this page
 * already is. If there is nothing worth saying, this renders nothing at all
 * rather than filling the space with an encouraging noise.
 */
function noticedBlock(tracker: Tracker, opts: DashboardOptions): string {
  const notes = notesFor({
    today: tracker.today,
    totalToday: tracker.totalToday,
    hours: tracker.hourlyHistogram(),
    history: tracker.history(30),
    tabsNow: opts.tabsNow ?? null,
    pastPeakTabs: opts.pastPeakTabs ?? [],
  }).slice(0, 2);

  if (notes.length === 0) return "";
  return `<div class="noticed">${notes
    .map((n) => `<p class="noticed-line">${escapeHTML(n.text)}</p>`)
    .join("")}</div>`;
}

/**
 * What you meant to do, on the card that appears when you look at him.
 *
 * This is the whole point of the notetaker: the list is only useful if it is in
 * front of you at the moment you have forgotten it, and the moment you look at
 * the character is the one moment Loaf knows you are looking at anything.
 *
 * Renders nothing when there is nothing outstanding — a heading over an empty
 * list is a reproach, and this feature is not for that.
 */
function taskBlock(tasks: readonly TaskView[]): string {
  if (tasks.length === 0) return "";
  const rows = tasks
    .map((t) => {
      const timer =
        t.minutesLeft === null
          ? ""
          : `<span class="task-timer">${t.minutesLeft}m</span>`;
      return (
        `<div class="task-row"><span class="task-dot p-${t.priority}"></span>` +
        `<span class="task-title">${escapeHTML(t.title)}</span>${timer}</div>`
      );
    })
    .join("");
  return `<div class="tasks">${rows}</div>`;
}

/**
 * The notetaker's front door.
 *
 * The list, priorities, timers and persistence all existed before this did, and
 * none of it could be reached &mdash; a finished feature with no way in is worth
 * exactly as much as an unfinished one.
 *
 * Plain form controls rather than anything clever: a task is a sentence, a
 * choice from three, and optionally a number of minutes. Anything more elaborate
 * would be a second task.
 */
/**
 * The tabs open in the browser, each with a way to close it.
 *
 * This is the answer to "Loaf tells me I have forty tabs and I cannot do
 * anything about it from here". It lists titles — what the browser writes on
 * the tab strip — and never URLs or page content.
 *
 * Rendered empty rather than hidden when there are none, because "no tabs" and
 * "Loaf could not read them" are different answers and the empty state says
 * which.
 */
export function tabPanel(tabs: readonly string[], read: boolean): string {
  if (!read) {
    return (
      `<h2>Browser tabs</h2>` +
      `<div class="tp"><p class="empty">Loaf could not read the browser tabs.</p></div>`
    );
  }
  // The count is the answer to the question this panel exists to solve —
  // "how many do I actually have open" — and it was previously nowhere on
  // this panel at all, only the rows themselves.
  const heading = `Browser tabs (${tabs.length})`;
  if (tabs.length === 0) {
    return `<h2>${heading}</h2><div class="tp"><p class="empty">No browser tabs open.</p></div>`;
  }
  const rows = tabs
    .map(
      (title, i) =>
        `<div class="tp-row">` +
        `<span class="tp-title">${escapeHTML(tidyTabTitle(title))}</span>` +
        `<button class="tp-x" data-loaf-tabclose="${i}" title="Close this tab">×</button>` +
        `</div>`,
    )
    .join("");
  return `<h2>${heading}</h2><div class="tp">${rows}</div>`;
}

/**
 * Chrome appends its own notes to a tab's accessible name.
 *
 * "Gmail - Memory usage - 510 MB" is one tab and a remark Chrome is making
 * about itself. Trimmed for reading; the untrimmed title is what gets sent
 * back to close it, so the two cannot drift apart.
 */
export function tidyTabTitle(raw: string): string {
  for (const marker of [" - Memory usage - ", " - High memory usage - "]) {
    const at = raw.indexOf(marker);
    if (at !== -1) return raw.slice(0, at).trim();
  }
  return raw.trim();
}

function taskPanel(tasks: readonly TaskView[]): string {
  const rows =
    tasks.length === 0
      ? `<p class="empty">Nothing on the list.</p>`
      : tasks
          .map((t, i) => {
            const timer =
              t.minutesLeft === null
                ? ""
                : `<span class="tp-timer">${t.minutesLeft}m</span>`;
            return (
              `<div class="tp-row">` +
              `<button class="tp-tick" data-loaf-task="done:${i}" title="Mark done">✓</button>` +
              `<span class="task-dot p-${escapeHTML(t.priority)}"></span>` +
              `<span class="tp-title">${escapeHTML(t.title)}</span>${timer}` +
              `<button class="tp-x" data-loaf-task="remove:${i}" title="Remove">×</button>` +
              `</div>`
            );
          })
          .join("");

  return `<div class="tp">
    ${rows}
    <div class="tp-add">
      <input id="tp-title" class="tp-input" type="text" maxlength="80"
             placeholder="Something you mean to do" aria-label="New task">
      <select id="tp-priority" class="tp-select" aria-label="Priority">
        <option value="now">Now</option>
        <option value="soon" selected>Soon</option>
        <option value="whenever">Whenever</option>
      </select>
      <input id="tp-minutes" class="tp-mins" type="number" min="0" max="600" step="5"
             placeholder="min" aria-label="Remind me in, minutes">
      <button class="tp-save" data-loaf-task="add">Add</button>
    </div>
  </div>`;
}

/** A button that asks the host to do something. See the note on inline handlers. */
function cmdButton(cls: string, cmd: string, label: string): string {
  return `<button class="${cls}" data-loaf-cmd="${escapeHTML(cmd)}">${escapeHTML(label)}</button>`;
}

// --- The radar section -------------------------------------------------------

function permissionRows(radar: RadarSnapshot, platform: Platform): string {
  if (radar.statusRows.length === 0) return "";

  const items = radar.statusRows
    .map((status) => {
      let dot: string;
      let label: string;
      switch (status.permission) {
        case "granted":
          dot = "ok";
          // THE LIVE COUNT, NOT ONLY THE DAY'S PEAK. "Most tabs open at once
          // today" further up the page is a running maximum and can be well
          // above what is open right now — and the tab tantrum reacts to the
          // live count, not the peak. Without this line there was no way to
          // tell "the radar is not reacting" apart from "the radar is
          // reacting correctly to a number lower than the one on screen".
          label =
            status.tabCount == null
              ? "reading domains"
              : `reading domains · ${status.tabCount} tab${status.tabCount === 1 ? "" : "s"} open now`;
          break;
        case "denied":
          dot = "no";
          label = "permission denied";
          break;
        case "unsupported":
          dot = "na";
          label = status.note ?? "can't be read";
          break;
        default:
          dot = "wait";
          label = status.note ?? "not asked yet";
      }
      return (
        `<div class="perm"><span class="pdot ${dot}"></span>` +
        `<span class="pname">${escapeHTML(status.name)}</span>` +
        `<span class="pstate">${escapeHTML(label)}</span></div>`
      );
    })
    .join("");

  // The route back from a refusal is per-platform, and the reference's is
  // macOS-only. Saying "System Settings › Privacy & Security › Automation" to a
  // Windows user sends them looking for a screen that does not exist.
  let fix = "";
  if (radar.statusRows.some((s) => s.permission === "denied")) {
    if (platform === "macos") {
      fix =
        `<p class="fine">To undo a "Don't Allow", tick Loaf under System Settings › ` +
        `Privacy &amp; Security › Automation. ` +
        cmdButton("linkish", "automation:settings", "Open that") +
        `</p>`;
    } else {
      fix =
        `<p class="fine">Loaf could not read the active tab from this browser. ` +
        `Close and reopen it, or check any extension or policy that blocks automation.</p>`;
    }
  }

  return `<h2 class="sub">Browsers</h2><div class="perms">${items}</div>${fix}`;
}

/**
 * One sentence on how the domain is obtained.
 *
 * Only shown where it is the weaker of the two: on macOS the truncation happens
 * inside the browser and there is nothing to disclose. Saying nothing on Windows
 * would be the kind of omission this whole feature is meant not to make.
 */
function howItReads(radar: RadarSnapshot): string {
  if (radar.readsInsideBrowser) return "";
  return (
    `<p class="fine">On Windows the domain is read from your browser's address bar ` +
    `and cut down to the host immediately. Loaf skips the read entirely while you ` +
    `are typing there, so what you type into it is never seen.</p>`
  );
}

function radarSection(
  tracker: Tracker,
  radar: RadarSnapshot,
  platform: Platform,
): string {
  if (!radar.available) {
    // No CTA: a button that cannot do anything is worse than the sentence
    // explaining why there is no button.
    const leftover = tracker.hasAnySiteData
      ? `<p class="fine">Domains an earlier version recorded are still saved on ` +
        `this computer. ` +
        cmdButton("linkish", "sites:forget", "Forget them for good") +
        `</p>`
      : "";
    return (
      `<h2>Privacy radar</h2><div class="radar-off">` +
      `<p><strong>Not in this build yet.</strong> When it lands, "Google Chrome — 5h" ` +
      `becomes the actual list of sites that took those five hours — read from the ` +
      `active tab's domain, nothing else, and kept on this computer.</p>` +
      `${leftover}</div>`
    );
  }

  if (!radar.enabled) {
    // Anything already collected stays on disk. Say so plainly and put the
    // delete button right here, rather than letting "off" imply "erased".
    const leftover = tracker.hasAnySiteData
      ? `<p class="fine">Domains Loaf already recorded are still saved on this computer. ` +
        cmdButton("linkish", "sites:forget", "Forget them for good") +
        `</p>`
      : "";
    return (
      `<h2>Privacy radar</h2><div class="radar-off">` +
      `<p><strong>The radar is off.</strong> Turn it on and "Google Chrome — 5h" becomes ` +
      `the actual list of sites that took those five hours.</p>` +
      `<p class="fine">Loaf reads the domain of your active tab and nothing else — not the ` +
      `page, not the path, not what you type. It stays on this computer.</p>` +
      howItReads(radar) +
      cmdButton("cta", "radar:on", "Turn on privacy radar") +
      `${leftover}</div>`
    );
  }

  const sites = tracker.todaySitesMerged();
  const browserTotal = Object.keys(tracker.todaySitesByBrowser).reduce(
    (sum, name) => sum + (tracker.today[name] ?? 0),
    0,
  );
  const unaccounted = Math.max(0, browserTotal - tracker.totalSiteSecondsToday);
  const maxSite = Math.max(sites[0]?.seconds ?? 1, 1);

  let body: string;
  if (sites.length === 0) {
    body =
      `<p class="empty">No sites recorded yet today. Loaf reads the active tab only while ` +
      `a browser is the app you're actually in.</p>`;
  } else {
    body = sites
      .slice(0, 10)
      .map(
        (site) =>
          `<div class="row"><div class="row-top">` +
          `<span class="app">${escapeHTML(site.domain)}</span>` +
          `<span class="time">${formatDuration(site.seconds)}</span></div>` +
          `<div class="bar-track"><div class="bar-fill site" style="width:${(site.seconds / maxSite) * 100}%"></div></div>` +
          `</div>`,
      )
      .join("");

    // Browser time the radar genuinely could not attribute, shown as its own row
    // rather than spread across the domains it did see. Under a minute is noise
    // and not worth a row.
    if (unaccounted > 60) {
      const pct = Math.min((unaccounted / maxSite) * 100, 100);
      body +=
        `<div class="row"><div class="row-top">` +
        `<span class="app muted">Not attributed</span>` +
        `<span class="time">${formatDuration(unaccounted)}</span></div>` +
        `<div class="bar-track"><div class="bar-fill unknown" style="width:${pct}%"></div></div>` +
        `<p class="fine">New tab pages, local files, PDFs, or time before you switched the radar on.</p>` +
        `</div>`;
    }
  }

  // How many tabs he will put up with. The reference offers this in its menu;
  // it lives here because this is the page that shows the tab counts it acts on.
  const thresholds =
    `<div class="section-row"><h2 class="sub">Tab tantrum</h2></div>` +
    `<div class="tabs">` +
    TANTRUM_OPTIONS.map(
      (n) =>
        `<button class="tab${radar.tabThreshold === n ? " active" : ""}" ` +
        `data-loaf-cmd="tantrum:${n}">${n === 0 ? "Never" : `Past ${n}`}</button>`,
    ).join("") +
    `</div>`;

  const peak = tracker.peakTabsToday;
  const peakLine =
    peak > 0
      ? `<p class="peak-callout">Most tabs open at once today: <strong>${peak}</strong>` +
        (radar.tabThreshold > 0
          ? ` · he starts complaining past ${radar.tabThreshold}`
          : " · tantrums are off") +
        `</p>`
      : "";

  return (
    `<div class="section-row"><h2>Privacy radar</h2><div class="tabs">` +
    // Turning it on has a whole consent screen; turning it back off was a
    // sentence in the copy and no button anywhere.
    cmdButton("tab", "radar:off", "Turn off") +
    cmdButton("tab", "sites:forget", "Forget site data") +
    `</div></div>${body}${peakLine}${thresholds}${permissionRows(radar, platform)}`
  );
}

// --- The two views -----------------------------------------------------------

/**
 * The dashboard's top-level sections.
 *
 * IT USED TO BE ONE SCROLL, and that is the problem this solves. Nine headings
 * stacked vertically meant the things people open this window for most — what
 * they have spent today on, and asking Loaf to do something — were separated
 * by four charts, and the voice controls sat two thirds of the way down a page
 * most people never reached the bottom of. Grouping costs one click and makes
 * every section reachable in that one click instead of a scroll and a hunt.
 *
 * Order is by how often a section is opened, not by how much of it there is:
 * "Today" first because it is the reason the window exists, "Help" last
 * because it is read once.
 */
export const DASHBOARD_VIEWS = [
  { id: "today", label: "Today" },
  // SECOND. Once there is anything in the store, "find the thing I said" is the
  // reason this window gets opened, and no other tab can answer it.
  { id: "search", label: "Search" },
  { id: "notes", label: "Notes" },
  { id: "history", label: "History" },
  { id: "voice", label: "Voice" },
  { id: "meetings", label: "Meetings" },
  // After Meetings and before Settings: it is a thing you set up once and then
  // check on, which puts it past the sections you read daily and ahead of the
  // ones you open when something is wrong.
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" },
  { id: "privacy", label: "Privacy" },
  { id: "help", label: "Help" },
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number]["id"];

export function isDashboardView(v: unknown): v is DashboardView {
  return DASHBOARD_VIEWS.some((s) => s.id === v);
}

/** The complete stylesheet for the full view. */
export const DASHBOARD_STYLES =
  BASE_CSS +
  PLUS_CSS +
  SETTINGS_CSS +
  MEETINGS_CSS +
  NOTES_CSS +
  MEETINGS_DELETE_CSS +
  MEMORY_CSS +
  CONNECTIONS_CSS +
  SEARCH_CSS;
/** The complete stylesheet for the hover card. */
export const MINI_STYLES = BASE_CSS + PLUS_CSS + MINI_CSS;

/**
 * Today's breakdown, the site radar, history, and most-productive-time — as
 * markup only.
 *
 * Split from the document so the real window can render into a page that
 * already exists, rather than replacing its own document wholesale. The
 * document form is kept for tests and for anything that wants a standalone
 * file.
 */
export function dashboardBody(
  tracker: Tracker,
  opts: DashboardOptions = {},
): string {
  const radar = opts.radar ?? disabledRadar();
  const platform = opts.platform ?? "other";
  const now = opts.now ?? tracker.currentDate();

  const apps = sortedApps(tracker);
  const maxVal = apps[0]?.[1] ?? 1;
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  // With the radar off, do not nest domains under browsers: a site breakdown
  // sitting directly above a card that says "the radar is off" reads as a bug.
  const rows = appRows(tracker, apps, maxVal, 10, radar.enabled);
  const emptyState =
    apps.length === 0
      ? `<p class="empty">Nothing tracked yet today. Go do something — I'm watching.</p>`
      : "";

  const firstRecorded = tracker.firstRecordedDay();
  const weekBars = dayBars(tracker.history(7), firstRecorded);
  const monthBars = dayBars(tracker.history(30), firstRecorded);

  // A short strip needs an explanation, or it reads as a chart that lost some
  // bars. Only shown while the window is actually clipped: on a full week it
  // would be a line of text saying nothing.
  const since =
    firstRecorded !== null && weekBars.length < 7
      ? `<p class="note">Recording since ${escapeHTML(
          new Date(`${firstRecorded}T00:00:00`).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
        )}. Earlier days are not shown because Loaf was not there for them.</p>`
      : "";

  // Always the measured histogram. The only question is whether there is enough
  // of it to name a peak out loud.
  const hist = tracker.hourlyHistogram();
  const recorded = hist.reduce((a, b) => a + b, 0);
  const confident = recorded >= CONFIDENT_AFTER;
  const peakHour = hist.reduce((best, v, i) => (v > hist[best]! ? i : best), 0);
  const maxHour = Math.max(...hist, 1);
  const hourBars = hist
    .map((seconds, hour) => {
      const h = Math.max(3, Math.floor((seconds / maxHour) * 46));
      // Nothing is highlighted until the claim is one we would stand behind.
      const cls = confident && hour === peakHour ? "hbar peak" : "hbar";
      return `<div class="hbar-track"><div class="${cls}" style="height:${h}px"></div></div>`;
    })
    .join("");

  const peakCallout = confident
    ? `<p class="peak-callout">You're sharpest around <strong>${hourRangeLabel(peakHour)}</strong></p>`
    : `<p class="peak-callout note-inline">Still learning your hours — Loaf needs a couple more before it guesses.</p>`;

  const view: DashboardView = isDashboardView(opts.view) ? opts.view : "today";
  const nav = DASHBOARD_VIEWS.map(
    (v) =>
      `<button class="view-tab${v.id === view ? " active" : ""}" role="tab" ` +
      `aria-selected="${v.id === view}" data-loaf-view="${v.id}">${v.label}</button>`,
  ).join("");

  // Every panel is rendered and all but one hidden, rather than only the
  // active one being built. Switching is then a class change with nothing to
  // re-measure or re-fetch, and a stats update that arrives while you are on
  // another tab does not silently drop the tab you were reading.
  const panel = (id: DashboardView, inner: string): string =>
    `<section class="view${id === view ? " active" : ""}" id="view-${id}" role="tabpanel"${
      id === view ? "" : " hidden"
    }>${inner}</section>`;

  return `<div class="wrap">
    <header class="head">
      <h1>🐾 Loaf<span class="plus">+</span></h1>
      <div class="date">${escapeHTML(dateLabel)}</div>
    </header>

    <div class="headline">
      <div class="total-label">Time with you today</div>
      <div class="total">${formatDuration(tracker.totalToday)}</div>
    </div>

    <nav class="views" role="tablist" aria-label="Dashboard sections">${nav}</nav>

    ${panel(
      "today",
      `${noticedBlock(tracker, opts)}
      <h2>By app</h2>
      ${rows}${emptyState}
      <h2>What you meant to do</h2>
      ${taskPanel(opts.tasks ?? [])}
      ${tabPanel(opts.tabs ?? [], opts.tabsRead ?? false)}`,
    )}

    ${panel(
      "history",
      `<div class="section-row">
        <h2>History</h2>
        <div class="tabs">
          <button class="tab active" data-loaf-tab="week">7 days</button>
          <button class="tab" data-loaf-tab="month">30 days</button>
        </div>
      </div>
      <div id="week" class="strip-panel">${stripHTML(weekBars, false)}</div>
      <div id="month" class="strip-panel month" style="display:none">${stripHTML(monthBars, true)}</div>
      ${since}

      <h2>Most productive time</h2>
      ${peakCallout}
      <div class="hours">${hourBars}</div>
      <div class="hours-axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>`,
    )}

    ${panel("voice", voicePanel(opts))}

    ${panel(
      "notes",
      notesPanel(opts.notes ?? [], opts.memory, opts.notesFilter ?? null, opts.notesEditing ?? null),
    )}

    ${panel("meetings", meetingsPanel(opts))}

    ${panel(
      "search",
      searchPanel(opts.search ?? EMPTY_SEARCH, (opts.now ?? new Date()).getTime()),
    )}

    ${panel(
      "connections",
      connectionsPanel(
        opts.connections ?? EMPTY_CONNECTIONS,
        (opts.now ?? new Date()).getTime(),
      ),
    )}

    ${panel("settings", settingsPanel(opts))}

    ${panel("privacy", radarSection(tracker, radar, platform))}

    ${panel(
      "help",
      `<h2>How to use him</h2>
      <ul class="howto">
        <li><b>Click</b> him for this window. <b>Click twice</b> to put it away.</li>
        <li><b>Right-click</b> him for everything: the closet, the timer, and the rest.</li>
        <li><b>Drag</b> him anywhere. He stays where you drop him.</li>
        <li><b>Hover</b> for a second and he shows you today at a glance.</li>
      </ul>

      <div class="support">
        <p class="support-line">Loaf is free, and made by one person.</p>
        <div class="support-actions">
          ${cmdButton("support-btn star", "open:star", "Star it on GitHub ★")}
          ${cmdButton("support-btn", "open:feedback", "Tell me what to build next")}
        </div>
        <p class="support-fine">
          Both open in your browser. Nothing is sent from Loaf, and starring is
          never checked &mdash; every feature works exactly the same either way.
        </p>
      </div>`,
    )}

    <div class="footer">
      <p>Lives only on this computer.<br>No account, no network, no upload.</p>
      ${opts.version ? `<p class="version">Loaf ${escapeHTML(opts.version)}</p>` : ""}
      <div class="footer-actions">
        ${cmdButton("danger", "reset", "Reset today")}
        ${cmdButton("danger", "sites:forget", "Forget site data")}
      </div>
    </div>
  </div>`;
}

/**
 * Voice: every setting for it, in one place, with the command box.
 *
 * ALL OF IT, RATHER THAN SOME HERE AND SOME IN THE CLOSET. The recogniser, the
 * listening mode, the wake word, the hold delay, the download and the spoken
 * voice used to sit in a wardrobe between eighteen animal portraits and a row
 * of scarves, while the dashboard grew its own partial summary of the same
 * things — so there were two screens that could disagree about whether Loaf
 * was listening. One screen cannot disagree with itself.
 *
 * Rendered only once the companion has said what the state is. Controls drawn
 * from a guess would show the wrong thing selected for the first second and
 * then jump, which on a page about microphones is worse than a short wait.
 */
function voicePanel(opts: DashboardOptions): string {
  const ask = `<h2>Ask Loaf</h2>
    <div class="ask">
      <input id="ask-box" class="ask-input" type="text" maxlength="200"
             placeholder="start a 25 minute focus session" aria-label="Ask Loaf to do something">
      <button class="ask-mic" id="ask-mic" data-loaf-ask="mic" hidden
              title="Hold a moment and speak" aria-label="Speak to Loaf">&#127908;</button>
      <button class="ask-go" data-loaf-ask="go">Go</button>
    </div>
    <p class="ask-hint" id="ask-reply">Try: <em>remind me to call the bank in 20 minutes</em> · <em>open the closet</em> · <em>go quiet</em></p>`;

  const s = opts.settings;
  if (!s) return ask;

  const platform = opts.platform ?? "other";
  // WINDOWS HAS A REAL OS RECOGNISER TO PREFER; NOTHING ELSE DOES. On any other
  // platform "Windows speech" is not a disabled option waiting on a download —
  // it is an API that platform does not have — so the picker offers Whisper
  // there instead, and the Whisper download belongs on THIS screen too, not
  // only under Meetings, because here it is not a nicety: it is the only
  // thing that makes a command or a dictated sentence work at all.
  const hasOSRecogniser = platform === "windows";
  const download = hasOSRecogniser ? "" : `<div class="settings-group">${whisperDownloadRow(s)}</div>`;
  const commandNote = hasOSRecogniser
    ? `Dictation uses Whisper once it is downloaded below — until then it hands
      over to Windows' own voice typing, which types into whatever you are in.
      Meetings always use Whisper — see the Meetings tab.`
    : `This machine has no built-in speech recognition, so commands and
      dictation both use Whisper, on this machine, once it is downloaded
      below. Meetings use the same download — see the Meetings tab.`;

  return `${ask}

    <h2>When it listens</h2>
    <div class="settings-group">${listenRow(s)}${holdRow(s)}</div>

    <h2>What hears your commands</h2>
    <div class="settings-group">${engineRow(s, platform)}</div>
    ${download}
    <p class="note">${commandNote}</p>

    <h2>How it talks back</h2>
    <div class="settings-group">${voiceRow(s)}</div>

    <h2>What Loaf can do right now</h2>
    <p class="note">Everything above, in plain sentences — what hears you, where
    anything it hears would go, and what does not exist yet.</p>
    ${disclosurePanel(s)}`;
}


/**
 * How long transcripts are kept.
 *
 * NOT the audio, and the copy says so: recordings are deleted the moment they
 * have been transcribed, on every path including failure, so there is no audio
 * left for a retention window to govern. Saying "delete recordings after N
 * days" would imply Loaf had been holding them all along.
 *
 * The default is forever, because the two ways this can be wrong are not
 * equal: a note you no longer want costs you a line on a screen, and a note
 * that vanished before you read it is gone.
 */
function retentionRow(settings: ClosetState | undefined): string {
  if (!settings) return "";
  const options = RETENTION_CHOICES.map(
    (d) =>
      `<option value="${d}"${d === settings.transcriptRetentionDays ? " selected" : ""}>` +
      `${d === KEEP_FOREVER ? "Until I delete them" : `${d} days`}</option>`,
  ).join("");
  // The download lives HERE now, next to the thing it is for. It used to sit
  // under the recogniser picker in Voice, which read as "this is what hears
  // your commands" — and it is not, and never was good at that.
  return `<h2>Transcription</h2>
    <div class="settings-group">${whisperDownloadRow(settings)}</div>

    <h2>How long to keep them</h2>
    <div class="listen">
      <select data-retention>${options}</select>
      <p class="why">${escapeHTML(retentionLabel(settings.transcriptRetentionDays))}.
      This governs the words, not the audio — recordings are deleted the moment
      they have been transcribed, every time, including when it fails.</p>
    </div>`;
}

/** The title cap for a note, mirroring `MAX_TITLE_LENGTH` in tasks/tasks.ts. */
const MAX_TITLE_LENGTH_FOR_NOTES = 80;

/**
 * Every label on any note, most used first.
 *
 * A small local reimplementation of `labelsInUse` from `tasks/tasks.ts` rather
 * than importing it: that one works over a `Task[]` and this module only ever
 * sees the trimmed-down `NoteView[]` the companion actually broadcasts. Ten
 * lines here is a smaller coupling than teaching the render layer the shape of
 * the model's own storage.
 */
function labelsOnTheWall(notes: readonly NoteView[]): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const note of notes) {
    for (const label of note.labels) {
      const key = label.toLowerCase();
      const seen = counts.get(key);
      if (seen) seen.n += 1;
      else counts.set(key, { label, n: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .map((c) => c.label);
}

/** One card's worth of markup, closed — the face every note shows by default. */
function noteCardClosed(n: NoteView): string {
  const timer = n.minutesLeft === null ? "" : `<span class="nt-timer">${n.minutesLeft}m</span>`;
  // Long enough to need room to breathe rather than sitting the same height as
  // "buy milk". Judged on the body now, not the title: the title is capped at
  // 80 characters same as ever, so a transcript's length lives in the body.
  const long = n.body.length > 220 || n.body.split("\n").length > 4 ? " long" : "";
  const pinnedCls = n.pinned ? " pinned" : "";
  const doneCls = n.done ? " done" : "";

  const title = n.title
    ? `<div class="nt-title-line" data-loaf-task="note-open:${escapeHTML(n.id)}">${escapeHTML(n.title)}</div>`
    : "";
  // An unopened, untitled note is not a card with nothing to click — the body
  // is still the open handle, and a note that is BOTH untitled and empty (the
  // instant after "Add note" on a body-only draft that failed) still shows its
  // footer, so it is never an inert rectangle.
  const body = n.body
    ? `<div class="nt-body" data-loaf-task="note-open:${escapeHTML(n.id)}">${escapeHTML(n.body)}</div>`
    : title
      ? ""
      : `<div class="nt-body nt-body-empty" data-loaf-task="note-open:${escapeHTML(n.id)}">Empty note</div>`;

  const chips = n.labels.length
    ? `<div class="nt-chips">${n.labels.map((l) => `<span class="nt-chip">${escapeHTML(l)}</span>`).join("")}</div>`
    : "";

  return (
    `<article class="nt-card colour-${escapeHTML(n.colour)} p-${escapeHTML(n.priority)}${long}${pinnedCls}${doneCls}">` +
    `<div class="nt-card-top">` +
    `<button class="nt-pin${n.pinned ? " active" : ""}" data-loaf-task="note-pin:${escapeHTML(n.id)}" ` +
    `title="${n.pinned ? "Unpin" : "Pin"}" aria-label="${n.pinned ? "Unpin" : "Pin"}">📌</button>` +
    `</div>` +
    title +
    body +
    chips +
    `<div class="nt-foot">` +
    `<span class="nt-pri">${escapeHTML(n.priority)}</span>${timer}` +
    `<span class="nt-acts">` +
    `<button class="nt-btn" data-loaf-task="note-done:${escapeHTML(n.id)}" ` +
    `title="${n.done ? "Put back" : "Archive"}">${n.done ? "↺" : "✓"}</button>` +
    `<button class="nt-btn" data-loaf-task="note-remove:${escapeHTML(n.id)}" title="Delete">×</button>` +
    `</span></div></article>`
  );
}

/**
 * One card's worth of markup, open for editing.
 *
 * TITLE AND BODY ARE SAVED TOGETHER, ON A BUTTON — everything else on the card
 * (pin, colour, a label) applies the moment it is clicked. That split is
 * deliberate: a colour or a pin is one decision with no wrong answer to type
 * your way into, so there is nothing to protect by waiting. Text is different —
 * sending a command on every keystroke would mean broadcasting a half-typed
 * sentence to the companion and back dozens of times, and losing the input if
 * a stats tick redraws the page mid-word.
 */
function noteCardOpen(n: NoteView): string {
  const swatches = NOTE_COLOURS.map((c: NoteColour) => {
    const active = c === n.colour ? " active" : "";
    const label = c === "default" ? "no colour" : c;
    return (
      `<button class="nt-swatch nt-swatch-${c}${active}" data-loaf-task="note-colour:${escapeHTML(n.id)}" ` +
      `data-colour="${c}" title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}"></button>`
    );
  }).join("");

  const chips = n.labels
    .map(
      (l) =>
        `<span class="nt-chip edit">${escapeHTML(l)}` +
        `<button class="nt-chip-x" data-loaf-task="note-label-remove:${escapeHTML(n.id)}" ` +
        `data-label="${escapeHTML(l)}" aria-label="Remove label ${escapeHTML(l)}">×</button></span>`,
    )
    .join("");

  return (
    `<article class="nt-card nt-editing colour-${escapeHTML(n.colour)}">` +
    `<input id="note-edit-title" class="nt-input nt-title-input" maxlength="${MAX_TITLE_LENGTH_FOR_NOTES}" ` +
    `value="${escapeHTML(n.title)}" placeholder="Title" aria-label="Title">` +
    `<textarea id="note-edit-body" class="nt-input" rows="7" maxlength="20000" ` +
    `placeholder="Take a note…" aria-label="Note">${escapeHTML(n.body)}</textarea>` +
    `<div class="nt-colour-row">${swatches}</div>` +
    `<div class="nt-chips edit-row">${chips}` +
    `<input id="note-edit-label" class="nt-label-input" maxlength="24" placeholder="+ label" aria-label="Add a label">` +
    `<button class="nt-btn" data-loaf-task="note-label-add:${escapeHTML(n.id)}" aria-label="Add label">+</button>` +
    `</div>` +
    `<div class="nt-tools">` +
    `<button class="nt-btn" data-loaf-task="note-remove:${escapeHTML(n.id)}">Delete</button>` +
    `<button class="nt-btn" data-loaf-task="note-close">Close</button>` +
    `<button class="nt-add" data-loaf-task="note-save:${escapeHTML(n.id)}">Save</button>` +
    `</div></article>`
  );
}

/**
 * Everything you have written down, as a wall of cards — a Google Keep shape,
 * not a checklist.
 *
 * A BOARD RATHER THAN A LIST, and the difference is not decoration. The task
 * list on Today is a checklist: one line each, ordered by priority, designed to
 * be worked through and emptied. This is where things go that are not one line
 * — a thought, a paragraph a meeting transcript dropped in, something you want
 * to be able to READ rather than tick, colour, pin, and file under a label.
 *
 * REBUILT from a real notepad model rather than the checklist's three fields.
 * The old version of this panel rendered `tasks.visible()` — at most three
 * items, capped by and ordered for the pet's checklist — so a wall of forty
 * notes showed three of them and called it a notepad. It also stored anything
 * typed here as a `title`, which is capped at 80 characters: paste in a
 * transcript and the rest was silently gone the moment it saved. Neither of
 * those is true any more. `notes` here is the WHOLE wall (`tasks.wall()`), and
 * the composer below writes a short title and an effectively unbounded body
 * into two different fields.
 *
 * Title and body are edited together, behind an explicit Save — see the note
 * on `noteCardOpen`. Colour, pin, archive and labels each apply the instant
 * they are clicked, the same way ticking a box on Today does.
 */
function notesPanel(
  notes: readonly NoteView[],
  memory: MemorySnapshot | undefined,
  filter: string | null,
  editingId: string | null,
): string {
  const compose = `<div class="nt-compose">
    <input id="nt-title" class="nt-input nt-title-input" maxlength="${MAX_TITLE_LENGTH_FOR_NOTES}"
           placeholder="Title" aria-label="Title">
    <textarea id="nt-body" class="nt-input" rows="3" maxlength="20000"
              placeholder="Take a note…" aria-label="Note"></textarea>
    <div class="nt-tools">
      <select id="nt-priority" class="nt-select" aria-label="Priority">
        <option value="now">Now</option>
        <option value="soon" selected>Soon</option>
        <option value="whenever">Whenever</option>
      </select>
      <input id="nt-minutes" class="nt-mins" type="number" min="0" max="600" step="5"
             placeholder="mins" aria-label="Remind me in, minutes">
      <button class="nt-add" data-loaf-note="add">Add note</button>
    </div>
    <p class="note">Ctrl+Enter adds it. Everything here stays on this computer.</p>
  </div>`;

  if (notes.length === 0) {
    // The memory panel goes on BOTH branches: what Loaf remembers is built
    // from transcripts as much as from typed notes, so an empty board does
    // not mean an empty memory.
    return `<h2>Notes</h2>${compose}
      <p class="empty">Nothing written down yet. Notes you add here, and anything
      Loaf transcribes for you, show up as cards.</p>
      ${memoryPanel(memory)}`;
  }

  const labels = labelsOnTheWall(notes);
  // The filter strip only earns its place once there is something to filter
  // BY. One label on one note is not a reason to add a row of chips above
  // every wall anyone will ever have.
  const filterStrip = labels.length
    ? `<div class="nt-filters">` +
      `<button class="nt-filter-chip${filter === null ? " active" : ""}" data-loaf-note-filter="">All</button>` +
      labels
        .map(
          (l) =>
            `<button class="nt-filter-chip${filter?.toLowerCase() === l.toLowerCase() ? " active" : ""}" ` +
            `data-loaf-note-filter="${escapeHTML(l)}">${escapeHTML(l)}</button>`,
        )
        .join("") +
      `</div>`
    : "";

  const shown = filter
    ? notes.filter((n) => n.labels.some((l) => l.toLowerCase() === filter.toLowerCase()))
    : notes;

  const empty =
    shown.length === 0
      ? `<p class="empty">Nothing here is labelled “${escapeHTML(filter ?? "")}”.</p>`
      : "";

  const cards = shown
    .map((n) => (n.id === editingId ? noteCardOpen(n) : noteCardClosed(n)))
    .join("");

  return `<h2>Notes</h2>${compose}${filterStrip}
    ${empty}<div class="nt-board">${cards}</div>
    ${memoryPanel(memory)}`;
}

/**
 * What Loaf has noticed keeps coming up, and what it comes up with.
 *
 * THIS IS THE POINT OF THE GRAPH, and it is deliberately small. A list can
 * already tell you what you wrote down; only a graph can tell you that Priya
 * and pricing keep appearing together. So each row is a name, how often it has
 * been seen, and what it is connected to — nothing else.
 *
 * EVERY ROW IS DERIVED FROM SOMETHING YOU WROTE OR SAID. There is no model
 * here and no inference: names come from capitalisation, topics from repeated
 * words. That is stated on the panel rather than left for someone to discover
 * when it gets one wrong, because a memory you cannot audit is a memory that
 * confidently misremembers.
 */
function memoryPanel(memory?: MemorySnapshot): string {
  if (!memory || memory.total === 0) return "";

  const rows = (list: readonly MemorySnapshot["people"][number][]): string =>
    list
      .map(
        (e) =>
          `<li><b>${escapeHTML(e.name)}</b> <span class="mem-n">${e.mentions}×</span>` +
          (e.linked.length > 0
            ? `<span class="mem-with">with ${escapeHTML(e.linked.join(", "))}</span>`
            : "") +
          `</li>`,
      )
      .join("");

  const section = (title: string, list: readonly MemorySnapshot["people"][number][]): string =>
    list.length === 0 ? "" : `<h3 class="mem-h">${title}</h3><ul class="mem">${rows(list)}</ul>`;

  return `<h2>What keeps coming up</h2>
    ${section("People", memory.people)}
    ${section("Topics", memory.topics)}
    <p class="note">Built only from your own notes and transcripts, by looking at
    capitalisation and repeated words — no model, no guessing at meaning. It
    will miss a name you wrote in lower case, and it forgets whatever your
    retention window forgets.</p>`;
}

/**
 * Meetings: what is recording now, and everything already kept.
 *
 * THE RECORDING STATE IS THE POINT OF THIS SCREEN. Everything else here is a
 * list; the top line is the answer to "is my microphone on right now", and it
 * is stated in words rather than implied by the presence of a stop button.
 * Getting that wrong is the one mistake in this app that a person could not
 * discover for themselves until afterwards.
 */
function meetingsPanel(opts: DashboardOptions): string {
  const m = opts.meetings;
  if (!m) {
    return `<h2>Meetings</h2><p class="empty">Asking Loaf what is recording…</p>`;
  }

  const state = m.recording
    ? `<div class="rec-state on"><span class="rec-dot"></span>` +
      `<b>Recording${m.current ? ` — ${escapeHTML(m.current)}` : ""}</b>` +
      `<span class="rec-sub">Your microphone only, never the other people.</span></div>`
    : `<div class="rec-state off"><b>Not recording.</b>` +
      `<span class="rec-sub">${
        m.current
          ? `You appear to be in ${escapeHTML(m.current)}.`
          : "No call detected right now — you can still record anything."
      }</span></div>`;

  const button = m.recording
    ? cmdButton("rec-btn stop", "record:stop", "Stop and transcribe")
    : m.canRecord
      ? cmdButton("rec-btn start", "record:start", "Record this meeting")
      : `<p class="note">${escapeHTML(m.blockedReason ?? "Recording is not available.")}</p>`;

  const rows =
    m.meetings.length === 0
      ? `<p class="empty">Nothing recorded yet. What you keep shows up here.</p>`
      : [...m.meetings]
          .reverse()
          .map((row) => {
            const when = new Date(row.startedAt).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            });
            const mins = Math.max(1, Math.round(row.seconds / 60));
            const notes =
              row.notes.length === 0
                ? `<p class="empty">No notes kept.</p>`
                : `<ul class="mt-notes">${row.notes
                    .map((n) => `<li>${escapeHTML(n)}</li>`)
                    .join("")}</ul>`;
            return (
              `<div class="mt-row"><div class="mt-head">` +
              `<b>${escapeHTML(row.where)}</b>` +
              `<span class="time">${escapeHTML(when)} · ${mins}m</span>` +
              `<button class="mt-x" data-loaf-forget="${escapeHTML(row.id)}" ` +
              `title="Delete this transcript">×</button>` +
              `</div>${notes}</div>`
            );
          })
          .join("");

  return `<h2>Right now</h2>
    ${state}
    <div class="shelf">${button}</div>

    <div class="section-row">
      <h2>Kept meetings (${m.meetings.length})</h2>
      ${
        m.meetings.length > 0
          ? cmdButton("mt-forget-all", "meetings:forget-all", "Delete all")
          : ""
      }
    </div>
    <div class="mt-list">${rows}</div>
    ${retentionRow(opts.settings)}`;
}

/**
 * Everything that is neither a chart nor about voice.
 *
 * The habits and the sound switch moved here from the closet for the same
 * reason the voice controls did: they are about what Loaf DOES, and the closet
 * is about what it looks like.
 */
function settingsPanel(opts: DashboardOptions): string {
  const s = opts.settings;
  return `${
    s
      ? `<h2>Habits <span class="shelf-note">what they get up to on their own</span></h2>
    <div class="habits">${habitRows(s)}${soundRow(s)}</div>
    <p class="note">Wandering is off until you say otherwise — you put the window
    where it is, and a pet that starts crossing a screen you're working on,
    unasked, is a bug report.</p>`
      : ""
  }

    <h2>Everything else</h2>
    <div class="shelf">
      ${cmdButton("shelf-btn", "open:closet", "Closet — character, outfit, opacity")}
      ${cmdButton("shelf-btn", "open:focus", "Focus timer")}
    </div>
    <div class="shelf shelf-soon">
      ${soonCard("Your sounds", "Drop in your own audio for the little noises he makes.")}
      ${soonCard("Draw a character", "Hand-drawn sprite packs, so he can be anything you like.")}
    </div>`;
}

/** The full view as a standalone document. */
export function dashboardHTML(
  tracker: Tracker,
  opts: DashboardOptions = {},
): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Loaf — today</title>
<style>${DASHBOARD_STYLES}</style></head>
<body>${dashboardBody(tracker, opts)}</body></html>`;
}

/**
 * The hover preview: the total, the top three apps, and the one site eating
 * most of today. A glance, not a report — the full dashboard has the rest.
 *
 * The reference ends this document with a script that measures the card and
 * posts its height back so the window can be sized to fit. That script is gone
 * along with the others; sizing the window is the host's job, and the host can
 * measure the card it just created without being told.
 */
export function miniBody(
  tracker: Tracker,
  opts: DashboardOptions = {},
): string {
  const radar = opts.radar ?? disabledRadar();
  const apps = sortedApps(tracker);
  const maxVal = apps[0]?.[1] ?? 1;
  const rows = appRows(tracker, apps, maxVal, 3, false);
  const emptyState =
    apps.length === 0 ? `<p class="empty">Nothing yet today.</p>` : "";

  let extra = taskBlock(opts.tasks ?? []);
  const top = tracker.todaySitesMerged()[0];
  if (top) {
    extra +=
      `<div class="mini-site"><span class="dot"></span>${escapeHTML(top.domain)}` +
      `<span class="time">${formatDuration(top.seconds)}</span></div>`;
  }
  const tabs = radar.tabsOpenNow;
  if (tabs !== null && tabs > 0) {
    const hot = tabs > radar.tabThreshold && radar.tabThreshold > 0;
    extra += `<div class="mini-tabs${hot ? " hot" : ""}">${tabs} tabs open${hot ? " — really?" : ""}</div>`;
  }

  return `<div class="wrap" id="wrap">
    <div class="total-label">Today</div>
    <div class="total mini-total">${formatDuration(tracker.totalToday)}</div>
    ${rows}${emptyState}${extra}
    <p class="hint">Click for the full dashboard →</p>
  </div>`;
}

/** The hover card as a standalone document. */
export function miniDashboardHTML(
  tracker: Tracker,
  opts: DashboardOptions = {},
): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Loaf</title>
<style>${MINI_STYLES}</style></head>
<body class="mini">${miniBody(tracker, opts)}</body></html>`;
}
