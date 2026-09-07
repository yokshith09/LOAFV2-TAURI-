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

# ------------------------------------------------------------ usage strings --
PLIST="$APP/Contents/Info.plist"
for key in NSMicrophoneUsageDescription NSAppleEventsUsageDescription; do
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
