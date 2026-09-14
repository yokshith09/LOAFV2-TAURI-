# Loaf — Project Context and Structural Analysis

**As of:** commit `d01544d` / tag `v0.6.0` (2026-09-14).
**Purpose:** a detailed, code-verified reference to how Loaf is actually built — not a marketing description, not a wishlist. Companion documents: [`ARCHITECTURE-REVIEW.md`](ARCHITECTURE-REVIEW.md) (verified/unverified audit, production blockers) and [`MILESTONES.md`](MILESTONES.md) (chronological progress).

---

## 1. What Loaf Is

A desktop pet (Tauri v2, Rust + TypeScript, Windows + macOS) that sits in the corner of the screen, tracks screen time locally, and has grown into a small personal-assistant surface: meeting detection and local transcription, a notes/task board, an MCP client (so it can talk to Notion/Linear/Asana/Sentry and other tools) and an MCP *server* (so Claude Desktop can ask it questions about your day). Started as a rewrite of an older Swift/AppKit app — several coordinate systems and file formats are still ported verbatim from that original for compatibility.

## 2. Process and Window Architecture

One Tauri process, one Rust binary (`loaf`, plus a second bin target `loaf-mcp` sharing the same `mcp_stdio` implementation), multiple WebView windows:

| Window | Created | Purpose |
|---|---|---|
| `companion` | Declared statically in `tauri.conf.json`, exists before Rust's `setup()` runs | The pet itself. 134×150px, transparent, always-on-top, no taskbar entry, never takes focus. **Sole owner of tracker/meeting/memory state** — everything else reads a broadcast copy. |
| `bubble` | Built at startup in `build_bubble_window` | Speech-bubble overlay, 240×80, hidden until needed, never focused. |
| `dashboard` | Lazily, on first `open_dashboard` | Full stats/notes/connections UI. Reads `stats.json` directly but never writes it — the two-window single-writer rule is explicit in `main.ts`'s own comments. |
| `closet` | Lazily, on first `show_closet` | Companion/outfit picker. |
| `focus` | Lazily | Focus-timer window. |
| `onboarding` | Lazily | First-run flow. |

Every non-companion window talks to the companion **only** over named `loaf://...` Tauri events (`emit`/`listen`), never by touching shared files directly (the one exception, and it's called out as an exception in the code: the dashboard *reads* `stats.json`). Every payload crossing a window boundary is validated by an `isXxx` type guard on the receiving end (`isNoteView`, `isClosetState`, `isFocusSnapshot`, etc.) before being trusted — this holds consistently across the whole frontend.

`main.rs` branches before Tauri is even built: if `--mcp-server` is on argv, it runs `mcp_stdio::serve()` and exits — no window, no GUI, a completely separate code path used when Claude Desktop spawns Loaf as a tool server.

## 3. Startup Sequence (Rust `lib.rs::run()`)

1. Three pieces of managed state are registered, **all empty at construction**: an MCP connection `Pool`, a `Seen` map (last result per watch), and a `Store` handle (SQLite, not yet opened).
2. `.setup()` runs once:
   - macOS: sets `ActivationPolicy::Accessory` (no Dock icon).
   - Starts scroll tracking.
   - Spawns the **watch poller** thread (15s loop) — does nothing unless the user has created a watch.
   - Spawns the **Claude-activity poller** thread (500ms loop) — reads a small activity file Claude Desktop's spawned Loaf-as-server writes, and emits `loaf://claude/asked`/`loaf://claude/done` (fixed this session to fire once per burst, not once per call).
   - If Claude Desktop is already configured to use Loaf, refreshes the copied binary it points at (see §5).
   - Builds the tray and the bubble window; parks the companion bottom-right.
3. ~70 commands are registered via `generate_handler!`.

Nothing is read from disk at launch except a stat of Claude Desktop's config. The SQLite store opens lazily on first use ("doing it during launch would delay the character appearing"); no MCP server is started until its first tool call.

## 4. Screen-Time Tracking, End to End

**Every 5 seconds** (`TICK_INTERVAL`), `pollPlatform()` in `main.ts`:

1. `invoke("foreground_app")` → Rust's platform probe (`GetForegroundWindow` → `GetWindowThreadProcessId` → `QueryFullProcessImageNameW` on Windows) returns `{ app: Option<...>, reason }`. `None` means the OS genuinely reported nothing — never guessed.
2. `invoke("idle_seconds")` → `GetLastInputInfo` vs. `GetTickCount`.
3. `Tracker.tick(appName, idleSeconds)`: if idle > **180s**, credits nothing and returns `"idle"`. Critically, `idleSeconds === null` (the OS call failed) is *not* treated as idle — that would silently stop the clock. Otherwise credits 5 seconds to that app and that hour-of-day. An unresolvable app name is still credited, under the literal label `"Somewhere mysterious"` — dropping it would make the day total disagree with its own breakdown.
4. Every 15 continuous minutes of activity fires a break nudge; a `"breakDue"` result resets the counter.
5. Every 12th tick (once a minute), `saveHistory()` writes — coalesced, not queued: only the *latest* snapshot is kept in flight, so a burst of ticks collapses to at most one `write_stats` call, backed by `stats.json` (still the on-disk format, auto-upgrading an older flat-number version) **and**, best-effort, mirrored into the SQLite store (§8) on the same write.

**Browser tab / domain reading (the privacy radar)** rides the same 5-second tick, gated behind a setting that's off by default. It asks which known browsers are running, probes each for its tab count (summed across *every* window of that browser — fixed to be a sum rather than a max this session, for the tab-count *panel* specifically; the underlying per-browser count was already correct) and, only for the foreground browser, its active tab's domain — never the full URL, truncated to a bare host before it leaves Rust.

## 5. MCP — Both Directions

Loaf both *calls* other MCP servers and *is* one, and the two are separate modules on purpose.

**Loaf as client** (`connections.rs` + `mcp_client.rs`): a connection is a `ServerSpec` (name, command/args or a remote URL, env vars, an optional OAuth setup) persisted to `LoafPlus/mcp.json`. Adding one from the UI goes through `apply()`, which merges rather than replaces — an empty incoming secret means "keep the stored one," and watches are carried through unconditionally because the window is never shown them at all (rebuilding from what it sent would silently delete every watch a user made). Starting a server locks a `Pool` (a mutex around a `name → Connection` map) for the whole handshake, so two windows can't race to spawn the same process; a failed call removes the connection from the pool rather than reusing a possibly-corrupted pipe. Every call — manual or from a scheduled watch — is logged to `mcp-calls.json` (capped at 500 entries) through the exact same `record()` function, win or lose.

**Loaf as server** (`mcp_stdio.rs`, `mcp.rs`, `claude_desktop.rs`): when Claude Desktop spawns `loaf --mcp-server`, it gets a stdio JSON-RPC loop exposing exactly four **read-only** tools (`screen_time_today`, `screen_time_recent`, `recent_meetings`, `busiest_hours`) — site/domain data is excluded unless the machine owner sets `LOAF_MCP_SITES=1` outside the conversation; an assistant cannot opt itself in. Every real tool call writes a small activity marker file, which is what the companion app's 500ms poller (§3) notices to react. `claude_desktop.rs` edits only the `mcpServers.loaf` key of Claude's own config (byte-for-byte preserving everything else, tested explicitly), takes a backup first, and keeps a *copy* of the running binary for Claude to spawn — because Claude Desktop holds that child process open for the whole conversation, and a rebuild replacing the original executable in place kills the pipe out from under it after roughly 14 minutes.

## 6. Voice Pipeline

Two genuinely separate recognition paths, chosen at compile time:

**Windows** — a closed-vocabulary, on-device WinRT recogniser. The caller-supplied phrase list is compiled into a `SpeechRecognitionListConstraint` *before* the grammar is compiled; compiling with zero constraints is the exact fork into Microsoft's cloud dictation grammar instead, so an **empty phrase list is refused outright** rather than silently falling back — this refusal is the whole local-vs-cloud safety property, not a nicety.

**Everywhere else, and for the wake word everywhere** — Whisper, compiled directly into the binary (not downloaded at first use as one earlier design considered; needs cmake + libclang to build, see [[loaf-build-environment]]). Audio comes from a hand-written adaptive voice-activity detector (`vad.rs`), not silence-timeout logic: it computes RMS level against a *learned noise floor*, using hysteresis (a higher ratio to *start* speech than to *continue* it, so a natural mid-sentence dip doesn't fragment the utterance) and a hangover period before declaring the utterance over. The floor itself is learned by **minimum statistics** over a rolling 16-second window — not an average, and not learned only from frames already judged quiet, because that second approach is circular and can never escape a room that started out loud. A short pre-roll buffer is spliced onto the front of every captured utterance so the first syllable spoken before the detector committed isn't lost. The wake-word path additionally length-gates a candidate utterance (200ms–2.5s) *before* spending a Whisper inference on it — the closest available substitute for Windows' closed grammar, since most nearby speech is simply too long to be a wake word and can be discarded unheard.

## 7. Meeting Detection and Recording

Rides the same 5-second tick as screen-time tracking — no separate poll. A meeting is recognised either by the radar's already-known browser domain (Meet, Zoom, Teams, Webex, etc. — free, since the radar already reads it) or by a small list of desktop app names, matched on the *executable*, never the window title (which could leak a meeting or participant name). A sighting shorter than 3 minutes is discarded as a glance; once started, the meeting app can leave the foreground for up to 5 minutes (checking a shared doc) without ending the detected meeting. Detection is entirely separate from recording: recording is always a confirmed user action (a bubble + native OS notification prompt, re-asked periodically while a detected meeting stays unrecorded), and stopping it deletes the captured audio file on every path — success or failure — keeping only the transcript text. A transcript attaches to the in-progress meeting's own notes if one is active, or to the general task list otherwise; either way it also feeds the memory graph (entity extraction, then an all-pairs "co-occurred" edge between everything mentioned together, plus a "mentioned-in" edge back to the meeting) — deleting a transcript prunes its graph contribution in lockstep.

## 8. The Store (SQLite)

Added to replace several separate JSON files with one queryable database: `app_seconds`, `hour_seconds`, `site_seconds`, `meetings`, `lines` (transcript lines, cascade-deleted with their meeting), and an FTS5 full-text index over `lines` kept in sync by SQL triggers rather than app code. The original JSON files (`stats.json`, `meetings.json`) are migrated in **once**, non-destructively — never deleted or moved, specifically so a rollback to an older build still finds its history. `stats.json` is still written on every save alongside the DB mirror; a DB write failure there is swallowed rather than failing the whole save, since losing the queryable copy is judged less bad than losing the day's data outright. Deleting a range wraps its multi-table delete in one transaction (all-or-nothing); exporting writes plain, human-readable files rather than a proprietary blob ("a format only we can read is a backup, not an export").

## 9. Rendering Pipeline

Every companion (18 of them) implements the same interface — fixed anchor points (head, eyes, hands, hat position) plus four ordered draw calls (behind → body → head → muzzle) — so shared systems (fur spikes during a tantrum, eyes, an equipped outfit) can position themselves without each species hardcoding the interaction. All drawing happens in a fixed 170×190 **y-up** design space, ported directly from the original AppKit art; a single `computeFit()` scale-and-flip transform maps that into the actual (much smaller) window canvas with one `ctx.scale(scale, -scale)` call rather than renegotiating every coordinate. The render loop itself runs on `requestAnimationFrame` (so, display refresh rate) and redraws unconditionally every frame — there's no dirty-checking; what's conditional is only which optional overlays (a ball, a focus ring, fur spikes) get drawn on top. A separate, much slower interval (200ms) polls cursor position, typing/scroll/CPU activity and stashes the results for the render loop to pick up on its next frame — the two clocks are independent and only meet through plain module variables.

## 10. Mood Resolution

`resolveMood()` is a pure function over a precedence ladder — highest wins: `hovering → sleeping → tabAlert → proud → override → claudeThinking → scrolling → typing → working → idle`. Every input is owned by a different subsystem (hover by pointer events, `tabAlert` by the privacy radar, `claudeThinking` by the MCP busy event, `working` by CPU + a dedicated watcher class) and gets refreshed on its own cadence (some every frame, some every 5s, some every 200ms) — `resolveMood` itself never touches the clock, it just reads whatever the last write left behind. This is the function the mood-ladder fix earlier in this session's work reordered (`sleeping` moved from 7th to 2nd) to make Sleep/Quiet actually override every activity mood rather than only the loudest one.

## 11. Concrete Numbers

| | Backend (Rust) | Frontend (TypeScript) |
|---|---|---|
| Source lines | 17,877 across 35 files | 26,870 across `src/` (excludes tests) |
| Largest file | `lib.rs` — 2,891 lines | `main.ts` — 4,072 lines |
| Next largest | `control.rs` (1,351), `oauth.rs` (1,263), `mcp_client.rs` (1,231), `store.rs` (1,094) | `dashboard/html.ts` (1,750), `dashboard/page.ts` (1,590), `connections/connections.ts` (907), `voice/commands.ts` (689) |
| Test files | 35 modules, all but 4 have a `#[cfg(test)] mod tests` | 50 files under `tests/` |
| Test count | 370 `#[test]` functions | **1,707** (measured by actually running `vitest run` this session — a static grep of `it(`/`test(` undercounts at ~1,463 because `it.each(...)` expands to several runs per source line) |
| Heaviest-tested modules | `store.rs` (30), `control.rs` (29), `mcp_client.rs` (27) | `dashboard.test.ts` (147), `voiceCommands.test.ts` (131), `tracker.test.ts` (50) |

## 12. Testing Philosophy (confirmed consistent throughout, both languages)

- **Pure logic is exhaustively tested; imperative glue is not, by explicit design.** `main.ts` (the companion's event wiring, invoke calls, mic orchestration) has no test file; the state→HTML rendering and parsing modules it calls into do.
- **Anything needing real hardware is written as a real test, just an `#[ignore]`d one with manual run instructions in its own doc comment** — never silently skipped or left undocumented. About a dozen of these exist (microphone capture, a live MCP handshake, a real OAuth round-trip, browser tab reading, the Whisper download).
- **Platform-specific string-building is deliberately kept OUT of `#[cfg(target_os = "macos")]` gates**, even though the code that executes it must be gated — `macos_keys` and (added this session) `macos_click` are plain modules so their AppleScript shape and escaping can be checked by `cargo test` on the Windows PC this project is actually developed on, leaving only the real `osascript` process spawn as something only a Mac can verify.

---

*See [`ARCHITECTURE-REVIEW.md`](ARCHITECTURE-REVIEW.md) for what's verified vs. not, and [`MILESTONES.md`](MILESTONES.md) for the project's history and what's next.*
