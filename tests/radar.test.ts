import { describe, it, expect } from "vitest";
import {
  PrivacyRadar,
  CALM_DOWN_MARGIN,
  READING_LIFETIME_MS,
  DENIED_RETRY_MS,
  RADAR_SETTINGS_KEY,
  defaultRadarSettings,
  loadRadarSettings,
  saveRadarSettings,
  type SiteLedger,
  type TabAlert,
} from "../src/radar/radar";
import { MemorySettingsStore } from "../src/closet/settings";
import {
  normaliseDomain,
  browserFor,
  browsersToAskAbout,
  canReadTabs,
  probeIdFor,
  runningIdFor,
  KNOWN_BROWSERS,
} from "../src/radar/domain";
import { isRadarSnapshot } from "../src/dashboard/events";
import { unavailableRadar, disabledRadar } from "../src/dashboard/html";

const CHROME = browserFor("com.google.Chrome")!;
const SAFARI = browserFor("com.apple.Safari")!;

class Ledger implements SiteLedger {
  sites: Array<[string, string, number]> = [];
  peaks: number[] = [];
  creditSite(browser: string, domain: string, seconds: number): void {
    this.sites.push([browser, domain, seconds]);
  }
  notePeakTabs(count: number): void {
    this.peaks.push(count);
  }
}

function make(threshold = 40): {
  radar: PrivacyRadar;
  ledger: Ledger;
  advance: (ms: number) => void;
  alerts: TabAlert[];
  calms: number[];
} {
  let clock = 1_800_000_000_000;
  const ledger = new Ledger();
  const radar = new PrivacyRadar(ledger, { now: () => clock });
  radar.settings = { enabled: true, tabThreshold: threshold };
  const alerts: TabAlert[] = [];
  const calms: number[] = [];
  radar.onTantrumBegan = (a) => alerts.push(a);
  radar.onTantrumEnded = (c) => calms.push(c);
  return { radar, ledger, advance: (ms) => (clock += ms), alerts, calms };
}

const reading = (tabCount: number, domain: string | null = "github.com") =>
  ({ kind: "reading", domain, tabCount }) as const;

describe("cleaning up a host", () => {
  it("lowercases, drops www and any surviving port", () => {
    expect(normaliseDomain("WWW.GitHub.com:443")).toBe("github.com");
  });

  it("drops credentials that survived the truncation", () => {
    expect(normaliseDomain("user:pass@example.org")).toBe("example.org");
  });

  it("refuses anything that is not a bare host", () => {
    // The last line of defence. If the in-browser truncation ever breaks, the
    // honest answer is to record nothing rather than to put a path in a file
    // that promises it only ever held domains.
    expect(normaliseDomain("github.com/user/repo")).toBeNull();
    expect(normaliseDomain("github.com?q=secret")).toBeNull();
    expect(normaliseDomain("chrome://settings")).toBeNull();
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain("   ")).toBeNull();
  });

  it("keeps an ordinary subdomain intact", () => {
    expect(normaliseDomain("mail.google.com")).toBe("mail.google.com");
  });
});

describe("identifying a browser", () => {
  it("matches a macOS bundle identifier", () => {
    expect(browserFor("com.google.Chrome")?.displayName).toBe("Google Chrome");
  });

  it("matches a Windows executable, path and all", () => {
    expect(browserFor("C:\\Program Files\\Google\\Chrome\\chrome.exe")?.flavour).toBe(
      "chromium",
    );
    expect(browserFor("/usr/bin/firefox.exe")?.displayName).toBe("Firefox");
  });

  it("is not fooled by something that merely contains a browser's name", () => {
    expect(browserFor("chrome-devtools-helper")).toBeNull();
    expect(browserFor("")).toBeNull();
    expect(browserFor("com.apple.Terminal")).toBeNull();
  });

  it("knows Firefox cannot be read, and says which", () => {
    expect(browserFor("org.mozilla.firefox")?.flavour).toBe("unscriptable");
    expect(KNOWN_BROWSERS.filter((b) => b.flavour === "unscriptable")).toHaveLength(1);
  });
});

describe("naming a browser to the platform", () => {
  const FIREFOX = browserFor("org.mozilla.firefox")!;

  it("reads Firefox on Windows and not on macOS", () => {
    expect(canReadTabs(FIREFOX, "windows")).toBe(true);
    expect(canReadTabs(FIREFOX, "macos")).toBe(false);
    // An unknown platform is treated as "not Windows", which is the cautious
    // reading — better to offer nothing than to promise a count that cannot come.
    expect(canReadTabs(FIREFOX, "")).toBe(false);
  });

  it("addresses it by executable on Windows and bundle id elsewhere", () => {
    expect(probeIdFor(CHROME, "windows")).toBe("chrome.exe");
    expect(probeIdFor(CHROME, "macos")).toBe("com.google.Chrome");
  });

  it("asks whether it is running by process name on macOS", () => {
    // A THIRD name for the same browser, and the reason it is not redundant:
    // System Events knows processes by name, not by bundle id, so asking with
    // the bundle id gets a confident "not running" for a browser sitting there.
    expect(runningIdFor(CHROME, "macos")).toBe("Google Chrome");
    expect(runningIdFor(FIREFOX, "macos")).toBe("firefox");
    expect(runningIdFor(FIREFOX, "windows")).toBe("firefox.exe");
  });

  it("every browser it asks about can be identified from the answer", () => {
    // The round trip that matters: the id sent to the platform has to come back
    // recognisable, or a browser is found running and then dropped on the floor.
    for (const os of ["windows", "macos"]) {
      for (const { browser } of browsersToAskAbout(os)) {
        expect(browserFor(probeIdFor(browser, os))?.bundleId).toBe(browser.bundleId);
      }
    }
  });

  it("offers no browser Windows could never match", () => {
    expect(browsersToAskAbout("windows").every(({ browser }) => browser.exe !== undefined)).toBe(
      true,
    );
    expect(browsersToAskAbout("windows").map(({ browser }) => browser.displayName)).not.toContain(
      "Safari",
    );
  });

  it("still offers a browser it cannot read, so it can say why", () => {
    // A Mac running Firefox should see it listed and told it cannot be counted,
    // not have Loaf behave as though it were closed.
    expect(browsersToAskAbout("macos").map(({ browser }) => browser.displayName)).toContain(
      "Firefox",
    );
  });
});

describe("choosing whether to ask", () => {
  it("asks nothing at all while the radar is off", () => {
    const { radar } = make();
    radar.settings.enabled = false;
    expect(radar.target("com.google.Chrome")).toBeNull();
  });

  it("never asks Firefox, which has no answer to give", () => {
    const { radar } = make();
    expect(radar.target("org.mozilla.firefox")).toBeNull();
  });

  it("does ask Firefox on Windows, where tabs are not read by scripting", () => {
    // "Unscriptable" is a macOS fact: Firefox publishes no AppleScript
    // dictionary for its tabs. Windows never scripts the browser — it reads the
    // accessibility tree, which Firefox fills in like anything else. One flag
    // for both platforms meant Firefox users got nothing on the platform where
    // it works.
    const { radar } = make();
    radar.os = "windows";
    expect(radar.target("firefox.exe")?.displayName).toBe("Firefox");
  });

  it("still refuses a browser it has no Windows executable for", () => {
    const { radar } = make();
    radar.os = "windows";
    expect(radar.target("com.apple.Safari")).toBeNull();
  });

  it("ignores an app that is not a browser", () => {
    const { radar } = make();
    expect(radar.target("com.apple.dt.Xcode")).toBeNull();
  });

  it("leaves a browser alone for a while after it refuses", () => {
    // Re-prompting someone who declined is how an app gets quit.
    const { radar, advance } = make();
    radar.absorb(CHROME, "Google Chrome", { kind: "denied" }, 5);
    expect(radar.target("com.google.Chrome")).toBeNull();

    advance(DENIED_RETRY_MS - 1000);
    expect(radar.target("com.google.Chrome")).toBeNull();

    advance(2000);
    expect(radar.target("com.google.Chrome")).not.toBeNull();
  });
});

describe("what a reading does", () => {
  it("credits the domain and notes the tab count", () => {
    const { radar, ledger } = make();
    radar.absorb(CHROME, "Google Chrome", reading(12, "github.com"), 5);
    expect(ledger.sites).toEqual([["Google Chrome", "github.com", 5]]);
    expect(ledger.peaks).toEqual([12]);
  });

  it("credits nothing for a tick that earned no time", () => {
    // Away from the keyboard means the browser is not earning time either.
    const { radar, ledger } = make();
    radar.absorb(CHROME, "Google Chrome", reading(12), 0);
    expect(ledger.sites).toEqual([]);
    // The tab count is still worth knowing — the tabs are open either way.
    expect(ledger.peaks).toEqual([12]);
  });

  it("counts the tabs of a page it cannot name", () => {
    // A new tab, a PDF, the settings page.
    const { radar, ledger } = make();
    radar.absorb(CHROME, "Google Chrome", reading(9, null), 5);
    expect(ledger.sites).toEqual([]);
    expect(ledger.peaks).toEqual([9]);
  });

  it("refuses to record something that is not a bare host", () => {
    const { radar, ledger } = make();
    radar.absorb(CHROME, "Google Chrome", reading(4, "github.com/private/repo"), 5);
    expect(ledger.sites).toEqual([]);
  });

  it("marks the browser as granted once it answers", () => {
    const { radar } = make();
    radar.absorb(CHROME, "Google Chrome", reading(4), 5);
    expect(radar.statusRows()[0]!.permission).toBe("granted");
  });

  it("does not demote a granted browser that simply has no window open", () => {
    // "No window" is not "refused", and showing a permission error to someone
    // who never saw a prompt sends them to a settings pane for nothing.
    const { radar } = make();
    radar.absorb(CHROME, "Google Chrome", reading(4), 5);
    radar.absorb(CHROME, "Google Chrome", { kind: "unavailable", why: "isn't running" }, 5);
    expect(radar.statusRows()[0]!.permission).toBe("granted");
    expect(radar.statusRows()[0]!.tabCount).toBeNull();
  });
});

describe("the tab tantrum", () => {
  it("starts once past the threshold", () => {
    const { radar, alerts } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(41), 5);
    expect(radar.tabAlert).toEqual({ browser: "Google Chrome", count: 41 });
    expect(alerts).toHaveLength(1);
  });

  it("does not start exactly at the threshold", () => {
    const { radar } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(40), 5);
    expect(radar.tabAlert).toBeNull();
  });

  it("holds inside the hysteresis band rather than flickering", () => {
    // Hovering on the line would otherwise make him alternate between furious
    // and fine every five seconds.
    const { radar, calms } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(41), 5);
    radar.absorb(CHROME, "Google Chrome", reading(38), 5);
    expect(radar.tabAlert).not.toBeNull();
    expect(calms).toHaveLength(0);
    // ...but the number on show stays honest.
    expect(radar.tabAlert!.count).toBe(38);
  });

  it("calms only once well clear of the threshold", () => {
    const { radar, calms } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(41), 5);
    radar.absorb(CHROME, "Google Chrome", reading(40 - CALM_DOWN_MARGIN), 5);
    expect(radar.tabAlert).toBeNull();
    expect(calms).toEqual([34]);
  });

  it("announces the beginning once, not on every tick", () => {
    const { radar, alerts } = make(40);
    for (const n of [41, 42, 43]) radar.absorb(CHROME, "Google Chrome", reading(n), 5);
    expect(alerts).toHaveLength(1);
  });

  it("names the worst browser but counts all of them", () => {
    // The name is the worst offender, so the line has somewhere to point. The
    // NUMBER is every tab open, because that is what the user can see.
    const { radar } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(60), 5);
    radar.absorb(SAFARI, "Safari", reading(3), 5);
    expect(radar.tabAlert!.browser).toBe("Google Chrome");
    expect(radar.tabsOpenNow).toBe(63);
    expect(radar.tabAlert!.count).toBe(63);
  });

  it("fires on the total when no single browser would trip it", () => {
    // THE BUG. Three browsers at 25 tabs is 75 tabs of mess, and a
    // per-browser comparison never noticed because none of them got to 40
    // alone. "The tab tantrum isn't working" was this, every time.
    const { radar, alerts } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(25), 5);
    expect(radar.tabAlert).toBeNull();
    radar.absorb(SAFARI, "Safari", reading(25), 5);
    expect(radar.tabAlert).not.toBeNull();
    expect(radar.tabAlert!.count).toBe(50);
    expect(alerts).toHaveLength(1);
  });

  it("calms on the total coming down, not on one browser closing", () => {
    const { radar, calms } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(30), 5);
    radar.absorb(SAFARI, "Safari", reading(30), 5);
    expect(radar.tabAlert!.count).toBe(60);
    // Safari down to nothing still leaves 30, which is inside the calm margin.
    radar.absorb(SAFARI, "Safari", reading(0), 5);
    expect(radar.tabAlert).toBeNull();
    expect(calms).toEqual([30]);
  });

  it("records the day's peak as a total too", () => {
    // Otherwise "most tabs open at once today" reports one browser's worth and
    // disagrees with the number beside it.
    const { radar, ledger } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(20), 5);
    radar.absorb(SAFARI, "Safari", reading(15), 5);
    expect(ledger.peaks.at(-1)).toBe(35);
  });

  it("never fires when tantrums are switched off", () => {
    const { radar, alerts } = make(0);
    radar.absorb(CHROME, "Google Chrome", reading(500), 5);
    expect(radar.tabAlert).toBeNull();
    expect(alerts).toHaveLength(0);
  });

  it("lets go of a count nobody has confirmed in a while", () => {
    // A browser quit an hour ago must not still hold a tantrum open on the
    // strength of the last number it reported.
    const { radar, advance } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(80), 5);
    expect(radar.tabAlert).not.toBeNull();

    advance(READING_LIFETIME_MS + 1000);
    radar.expireStaleReadings();
    expect(radar.tabAlert).toBeNull();
    expect(radar.tabsOpenNow).toBeNull();
  });

  it("keeps a fresh count through an expiry sweep", () => {
    const { radar, advance } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(80), 5);
    advance(READING_LIFETIME_MS - 1000);
    radar.expireStaleReadings();
    expect(radar.tabAlert).not.toBeNull();
  });
});

describe("the rows the dashboard shows", () => {
  it("lists a running browser it has not spoken to yet as unknown", () => {
    const { radar } = make();
    const rows = radar.statusRows(["com.apple.Safari"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.permission).toBe("unknown");
  });

  it("says Firefox is unsupported, and whose fault that is", () => {
    const { radar } = make();
    const row = radar.statusRows(["org.mozilla.firefox"])[0]!;
    expect(row.permission).toBe("unsupported");
    expect(row.note).toContain("not a Loaf limitation");
  });

  it("lists Firefox as readable on Windows instead of apologising for it", () => {
    const { radar } = make();
    radar.os = "windows";
    const row = radar.statusRows(["firefox.exe"])[0]!;
    expect(row.permission).toBe("unknown");
    expect(row.note).toBeUndefined();
  });

  it("lists every running browser, including ones never spoken to", () => {
    // This list was always accepted and never passed, so a browser that was
    // open but not yet read appeared nowhere at all.
    const { radar } = make();
    radar.absorb(CHROME, "Google Chrome", reading(4), 5);
    const rows = radar.statusRows(["com.google.Chrome", "com.apple.Safari"]);
    expect(rows.map((r) => r.name)).toEqual(["Google Chrome", "Safari"]);
    expect(rows.find((r) => r.name === "Safari")!.tabCount).toBeNull();
  });

  it("does not duplicate a browser it has already spoken to", () => {
    const { radar } = make();
    radar.absorb(CHROME, "Google Chrome", reading(4), 5);
    expect(radar.statusRows(["com.google.Chrome"])).toHaveLength(1);
  });

  it("forgets everything when asked", () => {
    const { radar } = make();
    radar.absorb(CHROME, "Google Chrome", reading(90), 5);
    radar.forget();
    expect(radar.statusRows()).toEqual([]);
    expect(radar.tabAlert).toBeNull();
    expect(radar.tabsOpenNow).toBeNull();
  });
});

describe("the snapshot the dashboard renders from", () => {
  it("accepts the two states the app can actually be in", () => {
    expect(isRadarSnapshot(unavailableRadar())).toBe(true);
    expect(isRadarSnapshot(disabledRadar())).toBe(true);
  });

  it("rejects a payload that would claim domains are being read", () => {
    for (const junk of [
      null,
      "on",
      { available: true, enabled: true, tabThreshold: 40, tabsOpenNow: null },
      { available: "yes", enabled: true, tabThreshold: 40, tabsOpenNow: null, statusRows: [] },
      { available: true, enabled: true, tabThreshold: NaN, tabsOpenNow: null, statusRows: [] },
      { available: true, enabled: true, tabThreshold: 40, tabsOpenNow: null, statusRows: {} },
    ]) {
      expect(isRadarSnapshot(junk)).toBe(false);
    }
  });
});

describe("remembering the choice", () => {
  const store = (seed?: string): MemorySettingsStore => {
    const s = new MemorySettingsStore();
    if (seed !== undefined) s.setItem(RADAR_SETTINGS_KEY, seed);
    return s;
  };

  it("defaults to off when nothing has been stored", () => {
    expect(loadRadarSettings(store())).toEqual(defaultRadarSettings());
  });

  it("survives a round trip, which is the whole point", () => {
    const s = store();
    saveRadarSettings(s, { enabled: true, tabThreshold: 20 });
    expect(loadRadarSettings(s)).toEqual({ enabled: true, tabThreshold: 20 });
  });

  // The asymmetry is deliberate: a bad parse may switch the radar OFF, never on.
  it.each([
    ["not json at all", "{{{"],
    ["a bare string", '"enabled"'],
    ["null", "null"],
    ["an array", "[true]"],
    ["enabled as the string true", '{"enabled":"true"}'],
    ["enabled as 1", '{"enabled":1}'],
  ])("fails closed on %s", (_name, seed) => {
    expect(loadRadarSettings(store(seed)).enabled).toBe(false);
  });

  it("keeps a good threshold even when enabled is junk", () => {
    const got = loadRadarSettings(store('{"enabled":"yes","tabThreshold":25}'));
    expect(got).toEqual({ enabled: false, tabThreshold: 25 });
  });

  it("rejects a nonsense threshold rather than storing it", () => {
    for (const bad of ['{"tabThreshold":-5}', '{"tabThreshold":"40"}']) {
      expect(loadRadarSettings(store(bad)).tabThreshold).toBe(40);
    }
  });

  it("treats 0 as a real threshold, since 0 means never", () => {
    expect(loadRadarSettings(store('{"tabThreshold":0}')).tabThreshold).toBe(0);
  });

  it("does not throw when the store itself is broken", () => {
    const hostile = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    expect(loadRadarSettings(hostile)).toEqual(defaultRadarSettings());
    expect(() => saveRadarSettings(hostile, defaultRadarSettings())).not.toThrow();
  });
});
