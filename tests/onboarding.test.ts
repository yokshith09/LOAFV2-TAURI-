import { describe, it, expect } from "vitest";
import { onboardingBody, ONBOARDING_CSS } from "../src/onboarding/view";
import { isDecision, DECISIONS } from "../src/onboarding/events";
import type { BrowserStatus } from "../src/radar/radar";

const status = (name: string, permission: BrowserStatus["permission"]): BrowserStatus => ({
  name,
  bundleId: name,
  permission,
  tabCount: null,
  lastSeenMs: null,
  deniedAtMs: null,
});

describe("the deal", () => {
  it("says what he reads and what he never reads, side by side", () => {
    // The two lists are a comparison. Someone who reads only the first half
    // has read the half that sounds worse.
    const html = onboardingBody({ step: "intro" }, "macos");
    expect(html).toContain("What he reads");
    expect(html).toContain("What he never reads");
    expect(ONBOARDING_CSS).toContain("grid-template-columns:1fr 1fr");
  });

  it("names the thing it will not read, concretely", () => {
    // "No paths" is a policy. "/inbox/msg/1842" is a promise.
    const html = onboardingBody({ step: "intro" }, "macos");
    expect(html).toContain("/inbox/msg/1842");
  });

  it("offers a real no, not a delay", () => {
    const html = onboardingBody({ step: "intro" }, "macos");
    expect(html).toContain('data-onboard="no"');
    expect(html).toContain('data-onboard="yes"');
    expect(html).toContain("Not now keeps everything Loaf already does");
  });
});

describe("telling the truth about how it reads", () => {
  it("says the URL never arrives, where that is true", () => {
    const html = onboardingBody({ step: "intro" }, "macos");
    expect(html).toContain("never reaches Loaf at all");
    expect(html).toContain("Automation prompt");
  });

  it("says the opposite where the opposite is true", () => {
    // This is the screen where blurring the two would matter most: someone is
    // deciding whether to switch it on, and deserves the real sentence.
    const html = onboardingBody({ step: "intro" }, "windows");
    expect(html).toContain("address bar");
    expect(html).toContain("while you're typing");
    expect(html).not.toContain("never reaches Loaf at all");
  });

  it("does not promise a permission prompt that will not appear", () => {
    const html = onboardingBody({ step: "intro" }, "windows");
    expect(html).not.toContain("Automation prompt");
    expect(html).toContain("No permission prompt is involved");
  });

  it("says plainly that nothing stands in the way on Windows", () => {
    // The flattering version of this sentence would be to leave it out.
    expect(onboardingBody({ step: "intro" }, "windows")).toContain(
      "nothing stands between Loaf and the address bar",
    );
  });
});

describe("while it is asking", () => {
  it("describes the prompt the user is about to see, on macOS", () => {
    expect(onboardingBody({ step: "asking" }, "macos")).toContain("Asking your browsers");
  });

  it("does not describe a prompt that never happens, on Windows", () => {
    const html = onboardingBody({ step: "asking" }, "windows");
    expect(html).not.toContain("Asking your browsers");
    expect(html).not.toContain("permission prompt");
  });
});

describe("what happened", () => {
  it("lists the browsers it can read", () => {
    const html = onboardingBody(
      { step: "done", statuses: [status("Google Chrome", "granted")] },
      "macos",
    );
    expect(html).toContain("Reading:");
    expect(html).toContain("Google Chrome");
  });

  it("lists the ones that refused, and how to undo that on macOS", () => {
    const html = onboardingBody(
      { step: "done", statuses: [status("Safari", "denied")] },
      "macos",
    );
    expect(html).toContain("Declined:");
    expect(html).toContain('data-onboard="settings"');
    expect(html).toContain("System Settings");
  });

  it("does not send a Windows user to a macOS settings pane", () => {
    const html = onboardingBody(
      { step: "done", statuses: [status("Microsoft Edge", "denied")] },
      "windows",
    );
    expect(html).not.toContain("System Settings");
    expect(html).not.toContain('data-onboard="settings"');
  });

  it("says so when there was nothing open to look at", () => {
    // Rather than an empty screen that reads as a failure.
    const html = onboardingBody({ step: "done", statuses: [] }, "macos");
    expect(html).toContain("No browsers were open");
  });

  it("ignores browsers it has not made up its mind about", () => {
    const html = onboardingBody(
      { step: "done", statuses: [status("Firefox", "unsupported"), status("Arc", "unknown")] },
      "macos",
    );
    expect(html).not.toContain("Reading:");
    expect(html).not.toContain("Declined:");
    expect(html).toContain("No browsers were open");
  });

  it("escapes a browser name, which came from the OS", () => {
    const html = onboardingBody(
      { step: "done", statuses: [status("<img onerror=x>", "granted")] },
      "macos",
    );
    expect(html).not.toContain("<img onerror");
  });
});

describe("the answer that crosses the bus", () => {
  it("accepts the four buttons and nothing else", () => {
    // This payload turns on the only feature that reads anything outside the
    // app, so it is one word from a fixed list or it is refused.
    for (const d of DECISIONS) expect(isDecision(d)).toBe(true);
    for (const junk of ["", "YES", "enable", null, 1, {}]) {
      expect(isDecision(junk)).toBe(false);
    }
  });
});

describe("no inline script anywhere", () => {
  it("carries none, in any state", () => {
    const states = [
      onboardingBody({ step: "intro" }, "macos"),
      onboardingBody({ step: "asking" }, "macos"),
      onboardingBody({ step: "done", statuses: [status("Safari", "denied")] }, "macos"),
    ];
    for (const html of states) {
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/\son[a-z]+=/);
    }
  });
});
