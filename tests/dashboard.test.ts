import { describe, it, expect } from "vitest";
import { Tracker, TICK_INTERVAL } from "../src/tracker/tracker";
import {
  dashboardHTML,
  miniDashboardHTML,
  escapeHTML,
  hourRangeLabel,
  disabledRadar,
  type RadarSnapshot,
} from "../src/dashboard/html";
import { isCommand, TANTRUM_OPTIONS } from "../src/dashboard/events";

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
  available: true,
  readsInsideBrowser: true,
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
  it("invents nothing for days it never recorded", () => {
    // The reference filled every unrecorded day with a seeded 1.5-4.5h bar,
    // hatched and captioned "(sample)", so a fresh install had a full-looking
    // chart. A made-up bar is asking to be read as data, and the caption doing
    // the disclaiming is smaller than the bars doing the lying.
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).not.toContain("sample");
    expect(html).not.toContain("illustrative");
  });

  it("shows nothing at all from before the first recorded day", () => {
    // One day of history must not be drawn as a week.
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = bodyOf(dashboardHTML(tracker));
    const week = html.slice(html.indexOf('id="week"'), html.indexOf('id="month"'));
    expect(week.match(/class="wbar[ "]/g) ?? []).toHaveLength(1);
  });

  it("draws a day inside the window that recorded nothing as empty", () => {
    // Loaf was installed by then and recorded nothing. That is an honest gap,
    // and a different statement from "we were not here yet".
    const clock = clockAt("2026-08-26T10:00:00");
    const tracker = new Tracker({ now: clock.now });
    tracker.tick("Xcode", 0);
    clock.advance(2 * 24 * 3600); // the 27th passes unrecorded
    tracker.tick("Xcode", 0);

    const html = bodyOf(dashboardHTML(tracker));
    const week = html.slice(html.indexOf('id="week"'), html.indexOf('id="month"'));
    expect(week).toContain("wbar nodata");
    expect(week).toContain("nothing recorded");
    // Three slots: the 26th, the empty 27th, the 28th. Not seven.
    expect(week.match(/class="wbar[ "]/g) ?? []).toHaveLength(3);
  });

  it("never hatches an empty day the way the reference hatched an invented one", () => {
    // Reusing that treatment would resurrect the confusion the invented bars
    // caused, with the opposite meaning.
    const clock = clockAt("2026-08-26T10:00:00");
    const tracker = new Tracker({ now: clock.now });
    tracker.tick("Xcode", 0);
    clock.advance(2 * 24 * 3600);
    tracker.tick("Xcode", 0);
    expect(bodyOf(dashboardHTML(tracker))).not.toContain("wbar sample");
  });

  it("says so plainly when there is no history at all", () => {
    const clock = clockAt("2026-08-30T10:00:00");
    const html = bodyOf(dashboardHTML(new Tracker({ now: clock.now })));
    expect(html).toContain("No days recorded yet");
    expect(html).not.toContain('class="wbar');
  });

  it("refuses to name a peak hour before it has grounds to", () => {
    // This is exactly when a new user first opens the dashboard, and exactly
    // where the reference reached for an invented curve.
    const { tracker } = trackerWith({ Xcode: 3 });
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).not.toContain("You're sharpest");
    expect(html).toContain("Still learning your hours");
    expect(html).not.toContain("hbar peak");
  });

  it("names the peak once there are a couple of hours behind it", () => {
    const { tracker } = trackerWith(
      { Xcode: (2 * 3600) / TICK_INTERVAL },
      "2026-08-30T15:00:00",
    );
    const html = bodyOf(dashboardHTML(tracker));
    expect(html).toContain("You're sharpest around");
    expect(html).toContain("3\u20134 PM");
    expect(html).not.toContain("Still learning");
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

describe("saying how the domain is obtained", () => {
  it("says nothing on a platform that truncates inside the browser", () => {
    // There is nothing to disclose: the URL never crosses a process boundary.
    const { tracker } = trackerWith({ Safari: 3 });
    const html = dashboardHTML(tracker, {
      radar: { ...disabledRadar(), readsInsideBrowser: true },
    });
    expect(html).not.toContain("address bar");
  });

  it("says so plainly where it reads the address bar instead", () => {
    // The weaker of the two promises has to be the one that speaks up. Omitting
    // this is exactly the kind of silence the whole feature exists not to keep.
    const { tracker } = trackerWith({ Safari: 3 });
    const html = dashboardHTML(tracker, {
      radar: { ...disabledRadar(), readsInsideBrowser: false },
      platform: "windows",
    });
    expect(html).toContain("address bar");
    expect(html).toContain("while you are typing");
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
    expect(hourRangeLabel(10)).toBe("10\u201311 AM");
    expect(hourRangeLabel(11)).toBe("11 AM\u201312 PM");
    expect(hourRangeLabel(23)).toBe("11 PM\u201312 AM");
    expect(hourRangeLabel(0)).toBe("12\u20131 AM");
    expect(hourRangeLabel(12)).toBe("12\u20131 PM");
  });

  it("draws one bar per hour of the day", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    const bars = bodyOf(dashboardHTML(tracker)).match(/hbar-track/g) ?? [];
    expect(bars).toHaveLength(24);
  });

  it("highlights the busiest hour and only that one", () => {
    const { tracker } = trackerWith(
      { Xcode: (2 * 3600) / TICK_INTERVAL },
      "2026-08-30T15:00:00",
    );
    const peaks = bodyOf(dashboardHTML(tracker)).match(/hbar peak/g) ?? [];
    expect(peaks).toHaveLength(1);
  });

  it("calls the peak from where the time was actually spent", () => {
    const { tracker } = trackerWith(
      { Xcode: (2 * 3600) / TICK_INTERVAL + 1 },
      "2026-08-30T15:00:00",
    );
    expect(dashboardHTML(tracker)).toContain("3\u20134 PM");
  });

  it("leaves every unworked hour at the same empty stub", () => {
    // With one busy hour, the other twenty-three must all sit at the minimum —
    // any variation between them would be a shape nobody measured.
    const { tracker } = trackerWith(
      { Xcode: (2 * 3600) / TICK_INTERVAL },
      "2026-08-30T15:00:00",
    );
    const body = bodyOf(dashboardHTML(tracker));
    const hours = body.slice(body.indexOf('class="hours"'));
    const stubs = hours.match(/class="hbar" style="height:3px"/g) ?? [];
    expect(stubs).toHaveLength(23);
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

describe("explaining a short chart", () => {
  it("says when recording started, so a stub chart is not a mystery", () => {
    const { tracker } = trackerWith({ Xcode: 3 });
    expect(bodyOf(dashboardHTML(tracker))).toContain("Recording since");
  });

  it("says nothing once the whole week is covered", () => {
    // On a full strip that line would be text explaining an absence that is not
    // there.
    const clock = clockAt("2026-08-24T10:00:00");
    const tracker = new Tracker({ now: clock.now });
    for (let d = 0; d < 8; d++) {
      if (d > 0) clock.advance(24 * 3600);
      tracker.tick("Xcode", 0);
    }
    expect(bodyOf(dashboardHTML(tracker))).not.toContain("Recording since");
  });

  it("says nothing at all when there is no history to explain", () => {
    const clock = clockAt("2026-08-30T10:00:00");
    expect(bodyOf(dashboardHTML(new Tracker({ now: clock.now })))).not.toContain(
      "Recording since",
    );
  });
});

describe("the tab tantrum threshold", () => {
  it("offers every option, with the current one marked", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    const html = bodyOf(dashboardHTML(tracker, { radar: radarOn({ tabThreshold: 40 }) }));
    for (const n of TANTRUM_OPTIONS) {
      expect(html).toContain(`data-loaf-cmd="tantrum:${n}"`);
    }
    expect(html).toContain('class="tab active" data-loaf-cmd="tantrum:40"');
  });

  it("calls zero what it is, rather than showing a 0", () => {
    const { tracker } = trackerWith({ Safari: 3 });
    expect(bodyOf(dashboardHTML(tracker, { radar: radarOn() }))).toContain(">Never<");
  });

  it("accepts only the thresholds it actually offers", () => {
    // This sets how tolerant he is; an arbitrary number off the bus has no
    // business becoming one.
    for (const n of TANTRUM_OPTIONS) expect(isCommand(`tantrum:${n}`)).toBe(true);
    for (const junk of ["tantrum:1", "tantrum:", "tantrum:abc", "tantrum:-40", "tantrum"]) {
      expect(isCommand(junk)).toBe(false);
    }
  });

  it("offers a way to switch the radar off, not only on", () => {
    // Turning it on has a whole consent screen; turning it back off was a
    // sentence in the copy and no button anywhere.
    const { tracker } = trackerWith({ Safari: 3 });
    expect(bodyOf(dashboardHTML(tracker, { radar: radarOn() }))).toContain(
      'data-loaf-cmd="radar:off"',
    );
    expect(isCommand("radar:off")).toBe(true);
  });
});

describe("the version line", () => {
  it("shows the running build when it is known", () => {
    const html = dashboardHTML(new Tracker({ json: null }), { version: "0.2.0" });
    expect(html).toContain("Loaf 0.2.0");
  });

  // Omitted rather than guessed: the hover card and the tests have no binary to
  // ask, and a footer reading "unknown" is worse than no footer line at all.
  it("says nothing when it is not", () => {
    const html = dashboardHTML(new Tracker({ json: null }), {});
    expect(html).not.toContain('class="version"');
  });

  it("escapes it, like every other value that reaches the page", () => {
    const html = dashboardHTML(new Tracker({ json: null }), {
      version: '0.2.0"><script>x</script>',
    });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("tasks on the hover card", () => {
  const tracker = () => new Tracker({ json: null });

  it("shows nothing when there is nothing outstanding", () => {
    // A heading over an empty list is a reproach, and this feature is not that.
    // Asserted on the markup, not the word: the stylesheet is embedded in the
    // document, so a bare `task-row` matches the CSS and always passes.
    expect(miniDashboardHTML(tracker(), { tasks: [] })).not.toContain('class="tasks"');
  });

  it("shows a task with its priority", () => {
    const html = miniDashboardHTML(tracker(), {
      tasks: [{ title: "write the spec", priority: "now", minutesLeft: null }],
    });
    expect(html).toContain("write the spec");
    expect(html).toContain("p-now");
  });

  it("shows a timer when there is one", () => {
    const html = miniDashboardHTML(tracker(), {
      tasks: [{ title: "bread", priority: "soon", minutesLeft: 12 }],
    });
    expect(html).toContain("12m");
  });

  it("escapes the title, like every other value on the page", () => {
    const html = miniDashboardHTML(tracker(), {
      tasks: [{ title: '<script>x</script>', priority: "soon", minutesLeft: null }],
    });
    expect(html).not.toContain("<script>x</script>");
  });
});
