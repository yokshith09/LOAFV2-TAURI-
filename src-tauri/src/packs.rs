//! Loading hand-drawn characters off disk. The folder half of
//! `SpriteCompanion.swift`.
//!
//! One pack is one folder: a `character.json` and the PNG it names. This reads
//! both and hands them up; deciding whether the manifest makes sense is the
//! frontend's job, in `sprites/manifest.ts`, where it can be tested without a
//! filesystem.
//!
//! Nothing here creates the folder. A user who has never drawn a character
//! should not find an empty `Characters` directory in Application Support
//! wondering what it wants from them.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const PACKS_DIR: &str = "Characters";
const MANIFEST: &str = "character.json";

/// One pack, as far as Rust is concerned: the manifest text and the sheet bytes.
#[derive(Debug, Serialize)]
pub struct LoadedPack {
    /// The folder name, used only for reporting which pack went wrong.
    pub folder: String,
    /// `character.json`, verbatim. Parsed and validated on the other side.
    pub manifest: String,
    /// The PNG, as a data URI the webview can hand straight to an `Image`.
    pub sheet: String,
}

pub fn packs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("LoafPlus").join(PACKS_DIR)
}

/// Every readable pack in the folder.
///
/// A pack that cannot be read is SKIPPED, not reported as an error that stops
/// the others: one malformed folder must not cost the user the characters that
/// were fine. The frontend applies the same rule to manifests it cannot parse.
pub fn load_all(data_dir: &Path) -> Vec<LoadedPack> {
    let dir = packs_dir(data_dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut packs = Vec::new();
    for entry in entries.flatten() {
        let folder = entry.path();
        if !folder.is_dir() {
            continue;
        }
        if let Some(pack) = load_one(&folder) {
            packs.push(pack);
        }
    }
    // Stable order, so the closet does not reshuffle itself between launches on
    // whatever order the filesystem felt like returning.
    packs.sort_by(|a, b| a.folder.cmp(&b.folder));
    packs
}

fn load_one(folder: &Path) -> Option<LoadedPack> {
    let manifest = fs::read_to_string(folder.join(MANIFEST)).ok()?;
    let name = folder.file_name()?.to_str()?.to_string();

    // The sheet's filename comes out of the manifest, which is user-written, so
    // it is reduced to a bare filename before being joined. A `file` of
    // "../../../../etc/passwd" resolves inside this folder or not at all.
    let file = sheet_name(&manifest)?;
    let path = folder.join(file);
    let bytes = fs::read(&path).ok()?;

    Some(LoadedPack {
        folder: name,
        manifest,
        sheet: format!("data:image/png;base64,{}", base64(&bytes)),
    })
}

/// The sheet's filename from the manifest, stripped to a leaf.
///
/// Deliberately a small hand-rolled read rather than a full parse: this only
/// needs one string, and the real validation happens in TypeScript where it is
/// tested. Anything that is not a plain filename returns nothing.
fn sheet_name(manifest: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(manifest).ok()?;
    let file = value.get("sheet")?.get("file")?.as_str()?;
    let leaf = Path::new(file).file_name()?.to_str()?;
    if leaf.is_empty() || leaf.starts_with('.') {
        return None;
    }
    Some(leaf.to_string())
}

/// Base64, hand-rolled to avoid a dependency for forty lines of table lookup.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Create the folder, write a README explaining the format, and hand back the
/// path — only ever because the user asked.
pub fn ensure(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = packs_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let readme = dir.join("READ ME.txt");
    if !readme.exists() {
        let _ = fs::write(&readme, README);
    }
    Ok(dir)
}

const README: &str = r#"Drawing your own Loaf
=====================

One character is one folder in here, containing:

  character.json   what is on the sheet
  sheet.png        the frames, laid out in a grid

The smallest character.json that works:

{
  "id": "my-fox",
  "name": "Rusty",
  "sheet": { "file": "sheet.png", "scale": 2,
             "frameWidth": 128, "frameHeight": 142,
             "columns": 4, "rows": 2 },
  "moods": { "idle": { "from": 0, "count": 4, "fps": 8 } }
}

frameWidth and frameHeight are in SHEET PIXELS — the numbers you read off your
canvas. "scale" is 2 for an @2x sheet, 1 for pixel art drawn at unit size.

Moods you can draw: idle, happy, sleeping, worried, scrolling, tantrum, proud.
Only "idle" is required; anything you skip falls back to the closest one you did
draw. Frames are numbered left to right, then down, starting at 0.

Anchors are optional and tell Loaf where a hat sits, where the eyes are, and
where the paws hold a scroll:

  "anchors": { "origin": "top-left", "hat": { "x": 85, "y": 40 } }

Say "top-left" if you measured downward from the top of your canvas, which is
what most design tools do. The character stands in a 170 x 190 space.

A folder that cannot be read is skipped and the rest still load, so a
half-finished character will not stop Loaf starting.
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("loaf-packs-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_pack(data_dir: &Path, folder: &str, manifest: &str, sheet: Option<&str>) {
        let dir = packs_dir(data_dir).join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST), manifest).unwrap();
        if let Some(name) = sheet {
            fs::write(dir.join(name), b"\x89PNG").unwrap();
        }
    }

    const OK: &str = r#"{"id":"a","name":"A","sheet":{"file":"sheet.png"}}"#;

    #[test]
    fn a_missing_folder_is_not_an_error() {
        assert!(load_all(&scratch("none")).is_empty());
    }

    #[test]
    fn loads_a_pack_with_its_sheet() {
        let dir = scratch("one");
        write_pack(&dir, "fox", OK, Some("sheet.png"));
        let packs = load_all(&dir);
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].folder, "fox");
        assert!(packs[0].sheet.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn skips_a_broken_pack_without_losing_the_good_ones() {
        // One half-finished character must not cost the user the rest.
        let dir = scratch("mixed");
        write_pack(&dir, "good", OK, Some("sheet.png"));
        write_pack(&dir, "no-sheet", OK, None);
        write_pack(&dir, "no-json", "", Some("sheet.png"));
        fs::write(packs_dir(&dir).join("no-json").join(MANIFEST), "{oops").unwrap();

        let packs = load_all(&dir);
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].folder, "good");
    }

    #[test]
    fn refuses_a_sheet_path_that_climbs_out_of_the_folder() {
        // The filename comes from a user-written manifest, so it is reduced to a
        // leaf before being joined. Otherwise a pack could name any file on the
        // machine and have it handed back as a data URI.
        let dir = scratch("escape");
        let outside = dir.join("secret.png");
        fs::write(&outside, b"secret").unwrap();
        write_pack(
            &dir,
            "sneaky",
            r#"{"id":"a","name":"A","sheet":{"file":"../../secret.png"}}"#,
            None,
        );
        // "secret.png" does not exist inside the folder, so the pack is skipped.
        assert!(load_all(&dir).is_empty());
    }

    #[test]
    fn is_stable_between_launches() {
        // Otherwise the closet reshuffles on whatever order the filesystem felt
        // like returning.
        let dir = scratch("order");
        for name in ["zebra", "aardvark", "moose"] {
            write_pack(&dir, name, OK, Some("sheet.png"));
        }
        let names: Vec<_> = load_all(&dir).into_iter().map(|p| p.folder).collect();
        assert_eq!(names, vec!["aardvark", "moose", "zebra"]);
    }

    #[test]
    fn encodes_bytes_the_way_a_browser_expects() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn writes_a_readme_that_shows_a_working_manifest() {
        let dir = scratch("readme");
        ensure(&dir).unwrap();
        let text = fs::read_to_string(packs_dir(&dir).join("READ ME.txt")).unwrap();
        assert!(text.contains("frameWidth"));
        assert!(text.contains("top-left"));
    }
}
