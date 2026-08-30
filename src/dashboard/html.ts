import { Tracker, formatDuration, dayKeyFor, type HistoryEntry } from "../tracker/tracker";
import { BASE_CSS, PLUS_CSS, MINI_CSS } from "./css";

/**
 * Both dashboard views, as self-contained HTML. Ported from `DashboardHTML.swift`.
 *
 * Regenerated fresh from the tracker every time one is opened — there is no
 * state here, and nothing to fetch.
 *
 * THE HONESTY RULE. Days and hours Loaf has not actually recorded are filled
 * with clearly-marked sample bars — hatched, labelled "(sample)", called out in
 * a note — so the charts look right on day one without ever passing invented
 * numbers off as measurements. The same rule governs the site breakdown:
 * browser time the radar could not attribute gets its own labelled row and is
 * never quietly distributed across the domains it did see. A guessed split
 * reads as data, and this is the one product that must not do that.
 *
 * TWO DELIBERATE DEPARTURES FROM THE REFERENCE, both forced by the move off
 * WebKit-on-macOS:
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
  readonly enabled: boolean;
  /** Tabs open before the tantrum. 0 = tantrums off. */
  readonly tabThreshold: number;
  /** Tabs open right now, or null if nothing has counted them. */
  readonly peakTabsNow: number | null;
  readonly statusRows: readonly BrowserStatus[];
}

export function disabledRadar(): RadarSnapshot {
  return { enabled: false, tabThreshold: 0, peakTabsNow: null, statusRows: [] };
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

// --- Sample data -------------------------------------------------------------

/**
 * FNV-1a, 64-bit, matching the reference exactly so a given day seeds the same
 * illustrative bar in both apps.
 *
 * Deterministic and not random on purpose: a sample bar that changed height on
 * every reload would look like data being updated.
 */
export function fnvSample(seedKey: string, min: number, range: number): number {
  const MASK = 0xffffffffffffffffn;
  let x = 1469598103934665603n;
  for (const byte of new TextEncoder().encode(seedKey)) {
    x = ((x ^ BigInt(byte)) * 1099511628211n) & MASK;
  }
  return min + Number(x % BigInt(Math.max(range, 1)));
}

/**
 * An illustrative knowledge-worker curve: quiet overnight, a mid-morning peak,
 * a lunch dip, a smaller afternoon peak. Seconds per hour, 0 = midnight.
 */
export const SAMPLE_HOUR_PATTERN: readonly number[] = [
  0, 0, 0, 0, 0, 0, 300, 900, 1900, 2600, 2900, 2400, 1400, 2000, 2700, 2500,
  1800, 1100, 700, 400, 150, 0, 0, 0,
];

/** Below this much real data the hour chart is illustrative rather than measured. */
const REAL_HOURS_THRESHOLD = 2 * 3600;

interface DayBar {
  readonly label: string;
  readonly seconds: number;
  readonly isToday: boolean;
  readonly isSample: boolean;
}

function dayBars(days: readonly HistoryEntry[]): DayBar[] {
  return days.map((d) =>
    d.hasData
      ? { label: d.label, seconds: d.total, isToday: d.isToday, isSample: false }
      : {
          label: d.label,
          // 1.5h–4.5h: plausible enough to shape the chart, never presented as real.
          seconds: fnvSample(dayKeyFor(d.date), 5400, 3 * 3600),
          isToday: d.isToday,
          isSample: true,
        },
  );
}

function stripHTML(bars: readonly DayBar[], thin: boolean): string {
  const maxV = Math.max(...bars.map((b) => b.seconds), 1);
  return bars
    .map((bar, i) => {
      const h = Math.max(3, Math.floor((bar.seconds / maxV) * 64));
      let cls = "wbar";
      if (bar.isSample) cls += " sample";
      if (bar.isToday) cls += " today";
      const showLabel = !thin || bar.isToday || i % 5 === 0;
      const widthClass = thin ? "wday thin" : "wday";
      const title = `${bar.label}: ${formatDuration(bar.seconds)}${bar.isSample ? " · sample" : ""}`;
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

function radarSection(
  tracker: Tracker,
  radar: RadarSnapshot,
  platform: Platform,
): string {
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
    `<div class="section-row"><h2>Privacy radar</h2>` +
    cmdButton("tab", "sites:forget", "Forget site data") +
    `</div>${body}${peakLine}${permissionRows(radar, platform)}`
  );
}

// --- The two views -----------------------------------------------------------

/** Today's breakdown, the site radar, history, and most-productive-time. */
export function dashboardHTML(
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

  const weekBars = dayBars(tracker.history(7));
  const monthBars = dayBars(tracker.history(30));
  const anySampleWeek = weekBars.some((b) => b.isSample);

  const hist = tracker.hourlyHistogram();
  const realHours = hist.reduce((a, b) => a + b, 0);
  const usingSampleHours = realHours < REAL_HOURS_THRESHOLD;
  const effective = usingSampleHours ? SAMPLE_HOUR_PATTERN : hist;
  const peakHour = effective.reduce(
    (best, v, i) => (v > effective[best]! ? i : best),
    0,
  );
  const maxHour = Math.max(...effective, 1);
  const hourBars = effective
    .map((seconds, hour) => {
      const h = Math.max(3, Math.floor((seconds / maxHour) * 46));
      const cls =
        hour === peakHour ? "hbar peak" : usingSampleHours ? "hbar sample" : "hbar";
      return `<div class="hbar-track"><div class="${cls}" style="height:${h}px"></div></div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Loaf — today</title>
<style>${BASE_CSS}${PLUS_CSS}</style></head>
<body>
  <div class="wrap">
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
    ${anySampleWeek ? `<p class="note">Hatched bars are illustrative — real history fills in the longer Loaf runs.</p>` : ""}

    <h2>Most productive time</h2>
    <p class="peak-callout">You're sharpest around <strong>${hourRangeLabel(peakHour)}</strong>${
      usingSampleHours ? ` <span class="note-inline">(sample pattern)</span>` : ""
    }</p>
    <div class="hours">${hourBars}</div>
    <div class="hours-axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>

    <div class="footer">
      <p>Lives only on this computer.<br>No account, no network, no upload.</p>
      ${cmdButton("reset", "reset", "Reset today")}
    </div>
  </div>
</body></html>`;
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
export function miniDashboardHTML(
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

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Loaf</title>
<style>${BASE_CSS}${PLUS_CSS}${MINI_CSS}</style></head>
<body class="mini">
  <div class="wrap" id="wrap">
    <div class="total-label">Today</div>
    <div class="total mini-total">${formatDuration(tracker.totalToday)}</div>
    ${rows}${emptyState}${extra}
    <p class="hint">Click for the full dashboard →</p>
  </div>
</body></html>`;
}
