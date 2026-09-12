import { describe, it, expect } from "vitest";
import { CATALOG, MANUAL_ONLY, catalogEntry, commandLineOf } from "../src/connections/catalog";
import {
  connectionsPanel,
  parseArgs,
  relativeWhen,
  commandLine,
  isServerView,
  isCallRecord,
  EMPTY_CONNECTIONS,
  type ConnectionsState,
  type ServerView,
  watchFor,
  isWatch,
  type Watch,
  isRemote,
  isClaudeStatus,
  type ClaudeStatus,
} from "../src/connections/connections";

const NOW = 1_700_000_000_000;
const server = (over: Partial<ServerView> = {}): ServerView => ({
  name: "granola",
  command: "npx",
  args: ["-y", "granola-mcp"],
  note: "my meeting notes",
  env_keys: [],
  ...over,
});
const state = (over: Partial<ConnectionsState> = {}): ConnectionsState => ({
  ...EMPTY_CONNECTIONS,
  ...over,
});

describe("what the panel says before anything is connected", () => {
  it("says nothing is connected rather than showing an empty box", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW);
    expect(html).toContain("Nothing is connected");
    expect(html).toContain("talking to no other program");
  });

  // The disclosure is the point of the screen, not a footnote on it. If this
  // test ever has to be deleted, the feature has changed shape.
  it("explains what connecting means even when nothing is connected", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW);
    expect(html).toContain("another program on this computer");
    expect(html).toContain("network calls Loaf cannot see");
    expect(html).toContain("does not sandbox it");
  });

  it("offers a way to add one, and nothing that would start one", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW);
    expect(html).toContain("data-mcp-add-open");
    expect(html).not.toContain("data-mcp-tools");
  });
});

describe("a server that is configured", () => {
  it("shows the command line it will actually run", () => {
    const html = connectionsPanel(state({ servers: [server()] }), NOW);
    expect(html).toContain("npx -y granola-mcp");
  });

  it("says it is not started, because it is not", () => {
    const html = connectionsPanel(state({ servers: [server()] }), NOW);
    expect(html).toContain("not started");
    expect(html).not.toContain("mcp-dot on");
  });

  it("says running once it is, and offers to stop it", () => {
    const html = connectionsPanel(
      state({ servers: [server()], running: ["granola"] }),
      NOW,
    );
    expect(html).toContain("mcp-dot on");
    expect(html).toContain("data-mcp-stop");
  });

  it("only offers to stop the one that is running", () => {
    const html = connectionsPanel(
      state({
        servers: [server(), server({ name: "slack" })],
        running: ["slack"],
      }),
      NOW,
    );
    expect(html).toContain('data-mcp-stop="slack"');
    expect(html).not.toContain('data-mcp-stop="granola"');
  });

  it("names the button after what pressing it does", () => {
    const html = connectionsPanel(state({ servers: [server()] }), NOW);
    expect(html).toContain("Start it and list its tools");
  });

  it("lists the tools once it has been asked", () => {
    const html = connectionsPanel(
      state({ servers: [server()], tools: { granola: ["list_meetings", "get_notes"] } }),
      NOW,
    );
    expect(html).toContain("list_meetings");
    expect(html).toContain("get_notes");
  });

  it("distinguishes a server with no tools from one never asked", () => {
    const asked = connectionsPanel(
      state({ servers: [server()], tools: { granola: [] } }),
      NOW,
    );
    expect(asked).toContain("offers no tools");
    const never = connectionsPanel(state({ servers: [server()] }), NOW);
    expect(never).not.toContain("offers no tools");
  });

  it("shows why it would not start", () => {
    const html = connectionsPanel(
      state({ servers: [server()], errors: { granola: "Could not start npx" } }),
      NOW,
    );
    expect(html).toContain("Could not start npx");
  });
});

describe("secrets", () => {
  // The whole reason ServerView exists. A value cannot be rendered because a
  // value never arrives — but the panel must still show that one is stored, or
  // the user cannot tell a configured server from an unconfigured one.
  it("names the environment variables and marks them set", () => {
    const html = connectionsPanel(
      state({ servers: [server({ env_keys: ["SLACK_TOKEN", "TEAM_ID"] })] }),
      NOW,
    );
    expect(html).toContain("SLACK_TOKEN");
    expect(html).toContain("TEAM_ID");
    expect(html).toContain("set");
  });

  it("offers no way to reveal one", () => {
    const html = connectionsPanel(
      state({ servers: [server({ env_keys: ["SLACK_TOKEN"] })] }),
      NOW,
    );
    expect(html).not.toContain("data-mcp-reveal");
    expect(html.toLowerCase()).not.toContain("show key");
  });

  it("sends the user to a text editor for the things it will not do", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW);
    expect(html).toContain("data-mcp-config");
  });
});

describe("the call log", () => {
  it("says nothing has been sent, when nothing has", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW);
    expect(html).toContain("Nothing has been sent to anything");
  });

  it("lists what was sent, to whom", () => {
    const html = connectionsPanel(
      state({
        calls: [
          {
            server: "slack",
            tool: "post_message",
            arguments: '{"channel":"#general"}',
            at: Math.floor(NOW / 1000) - 120,
            ok: true,
          },
        ],
      }),
      NOW,
    );
    expect(html).toContain("slack");
    expect(html).toContain("post_message");
    expect(html).toContain("#general");
    expect(html).toContain("2 min ago");
  });

  // A log that only remembers successes is not an audit trail: the call that
  // failed still sent the arguments.
  it("lists a failed call, and says it failed", () => {
    const html = connectionsPanel(
      state({
        calls: [
          {
            server: "slack",
            tool: "post_message",
            arguments: '{"text":"hello"}',
            at: Math.floor(NOW / 1000),
            ok: false,
          },
        ],
      }),
      NOW,
    );
    expect(html).toContain("failed");
    expect(html).toContain("hello");
  });

  it("puts the newest first", () => {
    const html = connectionsPanel(
      state({
        calls: [
          { server: "a", tool: "older", arguments: "{}", at: 1, ok: true },
          { server: "b", tool: "newer", arguments: "{}", at: 2, ok: true },
        ],
      }),
      NOW,
    );
    expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
  });
});

describe("escaping", () => {
  it("escapes a server name", () => {
    const html = connectionsPanel(
      state({ servers: [server({ name: '<img src=x onerror=alert(1)>' })] }),
      NOW,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  // Arguments come back from a server's own error paths and from whatever the
  // user typed, so they are the least trustworthy string on the page.
  it("escapes logged arguments", () => {
    const html = connectionsPanel(
      state({
        calls: [
          { server: "s", tool: "t", arguments: '{"x":"<script>"}', at: 1, ok: true },
        ],
      }),
      NOW,
    );
    expect(html).not.toContain("<script>");
  });
});

describe("parseArgs", () => {
  it("splits on spaces", () => {
    expect(parseArgs("-y granola-mcp")).toEqual(["-y", "granola-mcp"]);
  });

  it("is empty for an empty string", () => {
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs("   ")).toEqual([]);
  });

  // The normal case on Windows, and splitting it produces a server that will
  // not start with no clue as to why.
  it("keeps a quoted path with a space in it whole", () => {
    expect(parseArgs('"C:\\Program Files\\x.exe" --flag')).toEqual([
      "C:\\Program Files\\x.exe",
      "--flag",
    ]);
  });

  it("handles single quotes too", () => {
    expect(parseArgs("--say 'hello there'")).toEqual(["--say", "hello there"]);
  });

  it("collapses runs of whitespace", () => {
    expect(parseArgs("  a    b  ")).toEqual(["a", "b"]);
  });

  it("keeps a deliberately empty argument", () => {
    expect(parseArgs('a "" b')).toEqual(["a", "", "b"]);
  });
});

describe("relativeWhen", () => {
  const now = 1_000_000_000_000;
  const secs = Math.floor(now / 1000);
  it("reads as just now under a minute", () => {
    expect(relativeWhen(secs, now)).toBe("just now");
    expect(relativeWhen(secs - 59, now)).toBe("just now");
  });
  it("counts minutes, then hours, then days", () => {
    expect(relativeWhen(secs - 60, now)).toBe("1 min ago");
    expect(relativeWhen(secs - 3600, now)).toBe("1 hour ago");
    expect(relativeWhen(secs - 7200, now)).toBe("2 hours ago");
    expect(relativeWhen(secs - 86_400, now)).toBe("1 day ago");
    expect(relativeWhen(secs - 172_800, now)).toBe("2 days ago");
  });
  // Clocks go backwards — a machine that resyncs NTP, or a log copied from
  // another computer. "in -3 minutes" is worse than "just now".
  it("does not go negative on a timestamp from the future", () => {
    expect(relativeWhen(secs + 500, now)).toBe("just now");
  });
});

describe("guards", () => {
  it("accepts a well-formed server", () => {
    expect(isServerView(server())).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isServerView(null)).toBe(false);
    expect(isServerView({})).toBe(false);
    expect(isServerView({ ...server(), args: "not an array" })).toBe(false);
    expect(isServerView({ ...server(), env_keys: [1] })).toBe(false);
    expect(isServerView({ ...server(), name: 7 })).toBe(false);
  });
  it("accepts a well-formed call record", () => {
    expect(isCallRecord({ server: "a", tool: "b", arguments: "{}", at: 1, ok: true })).toBe(
      true,
    );
  });
  it("rejects a record with a nonsense timestamp", () => {
    expect(
      isCallRecord({ server: "a", tool: "b", arguments: "{}", at: NaN, ok: true }),
    ).toBe(false);
  });
});

describe("commandLine", () => {
  it("joins the program and its arguments", () => {
    expect(commandLine(server())).toBe("npx -y granola-mcp");
  });
  it("is just the program when there are none", () => {
    expect(commandLine(server({ args: [] }))).toBe("npx");
  });
});

/**
 * Calling a tool — the half that was built and then never reached.
 *
 * Everything below this line covers code that existed for two milestones with
 * no way to run it: the client could connect, list tools and make a call, and
 * a tool name was rendered as a label. These are the tests for turning that
 * label into the button that sends something to another program.
 */
/** Read an escaped value back, so a test asserts the value and not the encoding. */
function unescapeHTML(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("running a tool", () => {
  const withTools = (over: Partial<ConnectionsState> = {}) =>
    state({ servers: [server()], tools: { granola: ["list_meetings", "get_notes"] }, ...over });

  it("makes every tool something you can press", () => {
    const html = connectionsPanel(withTools(), NOW);
    expect(html).toContain('data-mcp-pick="granola"');
    expect(html).toContain('data-mcp-tool="list_meetings"');
    expect(html).toContain('data-mcp-tool="get_notes"');
  });

  it("shows no arguments box until a tool is picked", () => {
    expect(connectionsPanel(withTools(), NOW)).not.toContain("mcp-args");
  });

  it("opens an arguments box for the tool that was picked", () => {
    const html = connectionsPanel(
      withTools({ picked: { server: "granola", tool: "get_notes" } }),
      NOW,
    );
    expect(html).toContain("mcp-args");
    expect(html).toContain("get_notes");
    expect(html).toContain("data-mcp-run");
  });

  it("opens it on the right card when two servers are connected", () => {
    const html = connectionsPanel(
      state({
        servers: [server(), server({ name: "other" })],
        tools: { granola: ["a"], other: ["b"] },
        picked: { server: "other", tool: "b" },
      }),
      NOW,
    );
    // Exactly one box, and it is on `other`'s card rather than granola's.
    expect(html.match(/<textarea/g)?.length).toBe(1);
    const otherCard = html.slice(html.indexOf('data-mcp-server="other"'));
    expect(otherCard).toContain("<textarea");
  });

  // Asserted by reading the box back rather than by looking for the raw text:
  // the quotes are HTML-escaped on the way in, which is correct, and a
  // substring check would fail on working code. That mistake has been made
  // three times in this repo now.
  it("keeps what the user typed across a re-render", () => {
    const draft = '{"id":7,"note":"a & b"}';
    const html = connectionsPanel(
      withTools({ picked: { server: "granola", tool: "get_notes" }, argsDraft: draft }),
      NOW,
    );
    const inBox = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";
    expect(unescapeHTML(inBox)).toBe(draft);
  });

  it("says it is sending, and cannot be pressed twice", () => {
    const html = connectionsPanel(
      withTools({ picked: { server: "granola", tool: "get_notes" }, calling: true }),
      NOW,
    );
    expect(html).toContain("Sending…");
    expect(html).toContain("disabled");
  });

  it("shows what came back", () => {
    const html = connectionsPanel(
      withTools({ picked: { server: "granola", tool: "get_notes" }, result: "three meetings" }),
      NOW,
    );
    expect(html).toContain("three meetings");
  });

  // The result comes from a program Loaf did not write. That is the entire
  // point of this panel and exactly why its output does not get to pick markup.
  it("never lets a server's answer become HTML", () => {
    const html = connectionsPanel(
      withTools({
        picked: { server: "granola", tool: "get_notes" },
        result: '<img src=x onerror="alert(1)">',
      }),
      NOW,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("never lets a tool name become HTML either", () => {
    const html = connectionsPanel(state({ servers: [server()], tools: { granola: ["<b>x</b>"] } }), NOW);
    expect(html).not.toContain("<b>x</b>");
  });

  it("marks the picked tool so you can see which one is open", () => {
    const html = connectionsPanel(
      withTools({ picked: { server: "granola", tool: "get_notes" } }),
      NOW,
    );
    expect(html).toMatch(/class="mcp-tool on"[^>]*data-mcp-tool="get_notes"/);
  });
});

/**
 * Watches — Loaf checking something on its own.
 *
 * The panel half. The rules that make this not-a-nuisance (first run silent,
 * minimum interval, only changes speak) live in watch.rs and are tested there;
 * these are the ones about not lying to the user in the UI.
 */
describe("having Loaf check a tool for you", () => {
  const withTool = (over: Partial<ConnectionsState> = {}) =>
    state({
      servers: [server()],
      tools: { granola: ["list_meetings"] },
      picked: { server: "granola", tool: "list_meetings" },
      ...over,
    });

  const aWatch = (over: Partial<Watch> = {}): Watch => ({
    server: "granola",
    tool: "list_meetings",
    arguments: "{}",
    every_seconds: 300,
    say: "New meeting notes.",
    enabled: true,
    ...over,
  });

  it("offers to watch a tool the user has opened", () => {
    const html = connectionsPanel(withTool(), NOW);
    expect(html).toContain("data-mcp-watch-on");
    expect(html).toContain("watch-every");
  });

  it("offers nothing until a tool is opened", () => {
    expect(connectionsPanel(state({ servers: [server()] }), NOW)).not.toContain("data-mcp-watch-on");
  });

  // Saying "the first check is silent" in the panel matters: otherwise adding
  // a watch and hearing nothing reads as the feature being broken.
  it("says the first check is silent, so silence is not read as failure", () => {
    expect(connectionsPanel(withTool(), NOW).toLowerCase()).toContain("first check is silent");
  });

  it("says every check is logged, where the user can see it", () => {
    expect(connectionsPanel(withTool(), NOW).toLowerCase()).toContain("log");
  });

  it("fills in the wording and interval of a watch that already exists", () => {
    const html = connectionsPanel(withTool({ watches: [aWatch()] }), NOW);
    expect(html).toContain("New meeting notes.");
    expect(html).toContain('value="300" selected');
  });

  it("offers to stop only when there is something to stop", () => {
    expect(connectionsPanel(withTool(), NOW)).not.toContain("data-mcp-watch-off");
    expect(connectionsPanel(withTool({ watches: [aWatch()] }), NOW)).toContain("data-mcp-watch-off");
  });

  it("does not show another tool's watch on this one", () => {
    const html = connectionsPanel(withTool({ watches: [aWatch({ tool: "get_notes" })] }), NOW);
    expect(html).not.toContain("data-mcp-watch-off");
    expect(html).not.toContain("New meeting notes.");
  });

  it("never lets the user's own wording become HTML", () => {
    const html = connectionsPanel(
      withTool({ watches: [aWatch({ say: '"><img src=x onerror=alert(1)>' })] }),
      NOW,
    );
    expect(html).not.toContain("<img");
  });
});

describe("watchFor", () => {
  const w = (server: string, tool: string): Watch => ({
    server,
    tool,
    arguments: "{}",
    every_seconds: 60,
    say: "",
    enabled: true,
  });

  it("finds the watch on this exact tool", () => {
    expect(watchFor([w("a", "one"), w("a", "two")], "a", "two")?.tool).toBe("two");
  });

  it("does not match the same tool name on another server", () => {
    expect(watchFor([w("a", "one")], "b", "one")).toBe(null);
  });

  it("returns null rather than undefined when there is none", () => {
    expect(watchFor([], "a", "one")).toBe(null);
  });
});

describe("isWatch", () => {
  const good = {
    server: "a",
    tool: "b",
    arguments: "{}",
    every_seconds: 60,
    say: "",
    enabled: true,
  };

  it("accepts a well-formed watch", () => {
    expect(isWatch(good)).toBe(true);
  });

  // A watch starts a program on a timer. A malformed one is dropped whole
  // rather than half-trusted, the same rule the server list follows.
  it("rejects one missing a field", () => {
    for (const key of Object.keys(good)) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[key];
      expect(isWatch(bad)).toBe(false);
    }
  });

  it("rejects a nonsense interval", () => {
    expect(isWatch({ ...good, every_seconds: NaN })).toBe(false);
    expect(isWatch({ ...good, every_seconds: "60" })).toBe(false);
  });

  it("rejects things that are not objects", () => {
    expect(isWatch(null)).toBe(false);
    expect(isWatch("watch")).toBe(false);
  });
});

/**
 * The catalog — what Loaf will fill in for you, and what it refuses to.
 *
 * The rule these tests hold: a row here is Loaf saying "this is safe to run",
 * and Loaf can only honestly say that about a server published by whoever owns
 * the thing being connected. Verified against npm, not remembered.
 */
describe("the server catalog", () => {
  it("offers something to start from", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it("names who publishes every entry, because that is the whole basis for it being listed", () => {
    for (const e of CATALOG) {
      expect(e.publisher.trim().length).toBeGreaterThan(0);
    }
  });

  // The two that guides point at are marked no longer supported on npm.
  // A button for either would be Loaf recommending abandoned code.
  it("lists no deprecated server", () => {
    const commands = CATALOG.map((e) => [e.command, ...e.args].join(" "));
    expect(commands.join(" ")).not.toContain("server-github");
    expect(commands.join(" ")).not.toContain("server-slack");
  });

  // The finding that shaped this file: ten community Gmail servers, no
  // first-party one, and each would receive the user's whole mailbox.
  it("offers no one-press Gmail, and says why instead of leaving a gap", () => {
    expect(CATALOG.map((e) => e.id)).not.toContain("gmail");
    const explained = MANUAL_ONLY.map((m) => m.label.toLowerCase()).join(" ");
    expect(explained).toContain("gmail");
  });

  it("explains every manual-only entry rather than just naming it", () => {
    for (const m of MANUAL_ONLY) {
      expect(m.why.trim().length).toBeGreaterThan(30);
    }
  });

  it("has unique ids so a pick is unambiguous", () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });

  it("finds an entry by id, and nothing for one that is not there", () => {
    expect(catalogEntry(CATALOG[0]!.id)?.id).toBe(CATALOG[0]!.id);
    expect(catalogEntry("gmail")).toBe(null);
  });

  it("shows the command that will actually run", () => {
    const e = CATALOG[0]!;
    expect(commandLineOf(e)).toBe([e.command, ...e.args].join(" "));
  });
});

describe("the add form", () => {
  it("shows what can be started from, and what cannot", () => {
    const html = connectionsPanel(state({ adding: true }), NOW);
    expect(html).toContain("data-mcp-pick-server");
    expect(html.toLowerCase()).toContain("gmail");
  });

  it("shows none of it until the form is open", () => {
    expect(connectionsPanel(state(), NOW)).not.toContain("data-mcp-pick-server");
  });

  it("says pressing one does not start anything", () => {
    const html = connectionsPanel(state({ adding: true }), NOW).toLowerCase();
    expect(html).toContain("nothing runs until");
  });
});

/**
 * Remote servers — the transport that makes a one-click connection possible.
 *
 * Loaf could only ever start a program and pipe to it, which is why no ordinary
 * person could connect Gmail: every server had to be installed and its
 * credentials typed into a config file. A remote server is one address and a
 * sign-in, which is what every hosted connector actually uses.
 */
describe("a remote server", () => {
  const remote = (over: Partial<ServerView> = {}): ServerView => ({
    name: "gmail",
    command: "",
    args: [],
    note: "my mail",
    env_keys: [],
    url: "https://mail.example.com/mcp",
    has_token: true,
    ...over,
  });

  it("is recognised by its address", () => {
    expect(isRemote(remote())).toBe(true);
    expect(isRemote(remote({ url: "http://127.0.0.1:3000/mcp" }))).toBe(true);
  });

  it("is not confused with a local one", () => {
    expect(isRemote(server())).toBe(false);
    expect(isRemote(remote({ url: "" }))).toBe(false);
    expect(isRemote(remote({ url: undefined }))).toBe(false);
  });

  // A card that showed an empty command line made a correctly configured
  // remote connection look broken.
  it("shows its address rather than an empty command line", () => {
    const html = connectionsPanel(state({ servers: [remote()] }), NOW);
    expect(html).toContain("mail.example.com/mcp");
    expect(html).toContain("Remote server");
  });

  it("says a token is stored without ever showing one", () => {
    const html = connectionsPanel(state({ servers: [remote()] }), NOW);
    expect(html).toContain("signed in");
  });

  it("does not claim a sign-in when there is none", () => {
    const html = connectionsPanel(state({ servers: [remote({ has_token: false })] }), NOW);
    expect(html).not.toContain("signed in");
  });

  it("is accepted by the validator, and so is a config from an older build", () => {
    expect(isServerView(remote())).toBe(true);
    const { url, has_token, ...older } = remote();
    void url;
    void has_token;
    expect(isServerView(older)).toBe(true);
  });

  it("is rejected when the new fields are the wrong type", () => {
    expect(isServerView({ ...remote(), url: 7 })).toBe(false);
    expect(isServerView({ ...remote(), has_token: "yes" })).toBe(false);
  });

  it("can be added from the form, which offers an address and a token", () => {
    const html = connectionsPanel(state({ adding: true }), NOW);
    expect(html).toContain('id="mcp-new-url"');
    expect(html).toContain('id="mcp-new-token"');
    // A token box that is not a password box is a token on somebody's screen.
    expect(html).toContain('type="password"');
  });
});

describe("when the connection panel could not be made to work", () => {
  it("says the list could not be READ, not that the list is empty", () => {
    // These are different facts. `mcp_servers` is strict about its config file,
    // and swallowing that to `[]` rendered a hand-edited config as "Nothing is
    // connected yet" — which sends someone off adding what they already have.
    const html = connectionsPanel(
      state({ listError: "line 4: trailing comma" }),
      NOW,
    );
    expect(html).toContain("could not read its list");
    expect(html).toContain("trailing comma");
    expect(html).not.toContain("Nothing is connected");
  });

  it("shows why a server would not start", () => {
    // THE BUG THAT MADE THE TAB LOOK DEAD. The reason was stored and then wiped
    // by the refresh that followed, so the button reset and nothing appeared.
    const html = connectionsPanel(
      state({
        servers: [server()],
        errors: { granola: "Could not start npx. This connection needs Node.js" },
      }),
      NOW,
    );
    expect(html).toContain("needs Node.js");
  });

  it("keeps a server's own card when only the list failed", () => {
    const html = connectionsPanel(state({ listError: "broken" }), NOW);
    expect(html).toContain("Open the config file");
  });
});

describe("setting up a connection that needs a key", () => {

  it("gives Notion's key a box to go in", () => {
    // It used to tell the user to put a token in NOTION_TOKEN and provide
    // nowhere to put it. The only route was hand-editing JSON.
    const html = connectionsPanel(state({ adding: true, pickedCatalog: "notion" }), NOW);
    expect(html).toContain('data-mcp-env="NOTION_TOKEN"');
    expect(html).toContain('type="password"');
  });

  it("shows the steps, including sharing the pages", () => {
    const html = connectionsPanel(state({ adding: true, pickedCatalog: "notion" }), NOW);
    expect(html).toContain("my-integrations");
    // The step people miss: a valid key with no pages shared looks like an
    // empty Notion, which reads as Loaf being broken.
    expect(html).toContain("Connect to your new integration");
  });

  it("asks for no keys until a preset is chosen", () => {
    const html = connectionsPanel(state({ adding: true }), NOW);
    expect(html).not.toContain("data-mcp-env");
  });

  it("asks for no keys for a server that needs none", () => {
    const html = connectionsPanel(state({ adding: true, pickedCatalog: "files" }), NOW);
    expect(html).not.toContain("data-mcp-env");
    expect(html).toContain("Not your whole home folder");
  });

  it("every catalog entry that names a key also explains where to get it", () => {
    for (const entry of CATALOG) {
      if (entry.envKeys.length > 0) {
        expect(entry.tokenFrom, entry.id).not.toBe("");
        expect(entry.steps.length, entry.id).toBeGreaterThan(0);
      }
    }
  });

  it("warns that the npx entries need Node.js installed", () => {
    // Every catalog entry runs through npx, and a machine without Node.js
    // cannot start any of them. Better said on the button than discovered as a
    // failure afterwards.
    const html = connectionsPanel(state({ adding: true }), NOW);
    expect(html).toContain("needs Node.js");
  });
});

describe("the other direction: Claude Desktop starting Loaf", () => {
  const claude = (over: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
    installed: true,
    connected: false,
    configPath: "C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json",
    otherServers: [],
    sessionLive: false,
    error: "",
    ...over,
  });

  it("draws no card at all until Rust has answered", () => {
    // Saying "not connected" before asking would be the window inventing a
    // fact about the machine.
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW, undefined);
    expect(html).not.toContain("Claude Desktop");
  });

  it("offers to connect when Claude is installed but not set up", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW, claude());
    expect(html).toContain("data-claude-connect");
    expect(html).not.toContain("data-claude-disconnect");
  });

  it("says so plainly when Claude is not installed", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW, claude({ installed: false }));
    expect(html).toContain("does not look like it is installed");
    expect(html).not.toContain("data-claude-connect");
  });

  it("tells the user to restart Claude, which is the step that is always missed", () => {
    // Claude reads that file once, at startup. Connecting and then wondering
    // why nothing happened is the whole failure mode.
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW, claude({ connected: true }));
    expect(html).toContain("Quit Claude Desktop completely");
    expect(html).toContain("data-claude-disconnect");
  });

  it("names the other servers it is about to sit beside", () => {
    // This edits a shared file, so what else is in it is the user's business.
    const html = connectionsPanel(
      EMPTY_CONNECTIONS,
      NOW,
      claude({ otherServers: ["filesystem", "github"] }),
    );
    expect(html).toContain("filesystem");
    expect(html).toContain("github");
    expect(html).toContain("left alone");
  });

  it("shows when Claude is actually attached right now", () => {
    const html = connectionsPanel(EMPTY_CONNECTIONS, NOW, claude({ connected: true, sessionLive: true }));
    expect(html).toContain("attached right now");
  });

  it("reports a config it could not read, and says nothing was touched", () => {
    const html = connectionsPanel(
      EMPTY_CONNECTIONS,
      NOW,
      claude({ error: "expected value at line 4" }),
    );
    expect(html).toContain("line 4");
    expect(html).toContain("Loaf has changed nothing");
    // It must NOT offer to write over a file it could not parse.
    expect(html).not.toContain("data-claude-connect");
  });

  it("refuses a status of the wrong shape rather than half-trusting it", () => {
    expect(isClaudeStatus(claude())).toBe(true);
    expect(isClaudeStatus({ installed: true })).toBe(false);
    expect(isClaudeStatus(null)).toBe(false);
    expect(isClaudeStatus({ ...claude(), otherServers: "nope" })).toBe(false);
  });
});
