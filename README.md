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

**Phase 0 (de-risk spike) — complete on both platforms.**
**Phase 1 (port the core) — in progress.**

| Phase 0 goal | Windows | macOS |
|---|---|---|
| Transparent window | ✅ verified | ✅ verified |
| Always-on-top | ✅ verified | ✅ verified |
| Undecorated, no taskbar/Dock entry | ✅ verified | ✅ verified |
| Character renders and animates | ✅ verified | ✅ verified |
| Draggable, with a tray quit | ✅ verified | ✅ verified |
| Platform adapter (foreground app, idle) | ✅ builds and runs | ✅ builds and runs |

The first Mac build failed four of these. What it took to fix them is written up
in `Known deviations` and in the commit that fixed them — the short version is
that transparency needs a Cargo feature as well as a config flag, and that
`-webkit-app-region` is an Electron API Tauri ignores entirely.

| Phase 1 | |
|---|---|
| Characters | ✅ **18 of 18** — 6 cats, 4 dogs, shiba, ghost, capybara, duck, fairy, droid, robot, plane |
| Drawing-area overshoots | ✅ all five fixed, contract test has no exemptions left |
| Outfits + seasonal calendar | ✅ 6 garments |
| Pixel-art mode | ✅ |
| Ambient behaviour, curl, fur ball, window walk | ✅ |
| Focus timer | ✅ session logic, ring and pill on the character, and its own window |
| Screen-time tracker | ✅ accumulation and storage |
| Dashboard + hover preview | ✅ both views; the dashboard opens in its own window |
| Tray menu | ✅ focus, today's time, closet, star the repo, quit |
| Speech bubbles + hover preview | ✅ break nudge speaks; hovering shows today's card |
| Closet | ✅ all 18 characters, 6 garments, seasonal, per-character names, pixel toggle, habits |
| Privacy radar | ✅ both platforms — domains, tab counts, tantrums |
| Sounds | ✅ four occasions, synthesised placeholders, your own files win |
| Onboarding | ✅ the radar's consent screen, honest per platform |
| Sprite packs | ✅ hand-drawn characters load from a folder, beside the shipped 18 |
| Moods | ✅ all 7 reference rungs live |
| Next | **parity reached.** Nothing from the reference is unported |

**Phase 2 (beyond the reference) — in progress.**

| Phase 2 | |
|---|---|
| Water reminder | ✅ own 45-minute clock, its own tally, silent during focus |
| Send him to sleep | ✅ menu item; only an explicit tap wakes him |
| Eyes follow the pointer | ✅ pupils drift inside a fixed socket, eased |
| Version shown in the app | ✅ dashboard footer |
| Radar settings persist | ✅ and fail closed — a corrupt value can only switch it OFF |
| Right-click the character | ✅ the same menu the tray shows, one definition |
| Hyperfocus check-in | ✅ asks once after 90 minutes unbroken, re-armed only by a real break |
| Wander is one switch | ✅ drift no longer moves the window with wandering off |
| Typing pose | ✅ ninth mood — timing only, never which key |
| Waits while your machine works | ✅ foreground CPU, Windows; macOS reports "no idea" |
| Fades until you look at him | ✅ on by default, eased, solid while dragging or speaking |
| Hover card can be switched off | ✅ closet toggle |

Tests: **693 frontend** (Vitest) + **51 Rust**. CI green on macOS and Windows.

**v0.2.1 released** as a pre-release, and verified by running it on Windows:
the tracker attributing seven applications into the right hourly buckets, Reset
clearing the file on disk, the window actually moving when dragged, seven menu
items, the closet across fifteen characters, the focus timer, and the radar
reading a domain out of Chrome via UI Automation without stalling the render
loop.

The first Mac reports arrived against that build and found three things a green
test suite could not: the character was stuck on one Space, the preview card
sat below other windows on Windows, and a single click felt dead because it
waited 260ms for a possible second one. All three are fixed and none of them
had a failing test to their name.

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
cd src-tauri && cargo fmt --all   # CI fails on this before it runs anything else
cd src-tauri && cargo test        # platform-adapter tests
```

`cargo fmt` needs no compilation, so it works on this machine even though
`cargo build` does not — and it is the first step of the Rust CI job, which
means an unformatted file fails the run before clippy or the tests get a chance
to say anything useful. Run it before every push.

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
  behaviour/             Ambient layer: curl, play, wander, the fur ball
  focus/timer.ts         Focus sessions, counted to a wall-clock deadline
  focus/view.ts          The dial's words and numbers, derived from a snapshot
  tracker/tracker.ts     Screen time. Pure: a string in, a string out.
  dashboard/html.ts      Both dashboard views, as markup
  dashboard/page.ts      The dashboard window's entry point
  dashboard/events.ts    The two events the two windows speak over
  bubble/geometry.ts     Where the bubble goes — y-DOWN, unlike the reference
  bubble/render.ts       The speech bubble's card and tail
  bubble/prompts.ts      What it says, and when it stays quiet
  behaviour/habits.ts    The four habits a user can switch, and remembering them
  behaviour/scroll.ts    The scrolling pose's rise-and-decay trigger
  sound/voice.ts         What Loaf sounds like — placeholders, and when to be quiet
  onboarding/view.ts     The radar's consent screen, and the deal it states
  sprites/manifest.ts    character.json, validated — the gate a pack must pass
  closet/settings.ts     The persisted choices, and the only writer of them
  closet/view.ts         The picker's markup — thumbnails are live canvases
  radar/radar.ts         Tab counts, tantrum hysteresis, per-browser permission
src-tauri/
  src/platform/          The OS seam. Everything native terminates here.
  src/storage.rs         The one file on disk, and the path it must keep using
  src/browser.rs         Reading a tab's domain — AppleScript on macOS
  src/browser_windows.rs UI Automation on Windows, and what that costs
  src/sounds.rs          The user's own sound files, and the folder README
  src/packs.rs           Hand-drawn characters, read off disk
  src/scroll.rs          Seconds since the wheel moved — and what it deliberately is not
  capabilities/          What the two windows may ask the Tauri core for
tests/                   Vitest suites
  registry.test.ts       Contract tests every companion must satisfy
```

### Four contracts worth knowing before changing anything

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

**4. `stats.json` is real users' history.** People already running the Swift app
have months of screen time at `<data dir>/LoafPlus/stats.json`. This must keep
reading that file and keep writing one the Swift app can still read. Two
consequences that look like tidying and are not: the path is spelled out
literally rather than derived from the bundle identifier (Tauri's
`app_data_dir()` resolves elsewhere and would silently start everyone over), and
parsing tolerates every missing key rather than validating a schema. The Swift
hand-writes its decoder for exactly this reason — a synthesised one treats every
key as required and throws the whole history away when it meets an older file.
Both are pinned by tests.

## Known deviations from the reference

**Five badge-strip overshoots — fixed, not ported.** The reference lets five
characters draw into the reserved tab-badge strip. These are corrected here
rather than reproduced, because the strip is a contract and a faithful port of a
collision is just a collision:

| | reference | here |
|---|---|---|
| `cat-indie` ears (scrolling) | y = 169.24 | clamped, lean kept |
| `dog-husky` ears (scrolling) | y = 170.00 | clamped, lean kept |
| droid antenna | 172 | 165 |
| robot aerials | 180 | assembly 14pt lower |
| fairy horns (tantrum) | 178 | 165, squashed not truncated |

The ears were clamped in height only, so the scrolling pose still tips them
forward — it just stops them growing. The other three were structural, and a
clamp would have flattened each tip into a flat chord, so they were shortened
instead. The fairy's mattered most: her horns exist *only* in the tantrum pose,
which is exactly the pose a tab alert forces, so the transformation announcing
"too many tabs" and the badge counting them were drawn into the same space by
construction, every time.

Every fix has a test that proves it, plus two that guard the lazy version — that
clamping did not flatten the scrolling lean into idle, and that shortening did
not remove the horns.

**Robot feet at y = 12** — one point under the ground plane, left as the
reference has it. A single point of overlap with the floor reads as contact
rather than error, and unlike the badge strip nothing competes for that space.

**Day rollover is computed, not cached.** The reference caches the current day
key and refreshes it inside `tick`, so between midnight and the next tick the
totals still answer for yesterday. Deriving it costs nothing, so this port does.

**The radar reads tabs two different ways, and says which.** On macOS the
AppleScript truncates the URL to its host *inside the browser*, so the path and
query never cross a process boundary. Windows has no such route: UI Automation
reads the address bar as text, so the full URL exists in Loaf for the few
microseconds before `host_of` cuts it down. That is disclosed in the dashboard
rather than glossed over, and two mitigations keep the gap small — the read is
skipped entirely while the address bar has focus (a half-typed search query is
not a domain), and the truncation happens in Rust before the value can reach the
frontend, storage or a log.

**The `scrolling` mood asks one question and no more.** The reference gets it
from a global scroll monitor. Here neither platform installs a hook: macOS calls
`CGEventSourceSecondsSinceLastEventType`, the permission-free API the reference
itself falls back to and the same family the tracker uses for idle time; Windows
listens for Raw Input on a message-only window, which *receives copies* of
events rather than sitting in their delivery path the way `WH_MOUSE_LL` would.
Only the wheel flag is read — the movement deltas that arrive in the same struct
are ignored — and all either platform can answer is "how long since the wheel
moved". See `src-tauri/src/scroll.rs`.

**No sample data anywhere.** The reference fills days it never recorded with a
seeded 1.5–4.5h bar (hatched, captioned "sample") and falls back to an invented
knowledge-worker curve for the hour chart until two real hours exist — so a
fresh install opens onto a full-looking dashboard of fiction. Removed. Charts
begin at the first day actually recorded and say so; unrecorded days inside that
range are drawn empty; no peak hour is named until there is measured time behind
it. A caption disclaiming a chart is smaller than the chart doing the claiming.

## Not done yet

This section was itself out of date for a while, listing the radar, the
dashboard, the closet, the tray and onboarding as missing long after they
shipped. What is genuinely outstanding:

**Signing.** Neither platform is signed, so macOS blocks the app on first launch
and Windows shows a SmartScreen warning. Both need a paid certificate — an
Apple Developer ID and a Windows code-signing cert.

**Your own sounds, and hand-drawn character packs.** Both work if you place
files in the folders yourself; neither is finished enough to point a button at,
and both are labelled "coming soon" in the app rather than pretending otherwise.

**Updates.** There is no updater. Nothing checks for a new version, tells you
one exists, or downloads anything — so a user stays on the build they installed
until they fetch another by hand. That is a deliberate consequence of the
zero-network promise, not an oversight; see the note on it below.

**Verified on a Mac by a person.** The macOS build compiles, its platform code
is unit-tested, and testers have now run it — but far less of it has been
exercised there than on Windows.

### The zero-network promise, and what it costs

Loaf makes no network calls, keeps no account and uploads nothing. That is the
product, not a feature, and it rules things out: auto-update, any AI feature,
and anything that connects one person's Loaf to another's. Each of those is
buildable and each would end the sentence "Loaf itself does not upload your data
or make AI/network calls". They are decisions to take deliberately and to say
out loud, not to arrive at by adding a convenience.

## Licence

None yet — this is a gap, not a choice. Until a `LICENSE` file exists, default
copyright applies and nobody else may use this code.
