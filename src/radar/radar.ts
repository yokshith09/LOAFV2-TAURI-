import { browserFor, normaliseDomain, KNOWN_BROWSERS, type KnownBrowser } from "./domain";
import type { PermissionState } from "../dashboard/html";

/**
 * The privacy radar's state machine. Ported from `PrivacyRadar.swift`.
 *
 * This is the one thing Loaf does that needs a permission, and the whole design
 * is built around asking for as little as possible: the probe returns a bare
 * host and a tab count, never a URL, and the truncation happens inside the
 * browser rather than here. Everything in this file works on what came back.
 *
 * Pure and clock-injected — the probe itself lives behind the platform seam.
 */

/** A reading goes stale after this long without being refreshed. */
export const READING_LIFETIME_MS = 180_000;
/** How long to leave a browser alone after it refused. */
export const DENIED_RETRY_MS = 300_000;
/**
 * Hysteresis on the way down: crossing the threshold starts a tantrum, but he
 * does not calm until you are this far back under it — otherwise hovering on
 * the line makes him flicker between furious and fine.
 */
export const CALM_DOWN_MARGIN = 6;

export interface BrowserStatus {
  readonly name: string;
  readonly bundleId: string;
  readonly permission: PermissionState;
  readonly tabCount: number | null;
  readonly lastSeenMs: number | null;
  readonly note?: string;
  readonly deniedAtMs: number | null;
}

export interface TabAlert {
  readonly browser: string;
  readonly count: number;
}

/** What one look at a browser produced. */
export type ProbeOutcome =
  | { readonly kind: "reading"; readonly domain: string | null; readonly tabCount: number }
  /** The user said no in the permission prompt, or never answered it. */
  | { readonly kind: "denied" }
  /** No windows, an unreadable window, a script error, or a timeout. */
  | { readonly kind: "unavailable"; readonly why: string };

/** Where the radar files its per-domain time. Satisfied by `Tracker`. */
export interface SiteLedger {
  creditSite(browser: string, domain: string, seconds: number): void;
  notePeakTabs(count: number): void;
}

export interface RadarSettings {
  enabled: boolean;
  /** Tabs before the tantrum. 0 = never. */
  tabThreshold: number;
}

export function defaultRadarSettings(): RadarSettings {
  return { enabled: false, tabThreshold: 40 };
}

export class PrivacyRadar {
  private statuses = new Map<string, BrowserStatus>();
  private alert: TabAlert | null = null;
  private readonly now: () => number;

  settings: RadarSettings = defaultRadarSettings();
  onTantrumBegan: ((alert: TabAlert) => void) | null = null;
  onTantrumEnded: ((count: number) => void) | null = null;

  constructor(
    private readonly ledger: SiteLedger,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  get tabAlert(): TabAlert | null {
    return this.alert;
  }

  get peakTabsNow(): number | null {
    const counts = [...this.statuses.values()]
      .map((s) => s.tabCount)
      .filter((c): c is number => c !== null);
    return counts.length === 0 ? null : Math.max(...counts);
  }

  /**
   * Whether the frontmost app is worth asking about right now.
   *
   * Returns null when it is not a known browser, when the radar is off, or when
   * this browser refused recently — a browser that said no is not asked again
   * for five minutes, because re-prompting someone who declined is how an app
   * gets quit.
   */
  target(raw: string): KnownBrowser | null {
    if (!this.settings.enabled) return null;
    const browser = browserFor(raw);
    if (!browser || browser.flavour === "unscriptable") return null;

    const existing = this.statuses.get(browser.bundleId);
    if (existing?.permission === "denied" && existing.deniedAtMs !== null) {
      if (this.now() - existing.deniedAtMs < DENIED_RETRY_MS) return null;
    }
    return browser;
  }

  /** Fold one probe result in, crediting `seconds` to whatever domain it saw. */
  absorb(
    browser: KnownBrowser,
    displayName: string,
    outcome: ProbeOutcome,
    seconds: number,
  ): void {
    const previous = this.statuses.get(browser.bundleId);
    const base: BrowserStatus = previous ?? {
      name: displayName,
      bundleId: browser.bundleId,
      permission: "unknown",
      tabCount: null,
      lastSeenMs: null,
      deniedAtMs: null,
    };

    switch (outcome.kind) {
      case "reading": {
        const domain = outcome.domain === null ? null : normaliseDomain(outcome.domain);
        this.statuses.set(browser.bundleId, {
          ...base,
          name: displayName,
          permission: "granted",
          tabCount: outcome.tabCount,
          lastSeenMs: this.now(),
          note: undefined,
          deniedAtMs: null,
        });
        // Splits time already credited to the browser; never adds to the day.
        if (domain !== null && seconds > 0) {
          this.ledger.creditSite(displayName, domain, seconds);
        }
        if (outcome.tabCount > 0) this.ledger.notePeakTabs(outcome.tabCount);
        break;
      }
      case "denied":
        this.statuses.set(browser.bundleId, {
          ...base,
          name: displayName,
          permission: "denied",
          tabCount: null,
          deniedAtMs: this.now(),
        });
        break;
      case "unavailable":
        this.statuses.set(browser.bundleId, {
          ...base,
          name: displayName,
          // Deliberately NOT demoted to denied: a browser with no window open is
          // not a browser that refused, and treating it as one would put a
          // permission error in front of someone who never saw a prompt.
          permission: base.permission === "granted" ? "granted" : base.permission,
          tabCount: null,
          note: outcome.why,
        });
        break;
    }
    this.evaluateTantrum();
  }

  /**
   * Forget tab counts nobody has confirmed in a while.
   *
   * A browser quit an hour ago should not still be holding a tantrum open on
   * the strength of the last number it reported.
   */
  expireStaleReadings(): void {
    const cutoff = this.now() - READING_LIFETIME_MS;
    let changed = false;
    for (const [id, status] of this.statuses) {
      if (status.tabCount === null) continue;
      if (status.lastSeenMs !== null && status.lastSeenMs < cutoff) {
        this.statuses.set(id, { ...status, tabCount: null });
        changed = true;
      }
    }
    if (changed) this.evaluateTantrum();
  }

  private evaluateTantrum(): void {
    const threshold = this.settings.tabThreshold;
    if (threshold <= 0 || !this.settings.enabled) {
      this.alert = null;
      return;
    }

    let worst: { name: string; count: number } | null = null;
    for (const s of this.statuses.values()) {
      if (s.tabCount === null) continue;
      if (worst === null || s.tabCount > worst.count) {
        worst = { name: s.name, count: s.tabCount };
      }
    }
    if (worst === null) {
      this.alert = null;
      return;
    }

    if (worst.count > threshold) {
      const wasCalm = this.alert === null;
      this.alert = { browser: worst.name, count: worst.count };
      if (wasCalm) this.onTantrumBegan?.(this.alert);
    } else if (worst.count <= threshold - CALM_DOWN_MARGIN) {
      const wasCross = this.alert !== null;
      this.alert = null;
      if (wasCross) this.onTantrumEnded?.(worst.count);
    } else if (this.alert !== null) {
      // Inside the hysteresis band: hold the tantrum, but keep the number honest.
      this.alert = { browser: worst.name, count: worst.count };
    }
  }

  /**
   * Every browser worth reporting on: the ones spoken to, plus any known browser
   * seen running.
   */
  statusRows(running: readonly string[] = []): BrowserStatus[] {
    const rows = new Map(this.statuses);
    for (const raw of running) {
      const browser = browserFor(raw);
      if (!browser || rows.has(browser.bundleId)) continue;
      rows.set(browser.bundleId, {
        name: browser.displayName,
        bundleId: browser.bundleId,
        permission: browser.flavour === "unscriptable" ? "unsupported" : "unknown",
        tabCount: null,
        lastSeenMs: null,
        deniedAtMs: null,
        note:
          browser.flavour === "unscriptable"
            ? "Firefox exposes no way to read tabs — not a Loaf limitation"
            : undefined,
      });
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Wipe what the radar knows. Paired with the tracker forgetting the domains. */
  forget(): void {
    this.statuses.clear();
    this.alert = null;
  }
}

export { KNOWN_BROWSERS };
