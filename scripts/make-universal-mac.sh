#!/usr/bin/env bash
#
# One Mac download that runs on both Apple Silicon and Intel.
#
# WHY THIS IS DONE BY HAND rather than with `--target universal-apple-darwin`.
# Tauri's own universal build has failed every single time it has been tried —
# v0.3.0, v0.4.0, v0.4.1, and again on the CI row added to diagnose it — while
# the plain per-architecture builds have passed every single time. Four attempts
# is enough. The error is not readable from the machine this project is
# developed on (a PC, with no authenticated GitHub CLI), so the choice was
# between another round of guessing and removing the unknown.
#
# This removes it. Both halves demonstrably build; v0.4.4 shipped both. All that
# was ever missing is the step that joins them, and that step is one `lipo`
# call. Nothing here is clever and every part of it is a tool that has done this
# job for twenty years.
#
# THE ORDER MATTERS AND IT IS NOT OBVIOUS:
#
#   1. lipo the executables together
#   2. strip extended attributes
#   3. sign
#   4. make the .dmg
#
# Signing before lipo would be pointless — replacing the executable invalidates
# the signature, and the result is a bundle macOS calls "damaged", which is the
# exact bug v0.4.4 existed to fix. Making the .dmg before signing would ship an
# unsigned app inside a correct-looking disk image. Both mistakes produce a file
# that builds green and cannot be opened.

set -euo pipefail

ARM="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Loaf.app"
X64="src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Loaf.app"
OUT="${1:-universal}"
VERSION="$(node -p "require('./package.json').version")"

for app in "$ARM" "$X64"; do
  if [ ! -d "$app" ]; then
    echo "FAIL: $app is missing. Both architectures must be built first." >&2
    exit 1
  fi
done

rm -rf "$OUT"
mkdir -p "$OUT/stage"

# The Apple Silicon bundle is the base. Everything outside the executable —
# Info.plist, icons, the web assets — is identical between the two, so which one
# is copied does not matter; what matters is that only ONE is copied, so there
# is no chance of two different builds' resources being mixed.
cp -R "$ARM" "$OUT/stage/Loaf.app"

echo "Merging the two executables"
lipo -create \
  "$ARM/Contents/MacOS/Loaf" \
  "$X64/Contents/MacOS/Loaf" \
  -output "$OUT/stage/Loaf.app/Contents/MacOS/Loaf"

ARCHS="$(lipo -archs "$OUT/stage/Loaf.app/Contents/MacOS/Loaf")"
echo "  now holds: $ARCHS"
case "$ARCHS" in
  *arm64*x86_64*|*x86_64*arm64*) ;;
  *) echo "FAIL: the merged binary holds only: $ARCHS" >&2; exit 1 ;;
esac

# Extended attributes make codesign fail in ways whose error message does not
# mention extended attributes. Tauri's bundler does this too, for the same
# reason, and it is why the copy above can safely be a plain `cp -R`.
echo "Stripping extended attributes"
xattr -crs "$OUT/stage/Loaf.app"

# Ad-hoc, matching bundle.macOS.signingIdentity in tauri.conf.json. Replacing
# the executable above invalidated whatever signature the bundler applied, so
# this is not optional tidying — without it the .dmg below ships the "damaged"
# bug again.
echo "Signing"
codesign --force -s - "$OUT/stage/Loaf.app"
codesign --verify --deep --strict --verbose=2 "$OUT/stage/Loaf.app"

# A drag-to-Applications window, which is what every Mac user expects a .dmg to
# be. Nothing fancier: a background image and a laid-out icon view need
# AppleScript against the Finder, which does not work reliably on a headless
# runner and has no bearing on whether the app installs.
echo "Building the disk image"
ln -s /Applications "$OUT/stage/Applications"
DMG="$OUT/Loaf_${VERSION}_universal.dmg"
hdiutil create \
  -volname "Loaf" \
  -srcfolder "$OUT/stage" \
  -ov -format UDZO \
  "$DMG"

echo
echo "Built $DMG"
ls -lh "$DMG"
