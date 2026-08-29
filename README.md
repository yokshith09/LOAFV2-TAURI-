# Loaf — Tauri rewrite

A private desktop companion that understands **how** you spend your time without
recording **what** you do.

This repository is the cross-platform (macOS + Windows) rewrite of the original
macOS-only Swift/AppKit app. The Swift version remains the **reference
implementation** — it is read while porting, and its architecture is preserved
deliberately. None of its code ships here.

> **Status: Phase 0 — de-risk spike.** Not a product yet. The purpose of this
> phase is to prove the architecture works, or to fail cheaply if it does not.

---

## What Phase 0 set out to prove

| Goal | State |
|---|---|
| Transparent, always-on-top, undecorated window on both platforms | Configured; **needs a real run on each OS to confirm** |
| The ported character renders and animates in a webview canvas | **Verified** — all seven moods, six coats |
| One platform-adapter seam that hides the OS from everything above | **Built** — `PlatformProbe`, implemented for Windows and macOS |
| Frontend unit tests | **77 passing** |

## Requirements

- **Node 20+** and npm
- **Rust** (stable, MSVC toolchain on Windows)
- **Windows:** Visual Studio Build Tools with the *Desktop development with C++*
  workload — Rust needs `link.exe`. WebView2 runtime (already present on
  Windows 11).
- **macOS:** Xcode Command Line Tools.

```bash
npm install
npm run tauri:dev     # run the app
npm test              # frontend unit tests
npm run typecheck
cd src-tauri && cargo test    # platform-adapter tests
```

## Getting a Mac build and a Windows build

Tauri compiles for the **host** OS — one machine cannot produce both. A Windows
machine builds `.msi`/`.exe`; a Mac builds `.app`/`.dmg`.

`.github/workflows/ci.yml` runs the build on a `macos-latest` runner and a
`windows-latest` runner in parallel and uploads both as artefacts, so one push
produces both installers.

## Layout

```
src/                     Frontend (TypeScript, no framework)
  core/types.ts          The Companion contract + design-space constants
  core/draw.ts           Bezier primitives (AppKit-shaped, Canvas-backed)
  companions/            Coat data + the shared cat drawing engine
  render/scene.ts        Fit transform and the y-up -> y-down flip
  render/face.ts         Shared mood/eye system, species-agnostic
src-tauri/
  src/platform/          The OS seam. Everything native terminates here.
tests/                   Vitest suites (77)
```

### Two contracts worth knowing before changing anything

**1. The design space.** All art is authored in a fixed **170 x 190** space with
**y pointing up**, inherited unchanged from the Swift original so ported bezier
numbers stay literally identical and diffable. Canvas is y-down; a single flip
transform in `render/scene.ts` reconciles them. Ground plane sits at y = 13. The
strip **y 166..190 belongs to the tab badge** — nothing else may draw there.

**2. The platform seam.** Everything OS-specific lives behind `PlatformProbe`.
Tauri gives one UI and one build pipeline; it does **not** give one way to ask
the OS what app is in front. That gets implemented twice, and nothing above the
seam learns which OS it is on.

## Known deviations from the reference

- **Latent ear overshoot.** The indie cat's ears reach y = 169.24 in the
  `scrolling` pose, inside the reserved badge strip. Ported faithfully rather
  than silently corrected. Currently unreachable — a tab alert forces `tantrum`,
  which leans the same ear down to 158.8 — and pinned by a test so it cannot
  quietly get worse. See `tests/scene.test.ts`.

## Not done yet

Signing and notarisation (macOS), code signing (Windows), tracking, privacy
radar, focus timer, the closet, and everything else in Priorities 1–6 of the
product direction. Phase 0 deliberately stops at the spike.

## Licence

None yet — this is a gap, not a choice. Until a `LICENSE` file exists, default
copyright applies and nobody else may use this code.
