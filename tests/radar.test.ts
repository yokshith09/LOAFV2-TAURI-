import { describe, it, expect } from "vitest";
import {
  PrivacyRadar,
  CALM_DOWN_MARGIN,
  READING_LIFETIME_MS,
  DENIED_RETRY_MS,
  type SiteLedger,
  type TabAlert,
} from "../src/radar/radar";
import { normaliseDomain, browserFor, KNOWN_BROWSERS } from "../src/radar/domain";
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

  it("reports the worst browser, not the last one asked", () => {
    const { radar } = make(40);
    radar.absorb(CHROME, "Google Chrome", reading(60), 5);
    radar.absorb(SAFARI, "Safari", reading(3), 5);
    expect(radar.tabAlert!.browser).toBe("Google Chrome");
    expect(radar.peakTabsNow).toBe(60);
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
    expect(radar.peakTabsNow).toBeNull();
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
    expect(radar.peakTabsNow).toBeNull();
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
      { available: true, enabled: true, tabThreshold: 40, peakTabsNow: null },
      { available: "yes", enabled: true, tabThreshold: 40, peakTabsNow: null, statusRows: [] },
      { available: true, enabled: true, tabThreshold: NaN, peakTabsNow: null, statusRows: [] },
      { available: true, enabled: true, tabThreshold: 40, peakTabsNow: null, statusRows: {} },
    ]) {
      expect(isRadarSnapshot(junk)).toBe(false);
    }
  });
});
