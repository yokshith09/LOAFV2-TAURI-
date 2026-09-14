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

## What's next

1. **Test the v0.6.0 draft release** on both platforms — this is the first
   real human contact with several of this session's fixes, and the only way
   to find out whether macOS `clickables` actually works.
2. **Physical Mac testing**, generally — the standing gap across this whole
   project, not new to this release.
3. Decide whether to pick up **M4 stage two** (ONNX wake-word model) or
   **stage four** (instruct-model command parser) next, or leave both as
   documented future work.
4. The three README staleness items in `ARCHITECTURE-REVIEW.md` §5 (macOS
   speech claimed unimplemented, test counts, the zero-network section not
   accounting for MCP Connections) — worth a deliberate pass when there is
   time to write it carefully rather than as a side effect of something else.
