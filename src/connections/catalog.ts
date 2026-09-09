/**
 * The short list of servers Loaf will fill in for you.
 *
 * WHY THIS IS SHORT, AND WHY GMAIL IS NOT ON IT.
 *
 * The question that produced this file was "can I just select Gmail, or do I
 * have to set it up by hand — think of a user, not me". The honest answer took
 * a look at what actually exists rather than a guess:
 *
 *  - `@modelcontextprotocol/server-github` and `-slack` are **deprecated** on
 *    npm. They install and they are no longer supported, so a one-press button
 *    for either would be Loaf recommending abandoned code.
 *  - For **Gmail there is no first-party server at all**. npm has at least ten
 *    community ones. Any of them may be excellent. Every one of them would
 *    receive full access to the user's mailbox through Google's sign-in.
 *
 * A row in this list is Loaf saying "this is safe to run". Loaf cannot say that
 * about a package it did not write, does not track, and cannot audit — and the
 * blast radius for a mail server is the user's entire correspondence. So the
 * list holds only servers published by the people who own the thing being
 * connected, and everything else stays a deliberate paste by someone who chose
 * it. `MANUAL_ONLY` below explains that in the panel rather than leaving a
 * suspicious gap where Gmail should be.
 *
 * This is the same rule the rest of the product follows: Loaf does not sandbox
 * a connected server and could not, so what it can honestly offer is consent
 * and a record — never a promise that the thing is safe.
 *
 * Verified against the npm registry on 10 September 2026. Anything added here
 * later needs the same check; a deprecated or renamed package in this list is
 * worse than no list, because a button implies somebody looked.
 */

export interface CatalogEntry {
  /** Stable id, used as the default connection name. */
  readonly id: string;
  /** What to call it in the list. */
  readonly label: string;
  /** The program to run. */
  readonly command: string;
  readonly args: readonly string[];
  /** Who publishes it — shown, because that is the whole basis for it being here. */
  readonly publisher: string;
  /** What the user still has to do themselves, in plain words. Empty if nothing. */
  readonly setup: string;
  /** The note pre-filled on the connection. */
  readonly note: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "notion",
    label: "Notion",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    publisher: "Notion",
    setup:
      "Make an internal integration in Notion, share the pages you want with it, " +
      "and put its token in NOTION_TOKEN below.",
    note: "My Notion pages",
  },
  {
    id: "files",
    label: "A folder on this computer",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    publisher: "the Model Context Protocol project",
    setup:
      "Add the folder you want it to see as one more argument. It can read " +
      "everything inside that folder, so pick a narrow one.",
    note: "Files in one folder",
  },
];

/**
 * Things people ask for that are deliberately not one press.
 *
 * Shown in the panel with the reason, because an absence explains nothing and
 * the next thing a user does is assume Loaf cannot do it at all.
 */
export interface ManualOnly {
  readonly label: string;
  readonly why: string;
}

export const MANUAL_ONLY: readonly ManualOnly[] = [
  {
    label: "Gmail",
    why:
      "Google does not publish one, and the community servers each want full " +
      "access to your mailbox. Loaf will not pick one for you — choose one you " +
      "trust and add it below. It works exactly the same once it is added.",
  },
  {
    label: "Slack and GitHub",
    why:
      "The servers most guides point at are marked no longer supported on npm. " +
      "Add a maintained one by hand if you have one.",
  },
];

export function catalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((e) => e.id === id) ?? null;
}

/** The command line as it will actually run, for showing before it is added. */
export function commandLineOf(entry: CatalogEntry): string {
  return [entry.command, ...entry.args].join(" ");
}
