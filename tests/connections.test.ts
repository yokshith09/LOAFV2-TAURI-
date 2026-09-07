import { describe, it, expect } from "vitest";
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
