#!/usr/bin/env bash
#
# Does the .app we just built actually open on somebody else's Mac?
#
# WHY THIS EXISTS. Every macOS build up to 0.4.3 shipped with NO CODE SIGNATURE
# AT ALL. Not "signed by an unknown developer" — unsigned. Tauri's bundler skips
# its whole signing block unless an identity is configured, and none was. On
# Apple Silicon, Gatekeeper's verdict for a quarantined bundle with no signature
# is not the mild "unidentified developer" warning the release notes promised;
# it is "Loaf is damaged and can't be opened", whose only button is Move to
# Trash. Three testers hit exactly that.
#
# It went unnoticed for four releases because every check we had was a compile
# check. `cargo build` succeeding says nothing about whether the bundle it
# produced is openable, and the machine this project is developed on is a PC —
# a CI runner is the only Mac in the loop, so the check has to live here.
#
# So this script asserts the two things that are true of an app that opens and
# were false of the ones we shipped:
#
#   1. Contents/_CodeSignature exists and `codesign --verify --deep --strict`
#      is happy with it.
#   2. Info.plist carries the usage strings for the private data the app
#      touches. Missing ones do not deny the request — macOS terminates the
#      process, with no dialog and no log a user would find.
#
# It does NOT assert that Gatekeeper approves. It cannot: an ad-hoc signature is
# not a Developer ID and the build is not notarised, so `spctl` rejects it by
# design and will keep rejecting it until there is a paid Apple account behind
# the build. The verdict is printed rather than enforced, because the exact
# wording is the difference between "rejected, source=Unnotarized" (fine — the
# user can Open Anyway) and "rejected, source=no usable signature" (the bug
# above, back again).

set -euo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
  APP="$(find src-tauri/target -maxdepth 6 -type d -name 'Loaf.app' | head -1)"
fi

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "FAIL: no Loaf.app was produced. Looked under src-tauri/target." >&2
  exit 1
fi
echo "Checking $APP"
echo

# ---------------------------------------------------------------- signature --
if [ ! -d "$APP/Contents/_CodeSignature" ]; then
  echo "FAIL: no Contents/_CodeSignature — this bundle is unsigned." >&2
  echo "      A quarantined unsigned app reads as DAMAGED on Apple Silicon." >&2
  echo "      Check bundle.macOS.signingIdentity in tauri.conf.json." >&2
  exit 1
fi
echo "  _CodeSignature present"

codesign --verify --deep --strict --verbose=2 "$APP"
echo "  codesign --verify --deep --strict: passed"

codesign -dvv "$APP" 2>&1 | sed 's/^/    /'
echo

# --------------------------------------------- hardened runtime, if it is on --
#
# Tauri turns hardened runtime ON by default, and we turn it back off in
# tauri.conf.json. That is not laziness: hardened runtime DENIES the microphone
# unless the bundle carries com.apple.security.device.audio-input, and denies
# Apple Events unless it carries com.apple.security.automation.apple-events.
# With neither entitlement, meeting recording and the frontmost-app probe would
# both fail — quietly, on somebody else's machine, in a build that signs and
# verifies perfectly. Hardened runtime buys nothing until there is a Developer
# ID to notarise with, so it stays off until there is one.
#
# When it does get turned on, this catches the entitlements being forgotten.
if codesign -dvv "$APP" 2>&1 | grep -q 'flags=.*runtime'; then
  ENT="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || true)"
  for needed in com.apple.security.device.audio-input                 com.apple.security.automation.apple-events; do
    case "$ENT" in
      *"$needed"*) echo "  hardened runtime + $needed" ;;
      *) echo "FAIL: hardened runtime is on but $needed is missing." >&2
         echo "      The mic and the frontmost-app probe would be denied." >&2
         exit 1 ;;
    esac
  done
  echo
fi

# --------------------------------------------------------------- which chips --
#
# Printed always, and it is the only way to tell a universal build from a
# single-architecture one after the fact. A .dmg named "universal" that holds
# one architecture is the worst outcome available here: it installs fine, it
# runs fine on the machine that built it, and it refuses to open on half the
# Macs it was made for.
BIN="$APP/Contents/MacOS/Loaf"
if [ -f "$BIN" ]; then
  ARCHS="$(lipo -archs "$BIN" 2>/dev/null || echo unknown)"
  echo "  architectures: $ARCHS"
  case "$APP" in
    *universal*)
      case "$ARCHS" in
        *arm64*x86_64*|*x86_64*arm64*) echo "  universal: both present" ;;
        *) echo "FAIL: built as universal but only holds: $ARCHS" >&2; exit 1 ;;
      esac
      ;;
  esac
fi
echo

# ------------------------------------------------- CAN IT ACTUALLY BE RUN? --
#
# ADDED AFTER 0.5.1 SHIPPED AND macOS SAID "The application Loaf can't be
# opened." That is not Gatekeeper — Gatekeeper says "damaged" or "unidentified
# developer" — it is LaunchServices failing to exec the binary at all. Every
# check above passed on that build: it was signed, it verified, it declared its
# usage strings and it held both architectures. All of them inspect the bundle's
# METADATA, and none of them asked the only question that matters, which is
# whether the thing runs.
#
# The difference between 0.4.6, which launched, and 0.5.1, which did not, is
# that whisper.cpp and SQLite are now compiled in. That points at the loader.

if [ ! -x "$BIN" ]; then
  echo "FAIL: $BIN is not executable." >&2
  echo "      lipo writes a new file; if it did not inherit the mode, macOS" >&2
  echo "      cannot exec it and says the application cannot be opened." >&2
  ls -l "$BIN" >&2
  exit 1
fi
echo "  executable bit: set"

# EVERY LINKED LIBRARY MUST EXIST ON SOMEBODY ELSE'S MACHINE.
#
# A dependency resolved from the build tree — a cmake output directory, a
# Homebrew prefix — loads perfectly on the runner that built it and is missing
# everywhere else. The app then fails to launch with exactly the dialog above
# and no other symptom. This is the single most likely way for compiling
# whisper.cpp in to have broken a build that previously worked.
# ONLY THE INDENTED LINES ARE LIBRARIES.
#
# `otool -L` on a FAT binary prints a header per architecture:
#
#     .../Loaf (architecture x86_64):
#     <tab>/usr/lib/libc++.1.dylib (compatibility version ...)
#     .../Loaf (architecture arm64):
#
# The first version of this skipped one line and read every header as a library
# path, so the universal build failed a check the single-architecture builds
# passed — and it looked exactly like the bug being hunted. Library lines are
# the indented ones; headers start at column zero.
BAD="$(otool -L "$BIN" | grep -E '^[[:space:]]' | awk '{print $1}'         | grep -v '^/usr/lib/' | grep -v '^/System/Library/' || true)"
if [ -n "$BAD" ]; then
  echo "FAIL: the binary depends on libraries that will not exist elsewhere:" >&2
  echo "$BAD" | sed 's/^/        /' >&2
  exit 1
fi
echo "  linked libraries: all from /usr/lib or /System/Library"

# AND FINALLY, RUN IT. Three seconds is enough for dyld to fail.
#
# The runner is headless, so the app cannot open a window and will exit or hang
# — either is fine and neither is checked. What IS checked is the class of
# failure dyld reports before any of that: a missing library, a missing symbol,
# a rejected signature. Those are the ones that reach a user as "cannot be
# opened", and they are invisible to every other check in this file.
echo "  trying to run it"
LAUNCH="$(mktemp)"
( "$BIN" >"$LAUNCH" 2>&1 & echo $! >"$LAUNCH.pid" ) || true
sleep 3
kill "$(cat "$LAUNCH.pid" 2>/dev/null)" 2>/dev/null || true
if grep -qE "Library not loaded|Symbol not found|code signature|no suitable image|Abort trap" "$LAUNCH"; then
  echo "FAIL: the binary will not load:" >&2
  sed 's/^/        /' "$LAUNCH" >&2
  exit 1
fi
echo "  it loads (no dyld or signature failure)"
sed 's/^/        /' "$LAUNCH" | head -5
echo

# ------------------------------------------------------------ usage strings --
PLIST="$APP/Contents/Info.plist"
for key in NSMicrophoneUsageDescription NSAppleEventsUsageDescription LSUIElement; do
  if ! /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" >/dev/null 2>&1; then
    echo "FAIL: Info.plist has no $key." >&2
    echo "      macOS kills the process outright the first time it asks for" >&2
    echo "      this data without a string to show. See src-tauri/Info.plist." >&2
    exit 1
  fi
  echo "  $key: $(/usr/libexec/PlistBuddy -c "Print :$key" "$PLIST")"
done
echo

# ------------------------------------------------- Gatekeeper, for the record --
echo "Gatekeeper verdict (informational — an unnotarised build is expected to"
echo "be rejected; what matters is that the reason is notarisation, not the"
echo "absence of a signature):"
spctl --assess --type exec --verbose=4 "$APP" 2>&1 | sed 's/^/    /' || true
echo
echo "OK: the bundle is signed, verifiable, and declares what it touches."
