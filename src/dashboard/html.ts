import { Tracker, formatDuration, dayKeyFor, type HistoryEntry } from "../tracker/tracker";
import { BASE_CSS, PLUS_CSS, MINI_CSS } from "./css";
import { TANTRUM_OPTIONS } from "./events";

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
  readonly peakTabsNow: number | null;
  readonly statusRows: readonly BrowserStatus[];
}

/** The radar switched off in a build that has one. */
export function disabledRadar(): RadarSnapshot {
  return {
    available: true,
    readsInsideBrowser: true,
    enabled: false,
    tabThreshold: 0,
    peakTabsNow: null,
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
          label = "reading domains";
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

/** The complete stylesheet for the full view. */
export const DASHBOARD_STYLES = BASE_CSS + PLUS_CSS;
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

  return `<div class="wrap">
    <h1>🐾 Loaf<span class="plus">+</span></h1>
    <div class="date">${escapeHTML(dateLabel)}</div>
    <div class="total-label">Time with you today</div>
    <div class="total">${formatDuration(tracker.totalToday)}</div>

    <h2>By app</h2>
    ${rows}${emptyState}

    ${radarSection(tracker, radar, platform)}

    <div class="section-row">
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
    <div class="hours-axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>

    <h2>Everything else</h2>
    <div class="shelf">
      ${cmdButton("shelf-btn", "open:closet", "Closet")}
      ${cmdButton("shelf-btn", "open:focus", "Focus timer")}
    </div>
    <div class="shelf shelf-soon">
      ${soonCard("Your sounds", "Drop in your own audio for the little noises he makes.")}
      ${soonCard("Draw a character", "Hand-drawn sprite packs, so he can be anything you like.")}
    </div>

    <h2>How to use him</h2>
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
    </div>

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

  let extra = "";
  const top = tracker.todaySitesMerged()[0];
  if (top) {
    extra +=
      `<div class="mini-site"><span class="dot"></span>${escapeHTML(top.domain)}` +
      `<span class="time">${formatDuration(top.seconds)}</span></div>`;
  }
  const tabs = radar.peakTabsNow;
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
