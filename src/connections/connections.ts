/**
 * The Connections tab: other programs the user has attached to Loaf.
 *
 * THE PANEL HAS TO SAY WHAT IT IS BEFORE IT LETS YOU DO IT. Every other screen
 * in this app describes something Loaf did on its own machine. This one hands
 * data to a program Loaf did not write and cannot see inside, and the honest
 * version of that sentence is at the top of the page rather than in a tooltip.
 *
 * Everything here is a pure function of state to HTML, with no `invoke` and no
 * DOM. That is not tidiness — the interesting cases are a server that is
 * configured but not running, a key that is set but must never be shown, and a
 * call that failed after sending its arguments anyway. Each of those is a
 * rendering decision, and rendering decisions that live in an event handler are
 * decisions nobody tests.
 */

import { escapeHTML } from "../dashboard/html";
import {
  CATALOG,
  MANUAL_ONLY,
  catalogEntry,
  commandLineOf,
  needsNode,
  type CatalogEntry,
} from "./catalog";

/** A server as Rust is willing to describe it. Never carries a secret. */
export interface ServerView {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly note: string;
  /** Names of the environment variables set for it. Names only. */
  readonly env_keys: readonly string[];
  /**
   * The address, for a remote server. Empty for a local one.
   *
   * A remote server is the shape an ordinary person can actually set up: one
   * address, a sign-in, nothing installed. See `remote.rs`.
   */
  readonly url?: string;
  /** Whether a token is stored. Never the token — there is no reveal. */
  readonly has_token?: boolean;
}

/**
 * One thing Loaf checks on its own. Mirrors `watch.rs`.
 *
 * `enabled` is separate from existing so a watch can be paused without being
 * described again — the interval and the wording are the fiddly part to retype.
 */
export interface Watch {
  readonly server: string;
  readonly tool: string;
  readonly arguments: string;
  readonly every_seconds: number;
  readonly say: string;
  readonly enabled: boolean;
}

/**
 * Checked on the way in, like every other shape that crosses the bridge.
 *
 * A watch decides that Loaf starts a program on a timer, so a malformed one is
 * dropped rather than half-trusted — the same rule the server list follows.
 */
export function isWatch(v: unknown): v is Watch {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  return (
    typeof w.server === "string" &&
    typeof w.tool === "string" &&
    typeof w.arguments === "string" &&
    typeof w.every_seconds === "number" &&
    Number.isFinite(w.every_seconds) &&
    typeof w.say === "string" &&
    typeof w.enabled === "boolean"
  );
}

/** How often a watch may run, offered as the few intervals anyone wants. */
export const WATCH_INTERVALS: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: 60, label: "every minute" },
  { seconds: 300, label: "every 5 minutes" },
  { seconds: 900, label: "every 15 minutes" },
  { seconds: 3600, label: "every hour" },
];

/** The watch on this tool, if there is one. */
export function watchFor(
  watches: readonly Watch[],
  server: string,
  tool: string,
): Watch | null {
  return watches.find((w) => w.server === server && w.tool === tool) ?? null;
}

/** One thing Loaf sent to a server. */
export interface CallRecord {
  readonly server: string;
  readonly tool: string;
  readonly arguments: string;
  /** Seconds since the epoch. */
  readonly at: number;
  readonly ok: boolean;
}

export interface ConnectionsState {
  readonly servers: readonly ServerView[];
  /** Which are running right now. A subset of `servers` by name. */
  readonly running: readonly string[];
  /** Tools we have asked for and been told, by server name. */
  readonly tools: Readonly<Record<string, readonly string[]>>;
  /** What went wrong last, by server name. */
  readonly errors: Readonly<Record<string, string>>;
  /**
   * Why the server LIST itself could not be read, if it could not.
   *
   * Separate from `errors`, which are per-server: this is the case where Rust
   * refused the whole config file, and there is no server to hang the message
   * on. It used to be swallowed into an empty list, so a config with one stray
   * comma rendered as "Nothing is connected yet" — which reads as "add
   * something" rather than "the file you already have cannot be parsed".
   */
  readonly listError: string;
  readonly calls: readonly CallRecord[];
  /** What Loaf checks on its own. Empty until the user makes one. */
  readonly watches: readonly Watch[];
  /** Whether the add form is open. */
  readonly adding: boolean;
  /**
   * Which catalog entry the user pressed, if any.
   *
   * Needed because the form now shows that entry's setup steps and its own
   * secret boxes. Pressing a preset used to only shove text into the inputs and
   * be forgotten, so the form had no way to know that this particular server
   * wants a NOTION_TOKEN.
   */
  readonly pickedCatalog: string | null;
  /**
   * The tool the user has opened, if any.
   *
   * WHY THIS EXISTS AT ALL. Every piece of the MCP client was built and
   * finished — connect, list the tools, call one, write down what was sent —
   * and then nothing in the app ever called it, so the whole half was dead.
   * A tool name was a label. This makes it a button, which is the smallest
   * thing that turns a client nobody can reach into one somebody can.
   */
  readonly picked: { readonly server: string; readonly tool: string } | null;
  /**
   * What is in the arguments box.
   *
   * Kept in state rather than read off the textarea, because the panel
   * re-renders on every change and a re-render would otherwise wipe what the
   * user had typed.
   */
  readonly argsDraft: string;
  /** What came back from the last call, or the reason it failed. */
  readonly result: string;
  /** True while a call is in flight, so the button cannot be pressed twice. */
  readonly calling: boolean;
}

export const EMPTY_CONNECTIONS: ConnectionsState = {
  servers: [],
  running: [],
  tools: {},
  errors: {},
  listError: "",
  calls: [],
  watches: [],
  adding: false,
  pickedCatalog: null,
  picked: null,
  argsDraft: "{}",
  result: "",
  calling: false,
};

/**
 * Validate a server as it comes back across the bridge.
 *
 * Checked rather than trusted for the same reason the radar snapshot is: this
 * shape decides what a page tells the user is attached to their machine.
 */
export function isServerView(v: unknown): v is ServerView {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.name === "string" &&
    typeof s.command === "string" &&
    Array.isArray(s.args) &&
    s.args.every((a) => typeof a === "string") &&
    typeof s.note === "string" &&
    Array.isArray(s.env_keys) &&
    s.env_keys.every((k) => typeof k === "string") &&
    // Optional, because a config written by an older build has neither.
    (s.url === undefined || typeof s.url === "string") &&
    (s.has_token === undefined || typeof s.has_token === "boolean")
  );
}

export function isCallRecord(v: unknown): v is CallRecord {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.server === "string" &&
    typeof c.tool === "string" &&
    typeof c.arguments === "string" &&
    typeof c.at === "number" &&
    Number.isFinite(c.at) &&
    typeof c.ok === "boolean"
  );
}

/**
 * Split a typed argument string the way a shell would, near enough.
 *
 * MCP servers are almost always launched as `npx -y some-server --flag value`,
 * and asking for a JSON array of strings in a text box is asking the wrong
 * person to think about quoting. Quotes are honoured because a path with a
 * space in it is the normal case on Windows, and splitting `C:\Program
 * Files\x.exe` into two arguments produces a server that will not start and no
 * clue as to why.
 *
 * Deliberately NOT a shell: no globs, no variable expansion, no pipes. The
 * string never reaches a shell — Rust passes the pieces straight to the process
 * — so anything cleverer here would be a lie about what happens next.
 */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/** How long ago, in words, for the call log. */
export function relativeWhen(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - at);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** The command line as it will actually be run, for the user to check. */
/** Whether this card is a remote server. */
export function isRemote(server: ServerView): boolean {
  const url = server.url ?? "";
  return url.startsWith("http://") || url.startsWith("https://");
}

export function commandLine(server: ServerView): string {
  return [server.command, ...server.args].join(" ");
}

/**
 * The paragraph at the top, which does not get to be optional.
 *
 * It says the same thing whether or not anything is connected, because the
 * moment to understand what connecting means is before you do it.
 */
function disclosure(): string {
  return (
    `<div class="mcp-note">` +
    `<h3>What connecting actually does</h3>` +
    `<p>A connection is <strong>another program on this computer</strong> that Loaf starts ` +
    `and sends things to. It can do anything that program can do, including making network ` +
    `calls Loaf cannot see, to services Loaf has never heard of. Loaf does not sandbox it ` +
    `and could not.</p>` +
    `<p>So: nothing is connected unless you add it, nothing is started until something uses ` +
    `it, and every call is written down below — what was sent, to whom, and when. That log ` +
    `stays on this machine. It is the part of the promise Loaf can still keep.</p>` +
    `</div>`
  );
}

function toolsBlock(name: string, state: ConnectionsState): string {
  const error = state.errors[name];
  if (error) {
    return `<p class="mcp-error">${escapeHTML(error)}</p>`;
  }
  const tools = state.tools[name];
  if (!tools) return "";
  if (tools.length === 0) {
    return `<p class="mcp-empty">It started, and offers no tools.</p>`;
  }
  const chips = tools
    .map((t) => {
      const on = state.picked?.server === name && state.picked.tool === t;
      return (
        `<button class="mcp-tool${on ? " on" : ""}" ` +
        `data-mcp-pick="${escapeHTML(name)}" data-mcp-tool="${escapeHTML(t)}">` +
        `${escapeHTML(t)}</button>`
      );
    })
    .join("");
  return `<div class="mcp-tools">${chips}</div>${runBlock(name, state)}`;
}

/**
 * The form that actually sends something to another program.
 *
 * ARGUMENTS ARE TYPED AS JSON, ON PURPOSE. A tool's arguments are whatever its
 * author decided, and MCP does not promise a shape Loaf could build a form
 * from. Guessing one would be wrong for most servers and would quietly stop
 * working when a server changed. A text box is honest about what this is: the
 * raw call, for someone who has read that server's documentation.
 *
 * The result is shown as text and never as HTML. It comes from a program Loaf
 * did not write, which is the whole point of the panel and exactly why its
 * output does not get to choose markup.
 */
function runBlock(name: string, state: ConnectionsState): string {
  if (state.picked?.server !== name) return "";
  const tool = state.picked.tool;
  return (
    `<div class="mcp-run">` +
    `<label class="mcp-run-label" for="mcp-args">Arguments for <code>${escapeHTML(tool)}</code>, as JSON</label>` +
    `<textarea id="mcp-args" class="mcp-args" rows="3" spellcheck="false">${escapeHTML(
      state.argsDraft,
    )}</textarea>` +
    `<div class="mcp-actions">` +
    `<button class="mcp-btn" data-mcp-run="1"${state.calling ? " disabled" : ""}>` +
    (state.calling ? "Sending…" : "Send it") +
    `</button>` +
    `<button class="mcp-btn" data-mcp-cancel="1">Close</button>` +
    `</div>` +
    (state.result ? `<pre class="mcp-result">${escapeHTML(state.result)}</pre>` : "") +
    watchBlock(name, tool, state) +
    `</div>`
  );
}

/**
 * Turning one call into something Loaf does on its own.
 *
 * Deliberately attached to a tool the user has just RUN, rather than being its
 * own screen. Watching a tool you have never called is how you end up with a
 * watch whose arguments were wrong from the start, failing quietly every
 * minute — and the arguments box directly above is the one that was proven to
 * work seconds ago.
 *
 * The wording is the user's because Loaf cannot summarise what came back. It
 * knows the bytes differ, and inventing "you have 3 new emails" from that
 * would be exactly the guessing this project keeps refusing.
 */
function watchBlock(server: string, tool: string, state: ConnectionsState): string {
  const existing = watchFor(state.watches, server, tool);
  const options = WATCH_INTERVALS.map(
    (i) =>
      `<option value="${i.seconds}"${
        existing && existing.every_seconds === i.seconds ? " selected" : ""
      }>${escapeHTML(i.label)}</option>`,
  ).join("");

  return (
    `<div class="mcp-watch">` +
    `<h4 class="mcp-watch-head">Have Loaf check this for you</h4>` +
    `<p class="mcp-watch-note">Loaf calls it on a timer and says something only when the ` +
    `answer changes. Every check is in the log below. The first check is silent — it is ` +
    `what the rest are compared against.</p>` +
    `<label class="mcp-run-label" for="watch-say">What Loaf should say</label>` +
    `<input id="watch-say" class="mcp-args" type="text" placeholder="You have new mail." ` +
    `value="${escapeHTML(existing?.say ?? "")}">` +
    `<div class="mcp-actions">` +
    `<select id="watch-every" class="mcp-every">${options}</select>` +
    (existing
      ? `<button class="mcp-btn" data-mcp-watch-off="1">Stop checking</button>`
      : "") +
    `<button class="mcp-btn" data-mcp-watch-on="1">` +
    (existing ? "Save changes" : "Start checking") +
    `</button>` +
    `</div>` +
    (existing?.enabled ? `<p class="mcp-watch-on">Checking ${escapeHTML(intervalLabel(existing.every_seconds))}.</p>` : "") +
    `</div>`
  );
}

function intervalLabel(seconds: number): string {
  return WATCH_INTERVALS.find((i) => i.seconds === seconds)?.label ?? `every ${seconds}s`;
}

function serverCard(server: ServerView, state: ConnectionsState): string {
  const running = state.running.includes(server.name);
  const status = running
    ? `<span class="mcp-dot on" title="Running"></span>running`
    : `<span class="mcp-dot"></span>not started`;

  // Keys are listed so the user can see a credential is stored without the
  // window ever being handed one. There is no "reveal" and there will not be.
  const keys = server.env_keys.length
    ? `<p class="mcp-keys">Environment: ` +
      server.env_keys
        .map((k) => `<code>${escapeHTML(k)}</code> <span class="mcp-set">set</span>`)
        .join(", ") +
      `</p>`
    : "";

  return (
    `<div class="mcp-card" data-mcp-server="${escapeHTML(server.name)}">` +
    `<div class="mcp-head">` +
    `<span class="mcp-name">${escapeHTML(server.name)}</span>` +
    `<span class="mcp-status">${status}</span>` +
    `</div>` +
    // A remote server has no command line to show, and showing an empty one
    // made a correctly configured connection look broken.
    (isRemote(server)
      ? `<code class="mcp-cmd">${escapeHTML(server.url ?? "")}</code>` +
        `<p class="mcp-keys">Remote server` +
        (server.has_token ? ` &middot; <span class="mcp-set">signed in</span>` : "") +
        `</p>`
      : `<code class="mcp-cmd">${escapeHTML(commandLine(server))}</code>`) +
    (server.note ? `<p class="mcp-desc">${escapeHTML(server.note)}</p>` : "") +
    keys +
    `<div class="mcp-actions">` +
    `<button class="mcp-btn" data-mcp-tools="${escapeHTML(server.name)}">` +
    (state.tools[server.name] ? "Check again" : "Start it and list its tools") +
    `</button>` +
    (running
      ? `<button class="mcp-btn" data-mcp-stop="${escapeHTML(server.name)}">Stop it</button>`
      : "") +
    `<button class="mcp-btn danger" data-mcp-remove="${escapeHTML(server.name)}">Remove</button>` +
    `</div>` +
    toolsBlock(server.name, state) +
    `</div>`
  );
}

/**
 * The steps for whichever catalog entry was picked, if any.
 *
 * Shown inside the form rather than on the pick button, because they describe
 * what to go and do BEFORE pressing Add, and the button is gone by then.
 */
function setupSteps(entry: CatalogEntry | null): string {
  if (!entry || entry.steps.length === 0) return "";
  const steps = entry.steps.map((s) => `<li>${escapeHTML(s)}</li>`).join("");
  return (
    `<div class="mcp-steps">` +
    `<h4 class="mcp-watch-head">Setting up ${escapeHTML(entry.label)}</h4>` +
    (entry.setup ? `<p class="mcp-watch-note">${escapeHTML(entry.setup)}</p>` : "") +
    `<ol class="mcp-steplist">${steps}</ol>` +
    (entry.tokenFrom
      ? `<p class="mcp-fine">The key comes from <code>${escapeHTML(entry.tokenFrom)}</code>.</p>`
      : "") +
    `</div>`
  );
}

/**
 * A box for each secret this server needs.
 *
 * These did not exist, and their absence made the one catalog entry that needs a
 * key impossible to finish in the app: the Notion row said to put a token in
 * NOTION_TOKEN, and there was nowhere to put it. The only route was to open the
 * config file and hand-write JSON, which is not a thing the panel should be
 * telling an ordinary person to do.
 *
 * The value takes the same one-way path as a bearer token — into Rust's config,
 * never read back out to a window.
 */
function envFields(entry: CatalogEntry | null): string {
  if (!entry || entry.envKeys.length === 0) return "";
  return entry.envKeys
    .map(
      (key) =>
        `<label>${escapeHTML(key)}` +
        `<input id="mcp-new-env-${escapeHTML(key)}" data-mcp-env="${escapeHTML(key)}" ` +
        `type="password" autocomplete="off" maxlength="400" ` +
        `placeholder="paste the key here"></label>`,
    )
    .join("");
}

function addForm(open: boolean, entry: CatalogEntry | null): string {
  if (!open) {
    return `<button class="mcp-add" data-mcp-add-open="1">+ Add a connection</button>`;
  }
  return (
    `<div class="mcp-form">` +
    pickList(entry) +
    setupSteps(entry) +
    `<label>What to call it<input id="mcp-new-name" placeholder="granola" maxlength="40"></label>` +
    `<label>Program to run<input id="mcp-new-cmd" placeholder="npx" maxlength="200"></label>` +
    `<label>Arguments<input id="mcp-new-args" placeholder="-y granola-mcp" maxlength="400"></label>` +
    envFields(entry) +
    `<p class="mcp-fine"><b>Or</b> a remote server, which installs nothing:</p>` +
    `<label>Address<input id="mcp-new-url" placeholder="https://example.com/mcp" maxlength="400"></label>` +
    `<label>Token, if it needs one<input id="mcp-new-token" type="password" ` +
    `placeholder="leave empty if it does not" maxlength="400" autocomplete="off"></label>` +
    `<label>What it is for<input id="mcp-new-note" placeholder="my meeting notes" maxlength="120"></label>` +
    `<p class="mcp-fine">Nothing is started by saving this. Keys typed above go ` +
    `straight into the config file Rust owns; this window is never able to read ` +
    `one back.</p>` +
    `<div class="mcp-actions">` +
    `<button class="mcp-btn primary" data-mcp-add-save="1">Add it</button>` +
    `<button class="mcp-btn" data-mcp-add-cancel="1">Cancel</button>` +
    `</div></div>`
  );
}

/**
 * The few servers Loaf will fill in for you, and an honest note about the rest.
 *
 * Pressing one fills the boxes below rather than adding it — the user still
 * sees the exact command before anything is saved, and can change it. A list
 * that added a server on one press would be Loaf running somebody else's
 * program because a name was clicked.
 *
 * The "not on this list" part is shown rather than omitted. An absence explains
 * nothing, and the next thing anyone concludes from a missing Gmail row is that
 * Loaf cannot do Gmail at all — when the real answer is that Loaf will not pick
 * a mail server on your behalf. See catalog.ts.
 */
function pickList(picked: CatalogEntry | null): string {
  const rows = CATALOG.map(
    (e) =>
      `<button class="mcp-pick${picked?.id === e.id ? " chosen" : ""}" ` +
      `data-mcp-pick-server="${escapeHTML(e.id)}">` +
      `<span class="mcp-pick-name">${escapeHTML(e.label)}</span>` +
      `<span class="mcp-pick-by">by ${escapeHTML(e.publisher)}</span>` +
      `<code>${escapeHTML(commandLineOf(e))}</code>` +
      (needsNode(e) ? `<span class="mcp-pick-needs">needs Node.js</span>` : "") +
      `</button>`,
  ).join("");

  const manual = MANUAL_ONLY.map(
    (m) =>
      `<li><b>${escapeHTML(m.label)}</b> &mdash; ${escapeHTML(m.why)}</li>`,
  ).join("");

  return (
    `<div class="mcp-picks">` +
    `<h4 class="mcp-watch-head">Start from one of these</h4>` +
    `<p class="mcp-watch-note">Only servers published by the people who own the ` +
    `thing being connected. Pressing one fills in the boxes; nothing runs until ` +
    `you add it.</p>` +
    `<div class="mcp-pick-row">${rows}</div>` +
    `<p class="mcp-watch-note">Not on this list, on purpose:</p>` +
    `<ul class="mcp-manual">${manual}</ul>` +
    `</div>`
  );
}

function callLog(calls: readonly CallRecord[], now: number): string {
  if (calls.length === 0) {
    return (
      `<h2>What has been sent</h2>` +
      `<p class="mcp-empty">Nothing has been sent to anything. This fills in the moment it is.</p>`
    );
  }
  // Newest first: the question a log answers is almost always "what just
  // happened", and the file is appended to, so it arrives the wrong way round.
  const rows = [...calls]
    .reverse()
    .slice(0, 50)
    .map(
      (c) =>
        `<div class="mcp-call${c.ok ? "" : " failed"}">` +
        `<div class="mcp-call-head">` +
        `<strong>${escapeHTML(c.server)}</strong> · ${escapeHTML(c.tool)}` +
        `<span class="mcp-when">${escapeHTML(relativeWhen(c.at, now))}` +
        (c.ok ? "" : " · failed") +
        `</span></div>` +
        `<code class="mcp-args">${escapeHTML(c.arguments)}</code>` +
        `</div>`,
    )
    .join("");
  return (
    `<h2>What has been sent</h2>` +
    `<p class="mcp-fine">Newest first, kept on this machine, last 500 calls. ` +
    `A failed call still sent its arguments, so it is listed too.</p>` +
    `<div class="mcp-log">${rows}</div>`
  );
}

/** The whole tab. */
export function connectionsPanel(state: ConnectionsState, now: number): string {
  // "Could not read the list" and "the list is empty" are different facts, and
  // showing the second when the first is true sends someone off adding a
  // connection they already have.
  const list = state.listError
    ? `<p class="mcp-error">Loaf could not read its list of connections: ` +
      `${escapeHTML(state.listError)}. Nothing has been lost — open the config ` +
      `file below and fix it, or remove the broken entry.</p>`
    : state.servers.length
      ? state.servers.map((s) => serverCard(s, state)).join("")
      : `<p class="mcp-empty">Nothing is connected. Loaf is talking to no other program.</p>`;

  return (
    `<h2>Connections</h2>` +
    disclosure() +
    list +
    addForm(state.adding, state.pickedCatalog === null ? null : catalogEntry(state.pickedCatalog)) +
    `<button class="mcp-btn" data-mcp-config="1">Open the config file</button>` +
    callLog(state.calls, now)
  );
}

export const CONNECTIONS_CSS = `
.mcp-note{border:1px solid var(--line);border-left:3px solid #c9822f;border-radius:10px;
  padding:12px 14px;margin:0 0 16px}
.mcp-note h3{margin:0 0 6px;font-size:13px}
.mcp-note p{margin:0 0 8px;font-size:12px;line-height:1.5;opacity:.85}
.mcp-note p:last-child{margin-bottom:0}
.mcp-card{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px}
.mcp-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.mcp-name{font-weight:600}
.mcp-status{font-size:11px;opacity:.7;display:flex;align-items:center;gap:5px}
.mcp-dot{width:7px;height:7px;border-radius:50%;background:#8a8a8a;display:inline-block}
.mcp-dot.on{background:#4caf50}
.mcp-cmd{display:block;font-size:11px;opacity:.75;margin:6px 0;word-break:break-all}
.mcp-desc{margin:4px 0;font-size:12px}
.mcp-keys{margin:4px 0;font-size:11px;opacity:.8}
.mcp-set{opacity:.6;font-style:italic}
.mcp-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.mcp-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;
  border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
.mcp-btn:hover{background:rgba(127,127,127,.12)}
.mcp-btn.danger{opacity:.7}
.mcp-btn.primary{border-color:#c9822f}
.mcp-tools{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.mcp-tool{cursor:pointer}
.mcp-tool.on{outline:2px solid currentColor}
.mcp-run{margin-top:8px}
.mcp-run-label{display:block;font-size:12px;margin-bottom:4px}
.mcp-args{width:100%;font-family:ui-monospace,monospace;font-size:12px}
.mcp-result{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;font-size:12px;margin-top:8px}
.mcp-watch{margin-top:10px;padding-top:10px;border-top:1px dashed currentColor}
.mcp-watch-head{margin:0 0 4px;font-size:13px}
.mcp-watch-note{margin:0 0 8px;font-size:12px;opacity:.8}
.mcp-watch-on{margin:6px 0 0;font-size:12px;font-weight:600}
.mcp-every{font-size:12px}
.mcp-picks{margin-bottom:12px}
.mcp-pick-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.mcp-pick{display:flex;flex-direction:column;gap:3px;text-align:left;cursor:pointer;padding:8px 10px;max-width:280px}
.mcp-pick-name{font-weight:600}
.mcp-pick-by,.mcp-pick-setup{font-size:11px;opacity:.8}
.mcp-pick-needs{font-size:11px;opacity:.7;font-style:italic}
.mcp-pick.chosen{border-color:currentColor;box-shadow:inset 0 0 0 1px currentColor}
.mcp-steps{margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);border-radius:8px}
.mcp-steplist{margin:0;padding-left:18px;font-size:12px;line-height:1.5}
.mcp-steplist li{margin-bottom:5px}
.mcp-manual{margin:0;padding-left:18px;font-size:12px;opacity:.85}
.mcp-manual li{margin-bottom:4px}
.mcp-tool{font-size:11px;padding:3px 7px;border-radius:20px;border:1px solid var(--line);opacity:.85}
.mcp-error{margin:8px 0 0;font-size:12px;color:#d05353}
.mcp-empty{font-size:12px;opacity:.7;margin:8px 0}
.mcp-fine{font-size:11px;opacity:.65;margin:6px 0}
.mcp-add{font:inherit;font-size:12px;padding:6px 12px;border-radius:7px;
  border:1px dashed var(--line);background:transparent;color:inherit;cursor:pointer;margin-bottom:12px}
.mcp-form{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.mcp-form label{display:block;font-size:11px;opacity:.75;margin-bottom:8px}
.mcp-form input{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:12px;
  margin-top:3px;padding:5px 7px;border-radius:6px;border:1px solid var(--line);
  background:transparent;color:inherit}
.mcp-log{display:flex;flex-direction:column;gap:6px}
.mcp-call{border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.mcp-call.failed{border-color:#d05353}
.mcp-call-head{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.mcp-when{opacity:.6;font-size:11px;white-space:nowrap}
.mcp-args{display:block;font-size:11px;opacity:.7;margin-top:3px;word-break:break-all}
`;
