import { describe, it, expect } from "vitest";
import { tabPanel, tidyTabTitle, type TabEntry } from "../src/dashboard/html";

const tab = (title: string, browser = "chrome.exe"): TabEntry => ({ browser, title });

describe("tidying a tab title", () => {
  // "Gmail - Memory usage - 510 MB" is one tab and a remark Chrome is making
  // about itself.
  it("drops Chrome's own memory annotations", () => {
    expect(tidyTabTitle("Gmail - Memory usage - 510 MB")).toBe("Gmail");
    expect(tidyTabTitle("(67) WhatsApp - High memory usage - 935 MB")).toBe("(67) WhatsApp");
  });

  it("leaves an ordinary title alone", () => {
    expect(tidyTabTitle("Workflow runs · yokshith09/LOAFV2-TAURI-")).toBe(
      "Workflow runs · yokshith09/LOAFV2-TAURI-",
    );
    expect(tidyTabTitle("  spaced  ")).toBe("spaced");
  });
});

describe("the tab panel", () => {
  it("lists a row per tab, each with a way to close it", () => {
    const html = tabPanel([tab("One"), tab("Two")], true);
    expect(html).toContain("One");
    expect(html).toContain("Two");
    expect(html).toContain('data-loaf-tabclose="0"');
    expect(html).toContain('data-loaf-tabclose="1"');
  });

  // "No tabs" and "Loaf could not read them" are different answers, and the
  // empty state has to say which.
  it("tells the two empty states apart", () => {
    expect(tabPanel([], true)).toContain("No browser tabs open");
    expect(tabPanel([], false)).toContain("could not read");
    expect(tabPanel([tab("One")], false)).toContain("could not read");
  });

  it("shows the tidied title but keeps the index for closing", () => {
    const html = tabPanel([tab("Gmail - Memory usage - 510 MB")], true);
    expect(html).toContain("Gmail<");
    expect(html).not.toContain("510 MB");
    expect(html).toContain('data-loaf-tabclose="0"');
  });

  it("escapes a title that contains markup", () => {
    const html = tabPanel([tab('<img src=x onerror="alert(1)">')], true);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("grouping by browser", () => {
  // The bug this replaced: Rust used to stop at the first browser window it
  // found, so a flat list was always exactly one browser's tabs. Now every
  // supported browser and every one of its windows is read, and a flat list
  // would misrepresent that as one browser's worth.
  it("shows every browser that has tabs, not just the first", () => {
    const html = tabPanel(
      [tab("Gmail", "chrome.exe"), tab("Docs", "msedge.exe")],
      true,
    );
    expect(html).toContain("Google Chrome");
    expect(html).toContain("Microsoft Edge");
  });

  it("keeps each browser's tabs under its own heading", () => {
    const html = tabPanel(
      [tab("Gmail", "chrome.exe"), tab("Docs", "msedge.exe"), tab("GitHub", "chrome.exe")],
      true,
    );
    const chromeHeading = html.indexOf("Google Chrome");
    const edgeHeading = html.indexOf("Microsoft Edge");
    const github = html.indexOf("GitHub");
    // GitHub is Chrome's second tab, so it appears after Chrome's heading —
    // Edge's tabs (there is one) never get GitHub folded into them.
    expect(chromeHeading).toBeGreaterThanOrEqual(0);
    expect(github).toBeGreaterThan(chromeHeading);
    expect(edgeHeading).toBeGreaterThan(chromeHeading);
  });

  it("falls back to the raw identifier for a browser Loaf does not recognise", () => {
    // Honest rather than silently dropped: an unrecognised process still gets
    // its tabs shown, just without a friendly name.
    const html = tabPanel([tab("Mystery tab", "not_a_real_browser.exe")], true);
    expect(html).toContain("not_a_real_browser.exe");
    expect(html).toContain("Mystery tab");
  });

  it("still numbers rows against the full list, not each group", () => {
    // data-loaf-tabclose addresses tabs[i] in the array Loaf actually holds —
    // renumbering per group would close the wrong tab.
    const html = tabPanel(
      [tab("Gmail", "chrome.exe"), tab("Docs", "msedge.exe")],
      true,
    );
    expect(html).toContain('data-loaf-tabclose="0"');
    expect(html).toContain('data-loaf-tabclose="1"');
  });
});

describe("the tab count", () => {
  it("shows how many are open, not just the rows", () => {
    const html = tabPanel([tab("One"), tab("Two"), tab("Three")], true);
    expect(html).toContain("Browser tabs (3)");
  });

  it("shows zero honestly rather than omitting the count", () => {
    expect(tabPanel([], true)).toContain("Browser tabs (0)");
  });

  it("does not claim a count when it could not read them at all", () => {
    const html = tabPanel([], false);
    expect(html).not.toMatch(/\(\d+\)/);
  });
});
