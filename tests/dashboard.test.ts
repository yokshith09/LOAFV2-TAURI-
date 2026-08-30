import { describe, it, expect } from "vitest";
import { Tracker, TICK_INTERVAL } from "../src/tracker/tracker";
import {
  dashboardHTML,
  miniDashboardHTML,
  escapeHTML,
  fnvSample,
  hourRangeLabel,
  disabledRadar,
  SAMPLE_HOUR_PATTERN,
  type RadarSnapshot,
} from "../src/dashboard/html";

const clockAt = (iso: string) => {
  let t = new Date(iso);
  return {
    now: (): Date => new Date(t),
    advance: (seconds: number): void => {
      t = new Date(t.getTime() + seconds * 1000);
    },
  };
};

/** A tracker with `n` ticks of each named app, on a fixed clock. */
function trackerWith(
  apps: Record<string, number>,
  iso = "2026-08-30T10:00:00",
): { tracker: Tracker; clock: ReturnType<typeof clockAt> } {
  const clock = clockAt(iso);
  const tracker = new Tracker({ now: clock.now });
  for (const [name, ticks] of Object.entries(apps)) {
    for (let i = 0; i < ticks; i++) tracker.tick(name, 0);
  }
  return { tracker, clock };
}

const radarOn = (over: Partial<RadarSnapshot> = {}): RadarSnapshot => ({
  enabled: true,
  tabThreshold: 12,
  peakTabsNow: null,
  statusRows: [],
  ...over,
});

/**
 * The document without its stylesheet.
 *
 * Every class the markup can carry is also *defined* in the CSS, so asserting
 * "this document does not contain `subrow`" against the whole file passes only
 * by accident and fails as soon as the rule exists. Assertions about what was
 * rendered have to look at what was rendered.
 */
const bodyOf = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/g, "");

describe("escaping", () => {
  it("neutralises markup in a name that came from the OS", () => {
    const { tracker } = trackerWith({ "<script>alert(1)</script>": 2 });
    const html = dashboardHTML(tracker);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes quotes, which the reference does not", () => {
    // Names land in title="..." here. Escaping only & < > leaves an attribute a
    // well-chosen window title can climb straight out of.
    expect(escapeHTML(`a" onmouseover="x`)).not.toContain('"');
    expect(escapeHTML("it's")).toBe("it&#39;s");
  });

  it("escapes the ampersand first, so an escape is not double-escaped", () => {
    expect(escapeHTML("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("no script reaches the document", () => {
  it("emits no script tag in either view", () => {
    // The reference wires its buttons with window.webkit.messageHandlers, which
    // does not exist here and which this app's CSP would refuse to run anyway.
    const { tracker } = trackerWith({ Xcode: 3 });
    for (const html of [dashboardHTML(tracker), miniDashboardHTML(tracker)]) {
      expect(html).not.toContain("<script");
      // The CSS legitimately says -webkit-user-select; the bridge is the thing
      // that must be gone.
      expect(html).not.toContain("messageHandlers");
    }
  });

  it("emits no inline event handler", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = dashboardHTML(tracker, { radar: radarOn() });
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("carries the host's commands as data attributes instead", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = dashboardHTML(tracker);
    expect(html).toContain('data-loaf-cmd="reset"');
    expect(html).toContain('data-loaf-tab="week"');
    expect(html).toContain('data-loaf-tab="month"');
  });
});

describe("the honesty rule", () => {
  it("marks days it never recorded as samples", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).toContain("wbar sample");
    expect(html).toContain("· sample");
  });

  it("says in words that the hatched bars are illustrative", () => {
    // The hatching alone is a visual convention nobody has been taught.
    const { tracker } = trackerWith({ Xcode: 3 });
    expect(dashboardHTML(tracker)).toContain("illustrative");
  });

  it("drops the note once every day in the window is real", () => {
    // Advance *between* ticks, never after the last one: a trailing advance
    // leaves the clock on a day nothing was recorded, and that day is the right
    // edge of the window the dashboard then draws.
    const clock = clockAt("2026-08-24T10:00:00");
    const tracker = new Tracker({ now: clock.now });
    for (let d = 0; d < 8; d++) {
      if (d > 0) clock.advance(24 * 3600);
      tracker.tick("Xcode", 0);
    }
    const html = bodyOf(dashboardHTML(tracker));
    const week = html.slice(html.indexOf('id="week"'), html.indexOf('id="month"'));
    const month = html.slice(html.indexOf('id="month"'));

    expect(week).not.toContain("wbar sample");
    expect(html).not.toContain("illustrative");
    // The 30-day strip still reaches back past the first recorded day, and the
    // note is deliberately about the week — so samples there are correct, and
    // this is the assertion that would catch the note being wired to the wrong
    // strip.
    expect(month).toContain("wbar sample");
  });

  it("labels the sample hour pattern as a sample", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).toContain("sample pattern");
    expect(html).toContain("hbar sample");
  });

  it("switches to measured hours once there is enough real data", () => {
    // Two hours is the threshold; below it the chart would be shaped almost
    // entirely by one morning and read as a finding.
    const { tracker } = trackerWith({ Xcode: (2 * 3600) / TICK_INTERVAL });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).not.toContain("sample pattern");
    expect(html).not.toContain("hbar sample");
  });

  it("seeds a day's sample bar deterministically", () => {
    // A bar that changed height on every reload would look like data updating.
    const { tracker } = trackerWith({ Xcode: 3 });
    expect(dashboardHTML(tracker)).toBe(dashboardHTML(tracker));
    expect(fnvSample("2026-08-30", 5400, 10800)).toBe(
      fnvSample("2026-08-30", 5400, 10800),
    );
  });

  it("keeps sample days inside a plausible range", () => {
    for (const key of ["2026-08-30", "2025-01-01", "1999-12-31"]) {
      const v = fnvSample(key, 5400, 3 * 3600);
      expect(v).toBeGreaterThanOrEqual(5400);
      expect(v).toBeLessThan(5400 + 3 * 3600);
    }
  });

  it("gives different days different sample bars", () => {
    const a = fnvSample("2026-08-30", 5400, 10800);
    const b = fnvSample("2026-08-29", 5400, 10800);
    expect(a).not.toBe(b);
  });
});

describe("unattributed browser time", () => {
  it("gets its own labelled row rather than being spread across domains", () => {
    // A guessed split would read as data. This is the one product that must not
    // do that.
    const { tracker } = trackerWith({ "Google Chrome": 120 }); // 600s
    tracker.creditSite("Google Chrome", "github.com", 300);

    const html = dashboardHTML(tracker, { radar: radarOn() });
    expect(html).toContain("Not attributed");
    expect(html).toContain("bar-fill unknown");
  });

  it("stays silent when everything was attributed", () => {
    const { tracker } = trackerWith({ "Google Chrome": 60 }); // 300s
    tracker.creditSite("Google Chrome", "github.com", 300);
    expect(dashboardHTML(tracker, { radar: radarOn() })).not.toContain(
      "Not attributed",
    );
  });

  it("ignores a gap under a minute", () => {
    // Rounding and tick boundaries leave a few seconds unattributed on any real
    // day; a row for that is noise dressed as a finding.
    const { tracker } = trackerWith({ "Google Chrome": 12 }); // 60s
    tracker.creditSite("Google Chrome", "github.com", 30);
    expect(dashboardHTML(tracker, { radar: radarOn() })).not.toContain(
      "Not attributed",
    );
  });
});

describe("the radar section", () => {
  it("offers to turn the radar on when it is off", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = dashboardHTML(tracker);
    expect(html).toContain("The radar is off");
    expect(html).toContain('data-loaf-cmd="radar:on"');
  });

  it("does not nest domains while the radar is off", () => {
    // A site breakdown directly above a card saying "the radar is off" reads as
    // a bug, whatever the history says.
    const { tracker } = trackerWith({ "Google Chrome": 60 });
    tracker.creditSite("Google Chrome", "github.com", 200);
    expect(bodyOf(dashboardHTML(tracker, { radar: disabledRadar() }))).not.toContain(
      "subrow",
    );
  });

  it("nests domains under their browser when the radar is on", () => {
    const { tracker } = trackerWith({ "Google Chrome": 60 });
    tracker.creditSite("Google Chrome", "github.com", 200);
    const html = dashboardHTML(tracker, { radar: radarOn() });
    expect(html).toContain("subrow");
    expect(html).toContain("github.com");
  });

  it("says leftover data is still on disk, with a way to delete it", () => {
    // "Off" must not be allowed to imply "erased".
    const { tracker } = trackerWith({ Safari: 12 });
    tracker.creditSite("Safari", "github.com", 60);
    const html = dashboardHTML(tracker, { radar: disabledRadar() });
    expect(html).toContain("still saved on this computer");
    expect(html).toContain('data-loaf-cmd="sites:forget"');
  });

  it("does not offer to forget data that was never collected", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    expect(dashboardHTML(tracker)).not.toContain("Forget them for good");
  });

  it("caps the domain list and counts what it left out", () => {
    const { tracker } = trackerWith({ "Google Chrome": 200 });
    for (let i = 0; i < 7; i++) {
      tracker.creditSite("Google Chrome", `site${i}.example`, 100 - i);
    }
    const html = dashboardHTML(tracker, { radar: radarOn() });
    expect(html).toContain("+ 3 more sites");
  });

  it("reports the peak tab count, and whether tantrums are on", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    tracker.notePeakTabs(31);
    expect(dashboardHTML(tracker, { radar: radarOn({ tabThreshold: 12 }) })).toContain(
      "complaining past 12",
    );
    expect(dashboardHTML(tracker, { radar: radarOn({ tabThreshold: 0 }) })).toContain(
      "tantrums are off",
    );
  });
});

describe("browser permissions", () => {
  const denied = radarOn({
    statusRows: [{ name: "Google Chrome", permission: "denied" }],
  });

  it("names the macOS settings pane on macOS", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    const html = dashboardHTML(tracker, { radar: denied, platform: "macos" });
    expect(html).toContain("System Settings");
    expect(html).toContain('data-loaf-cmd="automation:settings"');
  });

  it("does not send a Windows user looking for a macOS screen", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    const html = dashboardHTML(tracker, { radar: denied, platform: "windows" });
    expect(html).not.toContain("System Settings");
    expect(html).not.toContain("automation:settings");
    expect(html).toContain("could not read the active tab");
  });

  it("shows a dot per browser with its state", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    const html = dashboardHTML(tracker, {
      radar: radarOn({
        statusRows: [
          { name: "Safari", permission: "granted" },
          { name: "Firefox", permission: "unsupported", note: "no automation" },
        ],
      }),
    });
    expect(html).toContain("pdot ok");
    expect(html).toContain("pdot na");
    expect(html).toContain("no automation");
  });

  it("says nothing about browsers when none were probed", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    expect(bodyOf(dashboardHTML(tracker, { radar: radarOn() }))).not.toContain(
      "class=\"perms\"",
    );
  });
});

describe("the day itself", () => {
  it("leads with the total and the top app", () => {
    const { tracker } = trackerWith({ Xcode: 12, Safari: 6 });
    const html = dashboardHTML(tracker);
    expect(html).toContain("1m"); // 60s in Xcode
    expect(html.indexOf("Xcode")).toBeLessThan(html.indexOf("Safari"));
  });

  it("owns up to an empty day", () => {
    const clock = clockAt("2026-08-30T10:00:00");
    const html = dashboardHTML(new Tracker({ now: clock.now }));
    expect(html).toContain("Nothing tracked yet today");
  });

  it("shows at most ten apps", () => {
    const apps: Record<string, number> = {};
    for (let i = 0; i < 14; i++) apps[`App${i}`] = 14 - i;
    const { tracker } = trackerWith(apps);
    const html = dashboardHTML(tracker);
    expect(html).toContain("App0");
    expect(html).not.toContain("App10");
  });

  it("dates the header from the tracker's own clock, not the wall clock", () => {
    // Sourcing this from an ambient `new Date()` would let the caption and the
    // chart under it disagree in exactly the tests where the clock is injected.
    // Asserted without naming a format: the date is rendered in the viewer's
    // locale, so "Aug 30" is only correct in some of them.
    const { tracker } = trackerWith({ Xcode: 3 }, "2011-03-04T10:00:00");
    const expected = new Date(2011, 2, 4).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).toContain(`<div class="date">${expected}</div>`);
    expect(html).not.toContain(
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    );
  });

  it("makes no promise it cannot keep about where the data lives", () => {
    // "Lives only on this Mac" is both platform-wrong here and stronger than the
    // truth: Loaf does not upload anything, which is not the same as the file
    // being incapable of leaving.
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).not.toContain("this Mac");
    expect(html).toContain("No account, no network, no upload");
  });
});

describe("the hour chart", () => {
  it("reads noon-straddling ranges the way a person would", () => {
    expect(hourRangeLabel(10)).toBe("10–11 AM");
    expect(hourRangeLabel(11)).toBe("11 AM–12 PM");
    expect(hourRangeLabel(23)).toBe("11 PM–12 AM");
    expect(hourRangeLabel(0)).toBe("12–1 AM");
    expect(hourRangeLabel(12)).toBe("12–1 PM");
  });

  it("draws one bar per hour of the day", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const bars = bodyOf(dashboardHTML(tracker)).match(/hbar-track/g) ?? [];
    expect(bars).toHaveLength(24);
  });

  it("highlights the busiest hour and only that one", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const peaks = bodyOf(dashboardHTML(tracker)).match(/hbar peak/g) ?? [];
    expect(peaks).toHaveLength(1);
  });

  it("calls the peak from real data once it has enough", () => {
    // 3pm, deliberately not where the sample pattern peaks (10am), so a chart
    // still silently running on the sample would fail this.
    const { tracker } = trackerWith(
      { Xcode: (2 * 3600) / TICK_INTERVAL + 1 },
      "2026-08-30T15:00:00",
    );
    expect(dashboardHTML(tracker)).toContain("3–4 PM");
  });

  it("peaks the sample pattern at its own mid-morning high", () => {
    const busiest = SAMPLE_HOUR_PATTERN.indexOf(Math.max(...SAMPLE_HOUR_PATTERN));
    const { tracker } = trackerWith({ Xcode: 3 });
    expect(dashboardHTML(tracker)).toContain(hourRangeLabel(busiest));
  });
});

describe("the hover preview", () => {
  it("shows three apps at most", () => {
    const { tracker } = trackerWith({ A: 5, B: 4, C: 3, D: 2 });
    const html = miniDashboardHTML(tracker);
    expect(html).toContain("A");
    expect(html).not.toContain(">D<");
  });

  it("never nests domains — it is a glance, not a report", () => {
    const { tracker } = trackerWith({ "Google Chrome": 60 });
    tracker.creditSite("Google Chrome", "github.com", 200);
    expect(bodyOf(miniDashboardHTML(tracker, { radar: radarOn() }))).not.toContain(
      "subrow",
    );
  });

  it("names the single site eating most of today", () => {
    const { tracker } = trackerWith({ "Google Chrome": 60 });
    tracker.creditSite("Google Chrome", "github.com", 200);
    tracker.creditSite("Google Chrome", "news.example", 40);
    const html = miniDashboardHTML(tracker, { radar: radarOn() });
    expect(html).toContain("github.com");
    expect(html).not.toContain("news.example");
  });

  it("gets loud about the tab count only past the threshold", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    const calm = miniDashboardHTML(tracker, {
      radar: radarOn({ peakTabsNow: 5, tabThreshold: 12 }),
    });
    const hot = miniDashboardHTML(tracker, {
      radar: radarOn({ peakTabsNow: 40, tabThreshold: 12 }),
    });
    expect(calm).toContain("5 tabs open");
    expect(calm).not.toContain("really?");
    expect(hot).toContain("really?");
  });

  it("says nothing about tabs when nothing counted them", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    expect(miniDashboardHTML(tracker, { radar: radarOn() })).not.toContain(
      "tabs open",
    );
  });

  it("owns up to an empty day in its own smaller words", () => {
    const clock = clockAt("2026-08-30T10:00:00");
    expect(miniDashboardHTML(new Tracker({ now: clock.now }))).toContain(
      "Nothing yet today",
    );
  });
});

describe("the document itself", () => {
  it("is self-contained — nothing to fetch", () => {
    // A window whose entire pitch is that it does not phone home must not have
    // a stylesheet or a font that does.
    const { tracker } = trackerWith({ Xcode: 3 });
    for (const html of [dashboardHTML(tracker), miniDashboardHTML(tracker)]) {
      expect(html).not.toContain("http://");
      expect(html).not.toContain("https://");
      expect(html).not.toContain("<link");
      expect(html).not.toContain("@import");
    }
  });

  it("balances its own tags well enough to parse", () => {
    const { tracker } = trackerWith({ Xcode: 3, "Google Chrome": 12 });
    tracker.creditSite("Google Chrome", "github.com", 30);
    const html = dashboardHTML(tracker, { radar: radarOn() });
    const opens = (html.match(/<div\b/g) ?? []).length;
    const closes = (html.match(/<\/div>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
