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
  /**
   * The numbered steps, for the ones that need something done elsewhere first.
   *
   * Separate from `setup` because a paragraph is the wrong shape for "go here,
   * press this, copy that". Notion's setup was described in one sentence and was
   * not actually possible from the panel at all — the box it told you to fill in
   * did not exist.
   */
  readonly steps: readonly string[];
  /**
   * Environment variables this server needs, e.g. `NOTION_TOKEN`.
   *
   * These are SECRETS. They go to Rust through the same one-way channel as a
   * bearer token and are never read back into a window.
   */
  readonly envKeys: readonly string[];
  /** Where to get the token, if one is needed. Shown as a link. */
  readonly tokenFrom: string;
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
      "Notion needs its own key before it will let anything in. Four steps, " +
      "once, and the third one is the one people miss.",
    steps: [
      "Open notion.so/my-integrations and press New integration.",
      "Give it a name, pick your workspace, and save it.",
      "Copy the Internal Integration Secret — it starts with ntn_ or secret_.",
      "In Notion, open each page you want Loaf to see, press the ••• menu, " +
        "and Connect to your new integration. Nothing is shared until you do " +
        "this, so a working key with no pages shared reads as an empty Notion.",
    ],
    envKeys: ["NOTION_TOKEN"],
    tokenFrom: "notion.so/my-integrations",
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
    steps: [
      "Decide which single folder this may read. Not your whole home folder.",
      "Add its full path to the end of the arguments box below.",
    ],
    envKeys: [],
    tokenFrom: "",
    note: "Files in one folder",
  },
];

/** Whether anything in the catalog needs Node.js installed to run. */
export function needsNode(entry: CatalogEntry): boolean {
  return entry.command === "npx" || entry.command === "npm" || entry.command === "node";
}

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
