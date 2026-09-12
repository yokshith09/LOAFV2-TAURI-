/**
 * Which browsers Loaf knows how to ask, and how a host is cleaned up.
 * Ported from `BrowserProbe.swift`.
 */

export type BrowserFlavour =
  | "chromium"
  /** Chrome and every Chromium fork share one AppleScript dictionary. */
  | "safari"
  /**
   * Firefox: no scriptable access to tabs **through AppleScript**. That is a
   * macOS fact, not a universal one — see `canReadTabs`, which is why this is
   * no longer read as "impossible everywhere".
   */
  | "unscriptable";

export interface KnownBrowser {
  /** macOS bundle identifier. What the probe addresses. */
  readonly bundleId: string;
  /** Windows executable name, lowercased. Absent where there is no Windows build. */
  readonly exe?: string;
  /**
   * macOS process name, when it differs from `displayName`.
   *
   * A third identifier for the same browser, and not redundancy: macOS asks
   * "is it running" by process name through System Events, addresses it by
   * bundle id, and Windows knows it by neither.
   */
  readonly proc?: string;
  readonly displayName: string;
  readonly flavour: BrowserFlavour;
}

export const KNOWN_BROWSERS: readonly KnownBrowser[] = [
  { bundleId: "com.google.Chrome", exe: "chrome.exe", displayName: "Google Chrome", flavour: "chromium" },
  { bundleId: "com.google.Chrome.beta", exe: "chrome_beta.exe", proc: "Google Chrome Beta", displayName: "Chrome Beta", flavour: "chromium" },
  { bundleId: "com.google.Chrome.canary", exe: "chrome_canary.exe", proc: "Google Chrome Canary", displayName: "Chrome Canary", flavour: "chromium" },
  { bundleId: "org.chromium.Chromium", exe: "chromium.exe", displayName: "Chromium", flavour: "chromium" },
  { bundleId: "com.brave.Browser", exe: "brave.exe", displayName: "Brave Browser", flavour: "chromium" },
  { bundleId: "com.microsoft.edgemac", exe: "msedge.exe", displayName: "Microsoft Edge", flavour: "chromium" },
  { bundleId: "com.vivaldi.Vivaldi", exe: "vivaldi.exe", displayName: "Vivaldi", flavour: "chromium" },
  { bundleId: "com.operasoftware.Opera", exe: "opera.exe", displayName: "Opera", flavour: "chromium" },
  { bundleId: "com.operasoftware.OperaGX", exe: "opera_gx.exe", displayName: "Opera GX", flavour: "chromium" },
  { bundleId: "company.thebrowser.Browser", exe: "arc.exe", displayName: "Arc", flavour: "chromium" },
  { bundleId: "com.apple.Safari", displayName: "Safari", flavour: "safari" },
  { bundleId: "com.apple.SafariTechnologyPreview", displayName: "Safari Technology Preview", flavour: "safari" },
  // Firefox's macOS process is lowercase, unlike every other browser here.
  { bundleId: "org.mozilla.firefox", exe: "firefox.exe", proc: "firefox", displayName: "Firefox", flavour: "unscriptable" },
];

/**
 * Whether this browser's tabs can be counted **on this operating system**.
 *
 * The distinction matters and getting it wrong cost Firefox users the feature
 * entirely. "Unscriptable" means Firefox publishes no AppleScript dictionary
 * for its tabs — true, and true only on macOS. Windows does not read tabs by
 * scripting the browser at all; it reads the accessibility tree, and Firefox
 * populates that like everything else. So Firefox is unreadable on a Mac and
 * perfectly readable on Windows, and one flag for both platforms was always
 * going to be wrong on one of them.
 *
 * On Windows the real requirement is simply having a known executable name,
 * since that is the only way a process gets matched there.
 */
export function canReadTabs(browser: KnownBrowser, os: string): boolean {
  if (os === "windows") return browser.exe !== undefined;
  return browser.flavour !== "unscriptable";
}

/**
 * What to call this browser when asking the platform about it.
 *
 * Windows matches on the executable, macOS on the bundle identifier. Callers
 * that hand this straight back to the platform stay free of that distinction.
 */
export function probeIdFor(browser: KnownBrowser, os: string): string {
  return os === "windows" ? (browser.exe ?? browser.bundleId) : browser.bundleId;
}

/**
 * What to call this browser when asking the platform whether it is **running**.
 *
 * A different name again from `probeIdFor`: macOS answers "is it running"
 * through System Events, which knows processes by name and not by bundle id.
 * Asking the wrong one gets a confident "no" for a browser sitting right there.
 */
export function runningIdFor(browser: KnownBrowser, os: string): string {
  if (os === "windows") return browser.exe ?? browser.displayName;
  return browser.proc ?? browser.displayName;
}

/**
 * Every browser worth asking the platform about, as the ids it will understand.
 *
 * Deliberately includes browsers whose tabs cannot be read here: a Mac user
 * running Firefox should see it listed and told why it cannot be counted,
 * rather than have Loaf quietly behave as though it were not open.
 */
export function browsersToAskAbout(os: string): readonly { browser: KnownBrowser; id: string }[] {
  return KNOWN_BROWSERS.filter((b) => os !== "windows" || b.exe !== undefined).map((browser) => ({
    browser,
    id: runningIdFor(browser, os),
  }));
}

/**
 * Identify a browser from whatever the platform probe reported as `raw`.
 *
 * THREE SPELLINGS, because three different things call this with three
 * different names for the same browser. Windows gives a full executable path.
 * Loaf's own code passes a bundle identifier. And macOS — despite what this
 * comment used to claim — gives the **process name**: `MacProbe::foreground_app`
 * asks System Events for `name`, so the frontmost browser arrives as
 * "Google Chrome", which matches neither of the other two.
 *
 * That omission was not cosmetic. It made `browserFor` return null for every
 * browser on macOS, so the frontmost app was never recognised as one — and with
 * it went per-site seconds (credited only to the browser in front) and every
 * meeting held in a browser tab, both of which simply never happened on a Mac.
 * Matched case-insensitively, and on the trailing filename for the path case.
 */
export function browserFor(raw: string): KnownBrowser | null {
  const needle = raw.trim().toLowerCase();
  if (needle.length === 0) return null;
  const leaf = needle.split(/[\\/]/).pop() ?? needle;
  return (
    KNOWN_BROWSERS.find(
      (b) =>
        b.bundleId.toLowerCase() === needle ||
        (b.exe !== undefined && b.exe === leaf) ||
        (b.proc ?? b.displayName).toLowerCase() === needle,
    ) ?? null
  );
}

/**
 * Reduce a host to something worth recording, or nothing.
 *
 * Belt-and-braces on top of the truncation the probe already does before the
 * value leaves the browser: drop credentials and any port that survived,
 * lowercase, shed a leading `www.`.
 *
 * The character check at the end is what stops a full URL being recorded if the
 * truncation upstream ever breaks — a string with a slash or a question mark in
 * it is not a host, and the honest answer is to record nothing rather than to
 * store a path in a file that promises it only ever held domains.
 */
export function normaliseDomain(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  // A scheme means this is a URL, not a host, and the port-strip below would
  // turn `chrome://settings` into the domain "chrome" — which then passes every
  // remaining check and gets written to the file as if it were a site you
  // visited. The reference has the same shape and is saved only by its
  // AppleScript filtering to http(s) first; this layer exists for when that
  // does not hold.
  if (host.includes("//")) return null;
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.length === 0) return null;
  return /^[a-z0-9.-]+$/.test(host) ? host : null;
}
