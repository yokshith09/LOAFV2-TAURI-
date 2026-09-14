# Loaf — Architecture & Production Readiness Review

**Reviewed at:** commit `93fdb87` / tag `v0.6.0` (2026-09-14)
**Scope:** full codebase — Rust backend (`src-tauri/src`), TypeScript frontend (`src/`), CI/release pipeline.
**Method:** direct code reading + two independent read-only audits (backend, frontend), cross-checked against this session's own fixes.

---

## 1. Completed and Verified

Confirmed by passing tests (unit or contract-level) and, where noted, by direct code trace this session.

| Area | Status |
|---|---|
| Screen-time tracking, history, retention | ✅ tested (`tracker.test.ts`, `store.rs`) |
| 18 companions + outfits + pixel art | ✅ contract-tested across all of them (`registry.test.ts`, `outfits.test.ts`) |
| Character pack install (folder/JSON/zip) | ✅ tested per failure mode (`pack_install.rs`) |
| Sleep/Quiet = fully silent | ✅ mood ladder + `say()` gate + `notifyNative()` gate, both fixed and tested this session |
| Claude activity reactions, no per-call spam | ✅ fixed and verified by code trace this session (`watch_for_claude` in `lib.rs`) |
| Notes: archive (separate from `done`) + search | ✅ tested (`notepad.test.ts`, `dashboard.test.ts`) |
| Timing wording (`Due in 20 minutes`, etc.) | ✅ tested (`dashboard.test.ts`) |
| MCP catalog: hosted one-press connect, manual form folded, "Coming soon" tiles, call log Save/Clear | ✅ tested (`connections.test.ts`) |
| Browser tabs: every supported browser + every window | ✅ tested (`tabPanel.test.ts`); Windows path also has a real-hardware `#[ignore]` test with manual run instructions |
| Forget Range (preview → confirm → delete → refresh everywhere) | ✅ confirmed complete by code trace, no gaps found |
| Voice: phrase → parser → intent → action pipeline | ✅ single funnel (`applySpoken`), every intent has a handler, every phrase asserted to parse (`voiceCommands.test.ts`, 131 tests) |
| Voice: "add a note" | ✅ fixed and tested this session |
| MCP secrets never reach the frontend | ✅ confirmed by code trace (`connections.rs`: `ServerView` carries `has_token: bool`, never a value) |
| OAuth (PKCE + dynamic client registration) for hosted MCP servers | ✅ tested, verified against live providers per code comments |
| Two-window state model (companion owns state, other windows broadcast-render) | ✅ consistent; validated at every window boundary via `isXxx` type guards |
| Windows UI Automation control (keys, clicks, `clickables`) | ✅ has a real-hardware `#[ignore]` test with manual run instructions |
| CI (`ci.yml`): fmt, clippy (blocking), full test suite, bundle build + verify, both OSes | ✅ green per the project's own standing record |

---

## 2. Partially Verified

Real code and real tests exist, but coverage or platform parity is incomplete.

| Area | What's solid | What isn't |
|---|---|---|
| macOS voice | Wake word and one-shot command listening use Whisper (compiled in, on-device) — a justified, documented substitute for the Windows closed-grammar recogniser | Weaker in practice: no closed-grammar equivalent, so it relies on a voice-activity detector and short-utterance heuristics; README still claims macOS speech is "not implemented" (stale) |
| macOS platform code generally | Compiles, has unit tests for pure logic (escaping, script shape, role/permission handling) | Never run on real Mac hardware this project's whole life — CI compiles and tests it, nobody has used it |
| `clickables` / `click_named` | Windows: real, UI-Automation-based, has a manual real-hardware test. macOS: implemented this session (System Events + `AXPress`), pure script-building logic unit-tested | macOS execution path has **zero** runs against a real Mac — brand new, unverified end to end |
| Ignored (`#[ignore]`) real-hardware tests | ~12 of them, each with clear manual run instructions in its own doc comment (audio, browser tabs, MCP handshake, OAuth round-trip, pack install, Whisper download/transcribe) | None run in CI; each requires a human to run them manually and none has a tracked cadence for doing so |
| `stats.json` dual ownership | Documented rule: companion window is the sole writer, dashboard reads it directly | Frontend audit flagged this as the one place two windows both touch the same file — "a lost-update bug waiting to happen" per the code's own comment; no incident found, but it's a structural risk worth a second look if stats ever look wrong |

---

## 3. Unverified

Written, but nothing has run it — includes code from this session.

- **macOS `clickables`/`click_named`** end-to-end (AppleScript execution against a real app). Script-building and escaping are unit-tested off-Mac; the actual `osascript` call has never run.
- **Physical Mac testing of anything**, this entire project. Every "macOS-tested" claim above means CI-compiled-and-unit-tested, not human-verified on hardware.
- **v0.6.0 release build itself** — tag pushed, CI build in flight at review time. Draft release, not yet downloaded or opened by a human.
- The ~12 `#[ignore]`d hardware tests (listed above) — last-run status unknown; nothing in the repo shows when they were last exercised.

---

## 4. Production Blockers

- **Not code-signed / notarized.** Both platforms show an OS warning (SmartScreen, Gatekeeper) on first launch. Documented and accepted for now — needs a paid certificate to clear.
- **No auto-update.** Users stay on whatever build they installed; each fix requires a manual reinstall.
- **macOS is the least-verified platform**, full stop — every gap in §2/§3 concentrates there. This is a real blocker for calling macOS support "done," not just "shipped."

## 5. Integration Issues

- **`stats.json` dual-read pattern** (§2) — not a known bug, but the one place the two-window "single writer" architecture has an exception worth watching.
- **README is stale in three places**: the feature table claims macOS speech is "not implemented" (it is, via Whisper); the test count reads "930 frontend + 51 Rust" against an actual 1707 frontend / 370 Rust `#[test]` count; and the "Not done yet" section still states Loaf's zero-network promise rules out "anything that connects one person's Loaf to another's" and any AI feature — written before the MCP/Connections tab existed, which now deliberately does make outbound network calls (Notion, Linear, Asana, Sentry, OAuth, Claude Desktop) with its own separate disclosure. Not fixed here — flagged for a deliberate update rather than folded into this review silently.
- **Two independently-maintained browser lists** existed before this session (`browser_windows.rs`'s `imp_tabs::BROWSERS` vs. the frontend's `KNOWN_BROWSERS`) — no drift found, but it's a duplication to watch; the browser-tabs fix this session made the Rust side return `.exe`-suffixed names specifically so the frontend's existing `browserFor()` could resolve them without adding a third list.

## 6. Unfinished Functionality

- **macOS `clickables`** — code complete, unverified (see §3). The only remaining gap the voice-command audit found.
- Nothing else came up as genuinely unfinished: no `TODO`/`FIXME`/`unimplemented!()` markers in either the Rust or TypeScript source, and every other platform gap found is an honest, stated stub (`"That is Windows-only for now."`) rather than a silent no-op.

---

## Architecture Summary

- **Backend** (`src-tauri/src`, ~35 modules): one `PlatformProbe` trait boundary that all OS-specific code must terminate at; MCP client and MCP server are separate, clearly-named modules (`mcp_client.rs` vs. `mcp.rs`/`mcp_stdio.rs`) for the two directions of that integration; secrets flow one-way into Rust and never back to a window.
- **Frontend** (`src/`, ~24 subfolders): two windows — companion (`main.ts`, imperative glue, intentionally untested) and dashboard (`dashboard/page.ts`, pure state→HTML, heavily tested) — talking only over named `loaf://` events, each validated at the receiving end with a type guard.
- **Testing philosophy, confirmed consistent throughout**: pure logic is exhaustively unit-tested (1707 frontend + 370 Rust tests); anything needing real hardware is written as an `#[ignore]`d test with manual instructions rather than skipped silently; platform-specific string-building (AppleScript, Windows Automation conditions) is kept in `cfg`-free modules specifically so it can be tested on the Windows PC this project is developed on.
- **CI/Release**: `ci.yml` gates on fmt + clippy + full test suite + bundle verification on both OSes; `release.yml` is tag-triggered and produces a **draft** GitHub Release (Windows build creates it, macOS attaches into it) so nothing goes public until manually published.
