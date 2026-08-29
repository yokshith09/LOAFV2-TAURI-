# Loaf — Tauri rewrite

A private desktop companion that understands **how** you spend your time without
recording **what** you do.

This repository is the cross-platform (macOS + Windows) rewrite of the original
macOS-only Swift/AppKit app. The Swift version remains the **reference
implementation** — it is read while porting, and its architecture is preserved
deliberately. None of its code ships here.

**[Download v0.1.0](https://github.com/yokshith09/LOAFV2-TAURI-/releases/tag/v0.1.0)**
· macOS (universal) and Windows. Unsigned — see the release notes before opening.

---

## Status

**Phase 0 (de-risk spike) — complete on Windows, pending on macOS.**
**Phase 1 (port the core) — in progress.**

| Phase 0 goal | Windows | macOS |
|---|---|---|
| Transparent window | ✅ verified | ⏳ awaiting testers |
| Always-on-top | ✅ verified | ⏳ |
| Undecorated, no taskbar/Dock entry | ✅ verified | ⏳ |
| Character renders and animates | ✅ verified | ⏳ |
| Platform adapter (foreground app, idle) | ✅ builds and runs | ⏳ |

| Phase 1 | |
|---|---|
| Characters ported | **11 of 18** — 6 cats, 4 dogs, 1 ghost |
| Remaining | shiba, capybara, duck, fairy, droid, robot, plane |
| Then | outfits, pixel-art mode, ambient behaviour |

Tests: **120 frontend** (Vitest) + **19 Rust**. CI green on macOS and Windows.

---

## Requirements

- **Node 20+** and npm
- **Rust** (stable, MSVC toolchain on Windows)
- **Windows:** Visual Studio Build Tools with *Desktop development with C++* —
  Rust needs `link.exe`. WebView2 runtime (already present on Windows 11).
- **macOS:** Xcode Command Line Tools.

```bash
npm install
npm run tauri:dev     # run the app
npm test              # frontend unit tests
npm run typecheck
cd src-tauri && cargo test   # platform-adapter tests
```

Most of Phase 1 is TypeScript and needs no Rust at all — `npm run dev` opens the
companion in a browser, which is enough for character and outfit work.

### Windows: Smart App Control

If `cargo` fails with **"An Application Control policy has blocked this file"
(os error 4551)**, Smart App Control is enforced and is blocking the unsigned
executables Cargo compiles for build scripts.

Redirecting the build output off a secondary drive helps — create
`src-tauri/.cargo/config.toml` (gitignored) with:

```toml
[build]
target-dir = "C:/Users/YOU/AppData/Local/loaf-target"
```

Be aware this is **not reliable**: Smart App Control re-evaluates each newly
compiled binary, so some builds still get blocked. The dependable path is CI.
Turning Smart App Control off does fix it permanently, but that cannot be undone
without reinstalling Windows, so decide deliberately.

## Getting a Mac build and a Windows build

Tauri compiles for the **host** OS — one machine cannot produce both.

- `.github/workflows/ci.yml` builds on `macos-latest` and `windows-latest` in
  parallel on every push and uploads both as artefacts.
- `.github/workflows/release.yml` runs on a version tag, builds a **universal**
  macOS binary plus a Windows installer, and attaches them to a GitHub Release:

  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```

  The release is created as a **draft** — publish it when you have looked at it.

## Layout

```
src/                     Frontend (TypeScript, no framework)
  core/types.ts          The Companion contract + design-space constants
  core/draw.ts           Bezier primitives (AppKit-shaped, Canvas-backed)
  companions/            Coat/breed data, the two shared engines, one-off characters
  companions/registry.ts The closet's stock — one line per character
  render/scene.ts        Fit transform and the y-up -> y-down flip
  render/face.ts         Shared mood/eye system, species-agnostic
src-tauri/
  src/platform/          The OS seam. Everything native terminates here.
tests/                   Vitest suites
  registry.test.ts       Contract tests every companion must satisfy
```

### Three contracts worth knowing before changing anything

**1. The design space.** All art is authored in a fixed **170 x 190** space with
**y pointing up**, inherited unchanged from the Swift original so ported bezier
numbers stay literally identical and diffable. Canvas is y-down; a single flip
transform in `render/scene.ts` reconciles them. Ground plane sits at y = 13. The
strip **y 166..190 belongs to the tab badge** — nothing else may draw there.

**2. The platform seam.** Everything OS-specific lives behind `PlatformProbe`.
Tauri gives one UI and one build pipeline; it does **not** give one way to ask
the OS what app is in front. That gets implemented twice, and nothing above the
seam learns which OS it is on. Probes return `Result<Option<_>>` on purpose:
"the OS refused" and "nothing is in front" are different states, and neither may
be recorded as a guess.

**3. A character is one file plus a registry line.** Enforced by
`tests/registry.test.ts`, which holds anything in the registry to the same rules
— anchors inside the head box, eyes level and centred, paints something in every
mood, balanced save/restore, clears the badge strip while cross. If a new
character needs changes to the renderer, the contract has been broken somewhere.

## Known deviations from the reference

**Latent ear overshoot — both drawing engines.** In the `scrolling` pose the ears
lean *up*; in `tantrum` they lean *down*. For the tallest ears in each engine the
scrolling tip lands inside the reserved tab-badge strip:

| | scrolling | tantrum |
|---|---|---|
| `cat-indie` | y = 169.24 ❌ | 158.8 ✅ |
| `dog-husky` | y = 170.00 ❌ | 159.0 ✅ |

Neither engine bounds-checks the scrolling lean, so this is a pattern in the
reference rather than a one-off. It is currently unreachable — a tab alert forces
the `tantrum` pose (`CompanionView.swift:113`), which pulls the same ears clear —
so it has been ported faithfully rather than silently corrected, and pinned by a
test in both engines so it cannot quietly worsen. It becomes visible if the badge
is ever shown outside `tantrum`, or if a character gets taller ears.

## Not done yet

Signing and notarisation (macOS), code signing (Windows), tracking, the privacy
radar, the focus timer, the closet UI, the tray, and everything else in
Priorities 1–6 of the product direction.

## Licence

None yet — this is a gap, not a choice. Until a `LICENSE` file exists, default
copyright applies and nobody else may use this code.
