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

/** A server as Rust is willing to describe it. Never carries a secret. */
export interface ServerView {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly note: string;
  /** Names of the environment variables set for it. Names only. */
  readonly env_keys: readonly string[];
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
  readonly calls: readonly CallRecord[];
  /** Whether the add form is open. */
  readonly adding: boolean;
}

export const EMPTY_CONNECTIONS: ConnectionsState = {
  servers: [],
  running: [],
  tools: {},
  errors: {},
  calls: [],
  adding: false,
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
    s.env_keys.every((k) => typeof k === "string")
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
    .map((t) => `<span class="mcp-tool">${escapeHTML(t)}</span>`)
    .join("");
  return `<div class="mcp-tools">${chips}</div>`;
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
    `<code class="mcp-cmd">${escapeHTML(commandLine(server))}</code>` +
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

function addForm(open: boolean): string {
  if (!open) {
    return `<button class="mcp-add" data-mcp-add-open="1">+ Add a connection</button>`;
  }
  return (
    `<div class="mcp-form">` +
    `<label>What to call it<input id="mcp-new-name" placeholder="granola" maxlength="40"></label>` +
    `<label>Program to run<input id="mcp-new-cmd" placeholder="npx" maxlength="200"></label>` +
    `<label>Arguments<input id="mcp-new-args" placeholder="-y granola-mcp" maxlength="400"></label>` +
    `<label>What it is for<input id="mcp-new-note" placeholder="my meeting notes" maxlength="120"></label>` +
    `<p class="mcp-fine">Nothing is started by saving this. API keys go in the config file — ` +
    `use the button below, so a key never passes through this window.</p>` +
    `<div class="mcp-actions">` +
    `<button class="mcp-btn primary" data-mcp-add-save="1">Add it</button>` +
    `<button class="mcp-btn" data-mcp-add-cancel="1">Cancel</button>` +
    `</div></div>`
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
  const list = state.servers.length
    ? state.servers.map((s) => serverCard(s, state)).join("")
    : `<p class="mcp-empty">Nothing is connected. Loaf is talking to no other program.</p>`;

  return (
    `<h2>Connections</h2>` +
    disclosure() +
    list +
    addForm(state.adding) +
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
