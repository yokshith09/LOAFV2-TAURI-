/**
 * Which browsers Loaf knows how to ask, and how a host is cleaned up.
 * Ported from `BrowserProbe.swift`.
 */

export type BrowserFlavour =
  | "chromium"
  /** Chrome and every Chromium fork share one AppleScript dictionary. */
  | "safari"
  /** Firefox: no scriptable access to tab URLs at all. Not a Loaf limitation. */
  | "unscriptable";

export interface KnownBrowser {
  /** macOS bundle identifier. */
  readonly bundleId: string;
  /** Windows executable name, lowercased. Absent where there is no Windows build. */
  readonly exe?: string;
  readonly displayName: string;
  readonly flavour: BrowserFlavour;
}

export const KNOWN_BROWSERS: readonly KnownBrowser[] = [
  { bundleId: "com.google.Chrome", exe: "chrome.exe", displayName: "Google Chrome", flavour: "chromium" },
  { bundleId: "com.google.Chrome.beta", displayName: "Chrome Beta", flavour: "chromium" },
  { bundleId: "com.google.Chrome.canary", displayName: "Chrome Canary", flavour: "chromium" },
  { bundleId: "com.brave.Browser", exe: "brave.exe", displayName: "Brave Browser", flavour: "chromium" },
  { bundleId: "com.microsoft.edgemac", exe: "msedge.exe", displayName: "Microsoft Edge", flavour: "chromium" },
  { bundleId: "com.vivaldi.Vivaldi", exe: "vivaldi.exe", displayName: "Vivaldi", flavour: "chromium" },
  { bundleId: "com.operasoftware.Opera", exe: "opera.exe", displayName: "Opera", flavour: "chromium" },
  { bundleId: "company.thebrowser.Browser", displayName: "Arc", flavour: "chromium" },
  { bundleId: "com.apple.Safari", displayName: "Safari", flavour: "safari" },
  { bundleId: "com.apple.SafariTechnologyPreview", displayName: "Safari Technology Preview", flavour: "safari" },
  { bundleId: "org.mozilla.firefox", exe: "firefox.exe", displayName: "Firefox", flavour: "unscriptable" },
];

/**
 * Identify a browser from whatever the platform probe reported as `raw`.
 *
 * macOS gives a bundle identifier, Windows an executable path. Matched
 * case-insensitively and on the trailing filename, because the same browser
 * arrives as a full path on one platform and an identifier on the other.
 */
export function browserFor(raw: string): KnownBrowser | null {
  const needle = raw.trim().toLowerCase();
  if (needle.length === 0) return null;
  const leaf = needle.split(/[\\/]/).pop() ?? needle;
  return (
    KNOWN_BROWSERS.find(
      (b) => b.bundleId.toLowerCase() === needle || (b.exe !== undefined && b.exe === leaf),
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
