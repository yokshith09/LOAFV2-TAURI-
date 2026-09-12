import { describe, it, expect } from "vitest";
import { Tracker, TICK_INTERVAL } from "../src/tracker/tracker";
import {
  dashboardHTML,
  miniDashboardHTML,
  escapeHTML,
  hourRangeLabel,
  disabledRadar,
  DASHBOARD_VIEWS,
  type RadarSnapshot,
} from "../src/dashboard/html";
import { isCommand, TANTRUM_OPTIONS, type NoteView } from "../src/dashboard/events";
import { wakeWordsFor } from "../src/voice/wake";
import {
  ClosetSettings,
  MemorySettingsStore,
  type ClosetState,
} from "../src/closet/settings";

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
  tabsOpenNow: null,
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

  /**
   * The bug report this answers: "the tab tantrum isn't working", with
   * "Most tabs open at once today" — a running maximum, not the live count the
   * tantrum actually reacts to — the only number on screen. There was no way
   * to tell "not reacting" apart from "reacting correctly to fewer tabs than
   * the peak suggests". This is that missing number.
   */
  it("shows the live tab count next to a browser it can read, not just the day's peak", () => {
    const { tracker } = trackerWith({ Chrome: 3 });
    const html = dashboardHTML(tracker, {
      radar: radarOn({
        statusRows: [{ name: "Chrome", permission: "granted", tabCount: 39 }],
      }),
    });
    expect(html).toContain("39 tabs open now");
  });

  it("uses the singular for exactly one tab", () => {
    const { tracker } = trackerWith({ Chrome: 3 });
    const html = dashboardHTML(tracker, {
      radar: radarOn({
        statusRows: [{ name: "Chrome", permission: "granted", tabCount: 1 }],
      }),
    });
    expect(html).toContain("1 tab open now");
    expect(html).not.toContain("1 tabs");
  });

  it("says only that it is reading, when no count has come in yet", () => {
    const { tracker } = trackerWith({ Chrome: 3 });
    const html = dashboardHTML(tracker, {
      radar: radarOn({
        statusRows: [{ name: "Chrome", permission: "granted" }],
      }),
    });
    expect(html).toContain("reading domains");
    expect(html).not.toContain("tabs open now");
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
      radar: radarOn({ tabsOpenNow: 5, tabThreshold: 12 }),
    });
    const hot = miniDashboardHTML(tracker, {
      radar: radarOn({ tabsOpenNow: 40, tabThreshold: 12 }),
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
      tasks: [{ title: "write the spec", priority: "now", dueAt: null }],
    });
    expect(html).toContain("write the spec");
    expect(html).toContain("p-now");
  });

  it("shows a timer when there is one", () => {
    const now = new Date("2026-09-12T10:00:00Z");
    const html = miniDashboardHTML(tracker(), {
      now,
      tasks: [{ title: "bread", priority: "soon", dueAt: now.getTime() + 12 * 60_000 }],
    });
    expect(html).toContain("12m");
  });

  it("counts DOWN, instead of freezing at the number it was sent", () => {
    // The bug: minutesLeft was computed once when the list changed and shipped
    // as a plain number, so a 45-minute reminder read "45m" for the whole 45
    // minutes and then vanished. Same task, two moments, two answers.
    const due = new Date("2026-09-12T11:00:00Z").getTime();
    const task = { title: "bread", priority: "soon", dueAt: due } as const;
    const early = miniDashboardHTML(tracker(), { now: new Date(due - 45 * 60_000), tasks: [task] });
    const late = miniDashboardHTML(tracker(), { now: new Date(due - 5 * 60_000), tasks: [task] });
    expect(early).toContain("45m");
    expect(late).toContain("5m");
    expect(late).not.toContain("45m");
  });

  it("says a missed task is late rather than showing a stuck 0m", () => {
    // Three states used to collapse into "0m": due in seconds, due now, and
    // long overdue with the timer never cleared.
    const due = new Date("2026-09-12T11:00:00Z").getTime();
    const html = miniDashboardHTML(tracker(), {
      now: new Date(due + 20 * 60_000),
      tasks: [{ title: "bread", priority: "now", dueAt: due }],
    });
    expect(html).toContain("20m late");
    // Precisely: no timer whose whole content is "0m". A plain substring check
    // would match the "0m" inside "20m late".
    expect(html).not.toMatch(/>0m</);
  });

  it("only reaches zero when the time is actually up", () => {
    // `round` showed "2m" with ninety seconds left and "0m" for the final
    // twenty-nine. A countdown should hold 1m until the minute is gone.
    const due = new Date("2026-09-12T11:00:00Z").getTime();
    const html = miniDashboardHTML(tracker(), {
      now: new Date(due - 20_000),
      tasks: [{ title: "bread", priority: "now", dueAt: due }],
    });
    expect(html).toContain("1m");
  });

  it("escapes the title, like every other value on the page", () => {
    const html = miniDashboardHTML(tracker(), {
      tasks: [{ title: '<script>x</script>', priority: "soon", dueAt: null }],
    });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("the sectioned dashboard", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;

  it("offers every section as a tab", () => {
    const html = dashboardHTML(t());
    for (const v of DASHBOARD_VIEWS) {
      expect(html).toContain(`data-loaf-view="${v.id}"`);
      expect(html).toContain(v.label);
    }
  });

  it("opens on Today, and marks only that tab active", () => {
    const html = dashboardHTML(t());
    expect(html).toContain(`class="view-tab active" role="tab" aria-selected="true" data-loaf-view="today"`);
    expect(html).toContain(`id="view-today" role="tabpanel"`);
    // Exactly one active tab, or the header lies about where you are.
    expect(html.match(/view-tab active/g)).toHaveLength(1);
  });

  it("opens on whichever section it was told to", () => {
    const html = dashboardHTML(t(), { view: "voice" });
    expect(html).toContain(`aria-selected="true" data-loaf-view="voice"`);
    expect(html.match(/view-tab active/g)).toHaveLength(1);
  });

  // Every panel is rendered and all but one hidden, so switching costs no
  // work and a stats tick cannot drop the section the reader was on.
  it("renders every panel, hiding the ones that are not open", () => {
    const html = dashboardHTML(t(), { view: "history" });
    for (const v of DASHBOARD_VIEWS) expect(html).toContain(`id="view-${v.id}"`);
    expect(html).toContain(`id="view-today" role="tabpanel" hidden`);
    expect(html).not.toContain(`id="view-history" role="tabpanel" hidden`);
  });

  it("refuses a section it does not have, rather than rendering none", () => {
    const html = dashboardHTML(t(), { view: "nonsense" as never });
    expect(html).toContain(`aria-selected="true" data-loaf-view="today"`);
  });

  it("keeps the headline total outside the sections, where it is always seen", () => {
    const html = dashboardHTML(t(), { view: "help" });
    expect(html).toContain("Time with you today");
  });
});

describe("the voice section", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;
  const settingsWith = (over: Partial<ClosetState> = {}): ClosetState => ({
    ...new ClosetSettings(new MemorySettingsStore()).read(),
    ...over,
  });

  // Said rather than guessed: controls drawn before the companion has answered
  // would show the wrong thing selected and then jump, which on a page about
  // microphones is worse than a short wait.
  it("shows no controls until the companion has said something", () => {
    const html = dashboardHTML(t(), { view: "voice" });
    expect(html).not.toContain("data-listen-mode");
    expect(html).not.toContain("data-engine");
    // The command box does not depend on any of that, so it is always there.
    expect(html).toContain("ask-box");
  });

  // The whole point of the move: one screen holds every voice setting, so no
  // two screens can disagree about whether Loaf is listening.
  it("holds every voice control once the state has arrived", () => {
    const html = dashboardHTML(t(), {
      view: "voice",
      // Listening switched on, or the mode picker is correctly absent — see
      // the on/off tests in settingsPanels.
      settings: settingsWith({ voices: ["George"], listenMode: "push" }),
    });
    expect(html).toContain("data-listen-on");
    expect(html).toContain("data-listen-mode");
    expect(html).toContain("data-engine");
    expect(html).toContain("data-voice");
    expect(html).toContain("ask-box");
  });

  it("offers the wake-word field only in the mode that uses one", () => {
    expect(
      dashboardHTML(t(), { view: "voice", settings: settingsWith({ listenMode: "always" }) }),
    ).toContain("data-wake-word");
    expect(
      dashboardHTML(t(), { view: "voice", settings: settingsWith({ listenMode: "push" }) }),
    ).not.toContain("data-wake-word");
  });

  it("offers the hold delay only in hover mode", () => {
    expect(
      dashboardHTML(t(), { view: "voice", settings: settingsWith({ listenMode: "hover" }) }),
    ).toContain("data-hold");
    expect(
      dashboardHTML(t(), { view: "voice", settings: settingsWith({ listenMode: "always" }) }),
    ).not.toContain("data-hold");
  });

  it("names the microphone, and says plainly when there is none", () => {
    expect(
      dashboardHTML(t(), {
        view: "voice",
        settings: settingsWith({ microphone: "Blue Yeti" }),
      }),
    ).toContain("Blue Yeti");
    expect(
      dashboardHTML(t(), { view: "voice", settings: settingsWith({ microphone: null }) }),
    ).toContain("None found");
  });

  it("escapes the device name, like every other value on the page", () => {
    const html = dashboardHTML(t(), {
      view: "voice",
      settings: settingsWith({ microphone: "<script>x</script>" }),
    });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("the settings section", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;
  const state = (): ClosetState => new ClosetSettings(new MemorySettingsStore()).read();

  // These moved out of the closet, which is now only about how anyone looks.
  it("holds the habits and the sound switch", () => {
    const html = dashboardHTML(t(), { view: "settings", settings: state() });
    expect(html).toContain("data-habit");
    expect(html).toContain('data-sound="muted"');
  });

  it("still points at the closet for the things that stayed there", () => {
    const html = dashboardHTML(t(), { view: "settings", settings: state() });
    expect(html).toContain("open:closet");
  });
});

describe("the meetings section", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;
  const snap = (over: Record<string, unknown> = {}) => ({
    recording: false,
    current: null,
    currentSeconds: 0,
    canRecord: true,
    blockedReason: null,
    meetings: [],
    ...over,
  });

  // This window must never state that a microphone is off on the strength of
  // not having heard from the companion yet.
  it("says it is still asking, rather than 'nothing recorded'", () => {
    const html = dashboardHTML(t(), { view: "meetings" });
    expect(html).toContain("Asking Loaf what is recording");
    expect(html).not.toContain("Not recording");
  });

  // The one line that has to be readable from across a room.
  it("states the recording state in words, not by which button is showing", () => {
    expect(
      dashboardHTML(t(), { view: "meetings", meetings: snap({ recording: true, current: "Zoom" }) as never }),
    ).toContain("Recording");
    expect(
      dashboardHTML(t(), { view: "meetings", meetings: snap() as never }),
    ).toContain("Not recording");
  });

  it("offers a manual start, and a stop while it runs", () => {
    expect(dashboardHTML(t(), { view: "meetings", meetings: snap() as never })).toContain(
      'data-loaf-cmd="record:start"',
    );
    expect(
      dashboardHTML(t(), { view: "meetings", meetings: snap({ recording: true }) as never }),
    ).toContain('data-loaf-cmd="record:stop"');
  });

  it("gives the reason instead of a dead button when it cannot record", () => {
    const html = dashboardHTML(t(), {
      view: "meetings",
      meetings: snap({ canRecord: false, blockedReason: "Whisper is not downloaded yet." }) as never,
    });
    expect(html).toContain("Whisper is not downloaded yet.");
    expect(html).not.toContain('data-loaf-cmd="record:start"');
  });

  it("lists what was kept, newest first, with its notes", () => {
    const html = dashboardHTML(t(), {
      view: "meetings",
      meetings: snap({
        meetings: [
          { id: "a", where: "Zoom", startedAt: 1756000000000, seconds: 600, notes: ["older"] },
          { id: "b", where: "Meet", startedAt: 1756900000000, seconds: 900, notes: ["newer"] },
        ],
      }) as never,
    });
    expect(html).toContain("Kept meetings (2)");
    expect(html.indexOf("Meet")).toBeLessThan(html.indexOf("Zoom"));
    expect(html).toContain("newer");
  });

  it("escapes the meeting name and its notes", () => {
    const html = dashboardHTML(t(), {
      view: "meetings",
      meetings: snap({
        meetings: [
          {
            id: "a",
            where: "<script>x</script>",
            startedAt: 1756000000000,
            seconds: 60,
            notes: ["<script>y</script>"],
          },
        ],
      }) as never,
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<script>y</script>");
  });
});

/**
 * The Notes wall — a rebuild from the ground up.
 *
 * The old version of this panel rendered `tasks.visible()`: at most three
 * items, capped for the pet's checklist, and a single 80-character `title`
 * field that anything typed here was silently truncated into. That is a
 * reminder list wearing a notepad's name — which is the exact complaint this
 * rebuild answers. It is now driven by `NoteView`, the full wall the companion
 * broadcasts on `NOTES_CHANGED_EVENT`, with a real body, a fixed colour
 * palette, pinning, and labels.
 */
describe("the notes board", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;

  /** A complete NoteView, so a test can vary one field without restating the rest. */
  const note = (over: Partial<NoteView> = {}): NoteView => ({
    id: "n1",
    title: "A note",
    body: "",
    priority: "soon",
    colour: "default",
    pinned: false,
    done: false,
    labels: [],
    dueAt: null,
    updatedAt: 1_789_200_000_000,
    ...over,
  });

  it("offers a composer even with nothing written down yet", () => {
    const html = dashboardHTML(t(), { view: "notes" });
    expect(html).toContain('id="nt-title"');
    expect(html).toContain('id="nt-body"');
    expect(html).toContain('data-loaf-note="add"');
    expect(html).toContain("Nothing written down yet");
  });

  // What lands in the body is often several sentences; what lands in the
  // title is one short line, the same as the checklist's own title box.
  it("composes a title as an input and a body as a textarea", () => {
    const html = dashboardHTML(t(), { view: "notes" });
    expect(html).toMatch(/<input id="nt-title"/);
    expect(html).toMatch(/<textarea id="nt-body"/);
  });

  // Every panel is in the document at once, so a shared id would mean
  // getElementById returning whichever came first and one box doing nothing.
  it("uses different ids from the checklist composer on Today", () => {
    const html = dashboardHTML(t(), { view: "notes" });
    expect(html.match(/id="nt-title"/g)).toHaveLength(1);
    expect(html.match(/id="tp-title"/g)).toHaveLength(1);
  });

  it("draws one card per note, carrying its priority", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      notes: [
        note({ id: "a", title: "call the bank", priority: "now" }),
        note({ id: "b", title: "tidy the desk", priority: "whenever" }),
      ],
    });
    expect(html).toContain("call the bank");
    expect(html).toContain("nt-card colour-default p-now");
    expect(html).toContain("nt-card colour-default p-whenever");
  });

  // A whole wall, not three cards — the bug this rebuild exists to fix.
  it("shows every note, not just the pet's top three", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      note({ id: `n${i}`, title: `note ${i}` }),
    );
    const html = dashboardHTML(t(), { view: "notes", notes: many });
    for (let i = 0; i < 8; i++) expect(html).toContain(`note ${i}`);
  });

  it("gives a long note room instead of clipping it like a one-liner", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      notes: [note({ body: "x".repeat(300) })],
    });
    expect(html).toContain("nt-card colour-default p-soon long");
  });

  // A title alone, however long, no longer decides "long" — the title is
  // capped at 80 characters same as the checklist's, so a genuinely long note
  // lives in the body.
  it("does not call a note long on title length alone", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      notes: [note({ title: "A note", body: "short" })],
    });
    expect(html).not.toContain(" long");
  });

  it("keeps archive and delete on every card, addressed by real id", () => {
    const html = dashboardHTML(t(), { view: "notes", notes: [note({ id: "abc123" })] });
    expect(html).toContain('data-loaf-task="note-done:abc123"');
    expect(html).toContain('data-loaf-task="note-remove:abc123"');
  });

  it("offers a pin on every card", () => {
    const html = dashboardHTML(t(), { view: "notes", notes: [note({ id: "abc123" })] });
    expect(html).toContain('data-loaf-task="note-pin:abc123"');
  });

  it("marks a pinned note, both in its class and its pin button", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      notes: [note({ id: "p1", pinned: true })],
    });
    expect(html).toContain("nt-card colour-default p-soon pinned");
    expect(html).toMatch(/nt-pin active[^"]*" data-loaf-task="note-pin:p1"/);
  });

  it("dims and strikes through an archived note rather than hiding it", () => {
    const html = dashboardHTML(t(), { view: "notes", notes: [note({ id: "d1", done: true })] });
    expect(html).toContain(" done\">");
    expect(html).toContain("d1");
  });

  it("escapes a note, like every other value on the page", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      notes: [note({ title: "<script>x</script>", body: "<img src=x>" })],
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<img src=x>");
  });

  describe("colour", () => {
    it("carries a colour class from the fixed palette", () => {
      const html = dashboardHTML(t(), { view: "notes", notes: [note({ colour: "sage" })] });
      expect(html).toContain("colour-sage");
    });

    it("uses the plain default colour when none was chosen", () => {
      const html = dashboardHTML(t(), { view: "notes", notes: [note()] });
      expect(html).toContain("colour-default");
    });
  });

  describe("labels", () => {
    it("shows the labels on a card as chips", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ labels: ["work", "urgent"] })],
      });
      expect(html).toContain('<span class="nt-chip">work</span>');
      expect(html).toContain('<span class="nt-chip">urgent</span>');
    });

    it("offers no filter strip when nothing carries a label", () => {
      // bodyOf strips the <style> block, which defines .nt-filters as a
      // selector whether or not anything on the page uses it.
      const html = bodyOf(dashboardHTML(t(), { view: "notes", notes: [note()] }));
      expect(html).not.toContain("nt-filters");
    });

    it("offers a filter strip once something is labelled", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ labels: ["work"] })],
      });
      expect(html).toContain("nt-filters");
      expect(html).toContain('data-loaf-note-filter="work"');
      // "All" clears the filter, so it carries no label of its own.
      expect(html).toContain('data-loaf-note-filter="">All</button>');
    });

    it("marks which chip is active", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ labels: ["work"] })],
        notesFilter: "work",
      });
      expect(html).toMatch(/nt-filter-chip active" data-loaf-note-filter="work"/);
    });

    it("shows only notes carrying the active filter", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [
          note({ id: "a", title: "tagged", labels: ["work"] }),
          note({ id: "b", title: "untagged" }),
        ],
        notesFilter: "work",
      });
      expect(html).toContain("tagged");
      expect(html).not.toContain("untagged");
    });

    it("filters case-insensitively", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "a", title: "tagged", labels: ["Work"] })],
        notesFilter: "work",
      });
      expect(html).toContain("tagged");
    });

    it("says plainly when a filter matches nothing", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ labels: ["work"] })],
        notesFilter: "ghost",
      });
      expect(html).toContain("Nothing here is labelled");
    });
  });

  describe("the editor", () => {
    it("shows a card closed by default", () => {
      // bodyOf strips the <style> block: .nt-editing is defined there as a
      // selector regardless of whether any card on the page is using it.
      const html = bodyOf(dashboardHTML(t(), { view: "notes", notes: [note({ id: "e1" })] }));
      expect(html).not.toContain("nt-editing");
      expect(html).toContain('data-loaf-task="note-open:e1"');
    });

    it("opens the one card whose id matches notesEditing", () => {
      const html = bodyOf(
        dashboardHTML(t(), {
          view: "notes",
          notes: [note({ id: "e1", title: "Editable" }), note({ id: "e2", title: "Closed" })],
          notesEditing: "e1",
        }),
      );
      expect(html).toContain("nt-editing");
      // Only one editor open at a time.
      expect(html.match(/nt-editing/g)).toHaveLength(1);
    });

    it("fills the editor's fields from the note being opened", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "e1", title: "My title", body: "My body" })],
        notesEditing: "e1",
      });
      expect(html).toContain('id="note-edit-title"');
      expect(html).toContain('value="My title"');
      expect(html).toContain('id="note-edit-body"');
      expect(html).toContain("My body");
    });

    it("offers a swatch for every colour in the palette", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "e1" })],
        notesEditing: "e1",
      });
      for (const c of ["default", "butter", "rose", "sage", "sky", "lilac", "clay"]) {
        expect(html).toContain(`data-colour="${c}"`);
      }
    });

    it("marks the note's current colour as the active swatch", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "e1", colour: "rose" })],
        notesEditing: "e1",
      });
      expect(html).toMatch(/nt-swatch nt-swatch-rose active/);
    });

    it("offers a way to remove each label and add a new one", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "e1", labels: ["work"] })],
        notesEditing: "e1",
      });
      expect(html).toContain('data-loaf-task="note-label-remove:e1"');
      expect(html).toContain('data-label="work"');
      expect(html).toContain('id="note-edit-label"');
      expect(html).toContain('data-loaf-task="note-label-add:e1"');
    });

    it("offers Save and Close", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "e1" })],
        notesEditing: "e1",
      });
      expect(html).toContain('data-loaf-task="note-save:e1"');
      expect(html).toContain('data-loaf-task="note-close"');
    });

    it("escapes the values it fills the editor's fields with", () => {
      const html = dashboardHTML(t(), {
        view: "notes",
        notes: [note({ id: "e1", title: '"><script>x</script>' })],
        notesEditing: "e1",
      });
      expect(html).not.toContain("<script>x</script>");
    });
  });
});

describe("the retention control", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;
  const snap = {
    recording: false,
    current: null,
    currentSeconds: 0,
    canRecord: true,
    blockedReason: null,
    meetings: [],
  };
  const settingsWith = (days: number): ClosetState => ({
    ...new ClosetSettings(new MemorySettingsStore()).read(),
    transcriptRetentionDays: days,
  });

  it("is absent until the companion has said what the setting is", () => {
    const html = dashboardHTML(t(), { view: "meetings", meetings: snap as never });
    expect(html).not.toContain("data-retention");
  });

  it("offers every window, with the current one selected", () => {
    const html = dashboardHTML(t(), {
      view: "meetings",
      meetings: snap as never,
      settings: settingsWith(30),
    });
    expect(html).toContain("data-retention");
    expect(html).toMatch(/value="30" selected/);
    expect(html).toContain("Until I delete them");
  });

  // Saying "delete recordings after N days" would imply Loaf had been holding
  // the audio all along. It deletes it the moment it is transcribed.
  it("is worded as keeping words, and says the audio is already gone", () => {
    const html = dashboardHTML(t(), {
      view: "meetings",
      meetings: snap as never,
      settings: settingsWith(90),
    });
    expect(html).toContain("Kept for 90 days");
    expect(html).toContain("not the audio");
  });
});

describe("deleting kept transcripts", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;
  const withMeetings = (n: number) => ({
    recording: false, current: null, currentSeconds: 0,
    canRecord: true, blockedReason: null,
    meetings: Array.from({ length: n }, (_, i) => ({
      id: `m${i}`, where: "Zoom", startedAt: 1756000000000, seconds: 600, notes: [],
    })),
  });

  // There was no way to delete one at all, which made the retention setting
  // the only way to get rid of anything.
  it("puts a delete on every kept transcript", () => {
    const html = dashboardHTML(t(), { view: "meetings", meetings: withMeetings(2) as never });
    expect(html).toContain('data-loaf-forget="m0"');
    expect(html).toContain('data-loaf-forget="m1"');
  });

  it("offers delete-all only when there is something to delete", () => {
    expect(
      dashboardHTML(t(), { view: "meetings", meetings: withMeetings(1) as never }),
    ).toContain('data-loaf-cmd="meetings:forget-all"');
    expect(
      dashboardHTML(t(), { view: "meetings", meetings: withMeetings(0) as never }),
    ).not.toContain('data-loaf-cmd="meetings:forget-all"');
  });

  it("escapes the id, which reaches an attribute", () => {
    const html = dashboardHTML(t(), {
      view: "meetings",
      meetings: {
        ...withMeetings(0),
        meetings: [{ id: '"><script>x</script>', where: "Z", startedAt: 1, seconds: 60, notes: [] }],
      } as never,
    });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("the wake-word badge", () => {
  // Showing "Hey Loaf" to someone who renamed the wake word to "hey mini" is
  // the badge telling them to say the wrong thing.
  it("is a rule about the wake word, tested where the wake word lives", () => {
    expect(wakeWordsFor("mini")[0]).toBe("hey mini");
    expect(wakeWordsFor(null)[0]).toBe("hey loaf");
  });
});

describe("the memory panel", () => {
  const t = () => trackerWith({ Code: 40 }).tracker;
  const mem = (over: Record<string, unknown> = {}) => ({
    people: [{ id: "person:priya", name: "Priya", mentions: 4, lastSeen: 1, linked: ["pricing"] }],
    topics: [{ id: "topic:pricing", name: "pricing", mentions: 6, lastSeen: 1, linked: ["Priya"] }],
    total: 2,
    ...over,
  });

  // Undefined means the companion has not answered. Rendering "no memories"
  // would be a claim this window has not earned.
  it("renders nothing at all before the companion has said anything", () => {
    expect(dashboardHTML(t(), { view: "notes" })).not.toContain("What keeps coming up");
  });

  it("renders nothing when there is genuinely nothing remembered", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      memory: mem({ people: [], topics: [], total: 0 }) as never,
    });
    expect(html).not.toContain("What keeps coming up");
  });

  // A list can already say what you wrote down. Only the connections justify
  // a graph, so they have to be on screen.
  it("shows what each thing connects to, not just a count", () => {
    const html = dashboardHTML(t(), { view: "notes", memory: mem() as never });
    expect(html).toContain("Priya");
    expect(html).toContain("with pricing");
    expect(html).toContain("6×");
  });

  // A memory you cannot audit is one that confidently misremembers.
  it("states how it was built, and what it misses", () => {
    const html = dashboardHTML(t(), { view: "notes", memory: mem() as never });
    expect(html).toContain("no model");
    expect(html).toContain("lower case");
  });

  it("escapes a remembered name, which came from user text", () => {
    const html = dashboardHTML(t(), {
      view: "notes",
      memory: mem({
        people: [{ id: "p", name: "<script>x</script>", mentions: 1, lastSeen: 1, linked: [] }],
      }) as never,
    });
    expect(html).not.toContain("<script>x</script>");
  });
});
