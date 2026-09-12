/**
 * The services Loaf will set up for you in one press.
 *
 * TWO KINDS OF CONNECTION LIVE IN HERE, and the difference is the whole reason
 * this file was rewritten:
 *
 *  - A HOSTED service. Nothing is installed and nothing runs on this computer.
 *    Loaf talks to an address over HTTPS and you sign in with the account you
 *    already have. This is what most people mean by "connect my Notion".
 *  - A PROGRAM on this computer, started by Loaf and spoken to over its own
 *    input and output. This is the older half of MCP, and it is the one that
 *    needs Node.js, an install and a key pasted into a box.
 *
 * The hosted ones are listed first because they are the ones an ordinary person
 * can actually finish.
 *
 * WHY THIS LIST IS STILL SHORT. A row here is Loaf saying "this is worth
 * pressing", and that claim has to be checked rather than assumed:
 *
 *  - Every hosted entry below was verified to publish OAuth discovery AND a
 *    registration endpoint, using Loaf's own `discover` — see
 *    `discovers_a_real_provider` in `oauth.rs`, which fails the build if any of
 *    them stops working. Without a registration endpoint Loaf cannot sign in to
 *    a service it has never met, so a row without one would be a dead button.
 *  - For **Gmail there is still no first-party server**. Google does not publish
 *    one. The community ones each want full access to a mailbox, and Loaf will
 *    not pick a mail server on somebody's behalf. See `MANUAL_ONLY`.
 *
 * Verified against the live services on 12 September 2026.
 */

export interface CatalogEntry {
  /** Stable id, used as the default connection name. */
  readonly id: string;
  /** What to call it in the list. */
  readonly label: string;
  /**
   * The address of a hosted service. Empty for a program on this computer.
   *
   * When this is set the connection needs no install and no pasted key: the
   * sign-in happens in a browser and the token is Loaf's to renew.
   */
  readonly url: string;
  /** The program to run. Empty for a hosted service. */
  readonly command: string;
  readonly args: readonly string[];
  /** Who publishes it — shown, because that is the whole basis for it being here. */
  readonly publisher: string;
  /** One line on what connecting gets you. */
  readonly setup: string;
  /** The numbered steps, for the ones that need something done elsewhere first. */
  readonly steps: readonly string[];
  /** Environment variables this server needs. Secrets; hosted entries need none. */
  readonly envKeys: readonly string[];
  /** Where to get the key, if one is needed. */
  readonly tokenFrom: string;
  /** The note pre-filled on the connection. */
  readonly note: string;
}

/** Whether this is an online service rather than a program on this computer. */
export function isHosted(entry: CatalogEntry): boolean {
  return entry.url.trim() !== "";
}

const HOSTED = {
  command: "",
  args: [] as readonly string[],
  envKeys: [] as readonly string[],
  tokenFrom: "",
  steps: [
    "Press Connect. Loaf adds it and opens your browser.",
    "Sign in to the account you already have and approve the access it asks for.",
    "The browser says you can close it, and the card here says signed in.",
  ] as readonly string[],
};

export const CATALOG: readonly CatalogEntry[] = [
  {
    ...HOSTED,
    id: "notion",
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
    publisher: "Notion",
    setup: "Read and write your Notion pages. Sign in with your Notion account.",
    note: "My Notion pages",
  },
  {
    ...HOSTED,
    id: "linear",
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
    publisher: "Linear",
    setup: "Your issues and projects. Sign in with your Linear account.",
    note: "My Linear issues",
  },
  {
    ...HOSTED,
    id: "asana",
    label: "Asana",
    url: "https://mcp.asana.com/sse",
    publisher: "Asana",
    setup: "Your tasks and projects. Sign in with your Asana account.",
    note: "My Asana tasks",
  },
  {
    ...HOSTED,
    id: "sentry",
    label: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    publisher: "Sentry",
    setup: "Errors and issues from your projects. Sign in with your Sentry account.",
    note: "My Sentry issues",
  },
  {
    id: "files",
    label: "A folder on this computer",
    url: "",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    publisher: "the Model Context Protocol project",
    setup:
      "Not a hosted service — this one runs a program on your computer, so it " +
      "needs Node.js installed.",
    steps: [
      "Decide which single folder this may read. Not your whole home folder.",
      "Add its full path to the end of the arguments box below.",
    ],
    envKeys: [],
    tokenFrom: "",
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
    label: "Gmail and Google Drive",
    why:
      "Google does not publish a hosted MCP server, so there is no account to " +
      "sign in to. The community ones each want full access to your mailbox, and " +
      "Loaf will not pick one for you. If you have one you trust, add it by hand " +
      "below and it works exactly like the rest.",
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

/** Whether anything in the catalog needs Node.js installed to run. */
export function needsNode(entry: CatalogEntry): boolean {
  return entry.command === "npx" || entry.command === "npm" || entry.command === "node";
}

/** The command line as it will actually run, for showing before it is added. */
export function commandLineOf(entry: CatalogEntry): string {
  return isHosted(entry) ? entry.url : [entry.command, ...entry.args].join(" ");
}
