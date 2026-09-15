# Loaf — Milestones

Tracks what shipped, when, and what's still open. The `M1`/`M3`/`M4` labels
below are the project's own internal numbering, found in code comments
(`grep -rn "M1\|M3\|M4" src-tauri/src` for the primary sources) — recorded here
so they live in one place instead of only in scattered doc comments. No `M2`
reference was found in the code; if one exists it is not written down
anywhere this review could find, so it is left out rather than guessed at.

## M1 — Meeting recording + local transcription
**Status: shipped.** Your own microphone only, local Whisper transcription,
audio deleted the moment the transcript exists. `audio.rs`'s
`records_and_transcribes_for_real` (an `#[ignore]`d real-hardware test) is
described in its own doc comment as "the actual proof M1 exists for."

## M3 — Search, delete, export (the store)
**Status: shipped.** SQLite-backed store (`store.rs`) replacing the old
per-feature JSON files; a delete screen (Forget Range) that previews exactly
what will go before confirming; full-text search across kept transcripts.
Referenced in `lib.rs` ("The store (M3): search, delete, export") and
`search.ts` (the delete-screen requirement).

## M4 — Voice, beyond the closed grammar
**Status: partially shipped, one stage explicitly still open.**
- Wake word + one-shot command listening: shipped, Whisper-backed on macOS,
  Windows closed-grammar recogniser on Windows.
- **Stage two** (`wake.rs`): an ONNX-runtime wake-word model — referenced as
  not yet built ("needs an ONNX runtime; this is [a placeholder]").
- **Stage four** (`commands.ts`): an instruct model emitting constrained JSON
  for the command parser, replacing the current regex-rule parser — referenced
  as "still the right answer" but not yet built.

## Unnumbered — this session (2026-09-14), against the user's own P0/P1 list

Verified complete and pushed (see `ARCHITECTURE-REVIEW.md` §1 for the full
list with test evidence):

- Claude activity reactions fixed to fire once per burst, not once per tool
  call (P0 #1).
- MCP Connections catalog reworked: raw form folded behind an "advanced"
  toggle, unsupported services shown as "Coming soon" tiles, call log gained
  Save/Clear and a per-call details fold (P0 #2).
- Sleep/Quiet made genuinely silent, including a second leak in native OS
  notifications this session's own audit found and fixed (P0 #3).
- Notes: archive is its own field, no longer aliased to the task checklist's
  `done`; a search box added (P0 #4).
- Timing wording rewritten throughout ("Due in 20 minutes", not "20m") (P0 #5).
- Browser tabs: every supported browser and every one of its windows, not
  just the first match (P0 #6).
- Forget Range: audited, already complete, no change needed (P0 #7).
- Whisper audit: every non-meeting use (wake word, macOS command listening,
  free-form dictation) confirmed already justified in code (P1 #8).
- Voice command audit: full phrase → parser → action pipeline confirmed
  wired correctly end to end; the one real gap found (macOS `clickables`)
  was then built, not just documented (P1 #9).
- Notification system confirmed to funnel through two gates (`say()` for
  bubbles, the new `notifyNative()` for OS toasts), both respecting sleep
  (P1 #10).
- **New:** macOS `clickables`/`click_named` implemented via System Events —
  code complete, unverified on real hardware (see `ARCHITECTURE-REVIEW.md`
  §3).
- Version bumped to **0.6.0**, tagged, and pushed — draft release building
  for Windows + macOS testing.

## v0.6.1 — the closet couldn't see a pack it had already loaded correctly

A user-supplied character pack (Dalgom: a real `character.json` plus a
~45-megapixel hand-drawn sheet) parsed and merged into the roster correctly,
and still never appeared as a choice in the Closet. Root cause: the Closet
window's own picker read only the static built-in list; it never asked Rust
for sprite packs at all, unlike the companion window. Fixed by having the
Closet ask independently (a `Companion`'s draw closures can't cross the
window boundary, so it can't just be handed one). Also replaced the
dashboard's two dashed "Soon" cards for sounds/packs with real buttons — both
features were already fully built.

## v0.6.2 / v0.6.3 — making failure visible on a build with no devtools

The pack still didn't show up after the v0.6.1 fix, and nothing explained
why — this build ships with no devtools, so a `console.warn` about a broken
pack was a message nobody could open. Added: a failure notice printed
directly on the Closet shelf (both "one pack failed" and "the whole request
to Rust failed" cases), a timeout so a stalled image decode reports as a
failure instead of hanging forever with nothing shown, and marked the
pack-reading command `async` so a large sheet can't block the whole app
while it loads.

## v0.6.4 — the reactions were real, the report was being eaten

Live-tested `report_status` (new: an MCP tool letting Claude Code, not just
Claude Desktop, tell Loaf what it's doing — thinking, working, a build or
checks passing/failing, a push, a deploy) through a real MCP connection from
this Claude Code session. Rust confirmed every write; nothing reacted on
screen. Root cause, found only because this test was run for real: the
watcher treated "the first time this loop has successfully read the file" as
"stale, from before Loaf launched" — which silently ate the very first
activity or status report after every restart, even when it was genuinely
fresh. This likely explains every earlier "Claude is connected but nothing
happens" report this session, not just `report_status`. Fixed by comparing
against the watcher's own start time instead.

Also fixed while investigating "the moods don't look right for Dalgom": the
shared tantrum "fur bristling" overlay was drawing on top of ANY companion's
tantrum frame, sprite packs included, even one with its own complete tantrum
art — and the alt-click mood-preview dev tool lost to typing/scrolling/
working, making it nearly impossible to use for its actual job of comparing
a pack's moods while describing them out loud.

## What's next

1. **Confirm v0.6.4's fix actually shows a bubble on screen** — the write and
   the MCP connection are proven live; the visual result on the user's
   machine is not yet confirmed back.
2. **Answer, then re-verify, "does search work and are meetings not getting
   transcribed"** — asked directly, not yet answered; M1/M3 below say
   "shipped," but so did the Closet pack picker.
3. **Set up a guided way to connect Claude Code (not just Claude Desktop) to
   Loaf's MCP server** — right now this is a manual, per-machine step with no
   in-app flow, unlike the documented one-click Claude Desktop connection.
4. **Physical Mac testing**, generally — the standing gap across this whole
   project. All of this session's live testing (packs, MCP status) was done
   on Windows.
5. Decide whether to pick up **M4 stage two** (ONNX wake-word model) or
   **stage four** (instruct-model command parser) next, or leave both as
   documented future work.
6. The three README staleness items in `ARCHITECTURE-REVIEW.md` §5 (macOS
   speech claimed unimplemented, test counts, the zero-network section not
   accounting for MCP Connections) — worth a deliberate pass when there is
   time to write it carefully rather than as a side effect of something else.
