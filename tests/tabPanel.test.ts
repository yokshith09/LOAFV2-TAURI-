import { describe, it, expect } from "vitest";
import { tabPanel, tidyTabTitle } from "../src/dashboard/html";

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
    const html = tabPanel(["One", "Two"], true);
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
    expect(tabPanel(["One"], false)).toContain("could not read");
  });

  it("shows the tidied title but keeps the index for closing", () => {
    const html = tabPanel(["Gmail - Memory usage - 510 MB"], true);
    expect(html).toContain("Gmail<");
    expect(html).not.toContain("510 MB");
    expect(html).toContain('data-loaf-tabclose="0"');
  });

  it("escapes a title that contains markup", () => {
    const html = tabPanel(['<img src=x onerror="alert(1)">'], true);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("the tab count", () => {
  it("shows how many are open, not just the rows", () => {
    const html = tabPanel(["One", "Two", "Three"], true);
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
