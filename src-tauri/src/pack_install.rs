//! Installing a character pack somebody dropped on the window.
//!
//! `packs.rs` READS packs that are already in place. This puts one there, which
//! is a different job with a different failure mode: the person is holding a
//! file they did not make and has no idea what shape it was supposed to be.
//!
//! SO EVERY REFUSAL IS A SENTENCE, not a code. "Invalid pack" says nothing
//! about which of six things is missing, and the two failures people actually
//! hit are not typos — they are a different KIND of file:
//!
//!  - A character DESIGN document. It describes how a character should look:
//!    expressions, poses, a palette, a page of measurements. It is not a sprite
//!    sheet and usually says so itself, in `animations.status`. Refusing it as
//!    "no sheet" reads like a bug when the file is simply a different thing, so
//!    it gets its own answer.
//!  - A manifest whose image is not beside it, which is what happens when only
//!    the JSON gets copied out of a folder.
//!
//! ONE PRESS is the point, so this takes the shapes people have rather than
//! demanding one: a folder, the `character.json` inside it, or a zip of either.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::packs::{packs_dir, MANIFEST};

/// Why a dropped file was not installed. Shown to the user as-is.
pub type Rejection = String;

/// Where a pack ended up, once it was accepted.
#[derive(Debug, Serialize)]
pub struct Installed {
    pub id: String,
    pub name: String,
    pub folder: String,
}

/// The grid keys a sheet needs before a frame can be found on it.
const GRID: [&str; 4] = ["columns", "rows", "frameWidth", "frameHeight"];

/// Read a manifest and say, in words, what is wrong with it.
///
/// Returns the id, the display name, and the image file name to copy.
pub fn check_manifest(text: &str, folder: &Path) -> Result<(String, String, String), Rejection> {
    let raw: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("That character.json is not valid JSON ({e})."))?;

    let id = raw.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    let name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let called = if name.is_empty() { "That file" } else { name };
    if id.is_empty() {
        return Err("That character.json has no id, so Loaf has nowhere to file it.".into());
    }

    let Some(sheet) = raw.get("sheet").and_then(|v| v.as_object()) else {
        return Err(no_sheet(&raw, called));
    };

    let file = sheet
        .get("file")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if file.is_empty() {
        return Err(format!("{called} does not say which image file to use."));
    }
    // The leaf only, the same rule `packs::load_all` applies when reading: a
    // manifest must never be able to name a path outside its own folder.
    let leaf = Path::new(file)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    if leaf.is_empty() || !folder.join(&leaf).is_file() {
        return Err(format!(
            "The image {leaf} is not next to that character.json. A pack is both \
             files together, and copying only the JSON is the usual reason for this."
        ));
    }

    for key in GRID {
        let ok = sheet
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|n| n > 0.0);
        if !ok {
            return Err(format!(
                "{called} is missing a sensible {key} in its sheet grid. Loaf needs \
                 columns, rows, frameWidth and frameHeight to find a frame."
            ));
        }
    }

    if raw.get("moods").and_then(|m| m.get("idle")).is_none() {
        return Err(format!(
            "{called} declares no idle animation. Every other mood can fall back to \
             something, but idle is the one the character stands in."
        ));
    }

    Ok((id.to_string(), name.to_string(), leaf))
}

/// The answer for a file with no `sheet` at all.
///
/// Split out because the design-document case deserves its own explanation
/// rather than being told it is missing a key it was never going to have.
fn no_sheet(raw: &serde_json::Value, called: &str) -> Rejection {
    let looks_designed = raw.get("expressions").is_some() || raw.get("poses").is_some();
    if !looks_designed {
        return format!(
            "{called} has no sheet section, so Loaf cannot tell where the frames \
             are. It needs an image file name and a grid."
        );
    }
    let never_drawn = raw
        .get("animations")
        .and_then(|a| a.get("status"))
        .and_then(serde_json::Value::as_str)
        == Some("not_authored");
    let note = if never_drawn {
        " Its own animations status says the frames have not been authored yet."
    } else {
        ""
    };
    format!(
        "{called} is a character DESIGN document rather than a character pack. It \
         describes how the character should look, which is a different thing from \
         the frames Loaf animates: Loaf needs one image with every frame on it, \
         plus a grid saying where each frame sits.{note} Once those frames exist as \
         a single sheet, a character.json naming it will install in one press."
    )
}

/// Install from a folder, a `character.json`, or a `.zip` of either.
pub fn install(data_dir: &Path, source: &Path) -> Result<Installed, Rejection> {
    let root = staged_root(data_dir, source)?;
    let folder = find_manifest_dir(&root).ok_or_else(|| {
        "There is no character.json in there. A pack is a character.json and the \
         image it names, together."
            .to_string()
    })?;

    let text = fs::read_to_string(folder.join(MANIFEST))
        .map_err(|e| format!("Could not read character.json: {e}"))?;
    let (id, name, image) = check_manifest(&text, &folder)?;

    let target = packs_dir(data_dir).join(&id);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    fs::copy(folder.join(MANIFEST), target.join(MANIFEST)).map_err(|e| e.to_string())?;
    fs::copy(folder.join(&image), target.join(&image))
        .map_err(|e| format!("Could not copy {image}: {e}"))?;

    // The scratch copy has served its purpose; leaving it would show up as a
    // half-pack the next time the folder is read.
    let _ = fs::remove_dir_all(packs_dir(data_dir).join(INCOMING));
    Ok(Installed {
        id: id.clone(),
        name: if name.is_empty() { id } else { name },
        folder: target.to_string_lossy().into_owned(),
    })
}

const INCOMING: &str = ".incoming";

/// Turn whatever was dropped into a directory to look inside.
fn staged_root(data_dir: &Path, source: &Path) -> Result<PathBuf, Rejection> {
    if source.is_dir() {
        return Ok(source.to_path_buf());
    }
    if source
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        return unzip(data_dir, source);
    }
    if source.file_name().is_some_and(|f| f == MANIFEST) {
        return source
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "That character.json has nowhere to live.".to_string());
    }
    Err("Drop a character folder, its character.json, or a .zip of one.".into())
}

/// Every directory holding a `character.json`, looking one level down too.
///
/// A zip almost always contains one wrapper directory rather than the files
/// loose, and making somebody re-zip it correctly is not one press.
fn find_manifest_dir(root: &Path) -> Option<PathBuf> {
    if root.join(MANIFEST).is_file() {
        return Some(root.to_path_buf());
    }
    fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_dir() && p.join(MANIFEST).is_file())
}

/// Unpack into a scratch folder beside the packs.
///
/// `enclosed_name` is what refuses an entry called `../../something`. A zip is
/// an untrusted archive handed over by a stranger, and writing outside the
/// target directory is the oldest trick there is.
fn unzip(data_dir: &Path, zip_path: &Path) -> Result<PathBuf, Rejection> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Could not open that zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("That zip could not be read: {e}"))?;

    let out = packs_dir(data_dir).join(INCOMING);
    let _ = fs::remove_dir_all(&out);
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(safe) = entry.enclosed_name() else {
            return Err("That zip contains a file path Loaf will not write.".into());
        };
        let dest = out.join(safe);
        if entry.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut sink = fs::File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut sink).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("loaf-pack-install").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// A manifest of exactly the shape a working pack has.
    const GOOD: &str = r#"{
        "id": "beezy", "name": "BEEZY",
        "sheet": { "file": "sheet.png", "scale": 2, "frameWidth": 340,
                   "frameHeight": 380, "columns": 8, "rows": 8 },
        "moods": { "idle": { "from": 0, "count": 16, "fps": 12 } }
    }"#;

    /// The two files the user actually handed over, run through the real check.
    ///
    ///     cargo test -- --ignored --nocapture the_users_own_files
    ///
    /// Ignored because it reads a Downloads folder that exists on one machine.
    /// Kept because it is the difference between "the format should work" and
    /// knowing which of two real files actually does.
    #[test]
    #[ignore]
    fn the_users_own_files() {
        let downloads = std::path::Path::new(r"C:\\Users\\yoksh_hr8124k\\Downloads");
        for (label, file) in [("BEEZY", "character.json"), ("Dalgom", "dalgom.json")] {
            let path = downloads.join(file);
            let Ok(text) = fs::read_to_string(&path) else {
                println!("{label}: not on this machine, skipped");
                continue;
            };
            match check_manifest(&text, downloads) {
                Ok((id, name, image)) => {
                    println!("{label}: ACCEPTED as {id}/{name}, needs {image}");
                }
                Err(why) => println!("{label}: REFUSED - {why}"),
            }
        }
    }

    #[test]
    fn accepts_a_pack_with_its_image_beside_it() {
        let dir = scratch("good");
        fs::write(dir.join("sheet.png"), b"not really a png").expect("png");
        let (id, name, image) = check_manifest(GOOD, &dir).expect("should accept");
        assert_eq!(id, "beezy");
        assert_eq!(name, "BEEZY");
        assert_eq!(image, "sheet.png");
    }

    #[test]
    fn says_which_image_is_missing_rather_than_invalid_pack() {
        // Copying only the JSON out of a folder is the commonest mistake, and
        // the message has to name the file that did not come with it.
        let dir = scratch("nopng");
        let why = check_manifest(GOOD, &dir).expect_err("should refuse");
        assert!(why.contains("sheet.png"), "{why}");
        assert!(why.contains("next to"), "{why}");
    }

    #[test]
    fn tells_a_design_document_apart_from_a_broken_pack() {
        // THE ONE THAT MATTERS. A character bible is not a malformed pack, and
        // saying "no sheet" about it sends somebody looking for a typo that is
        // not there.
        let dir = scratch("design");
        let spec = r#"{
            "id": "dalgom", "name": "Dalgom",
            "expressions": [{"id":"happy"}], "poses": [{"id":"sit"}],
            "animations": { "status": "not_authored" }
        }"#;
        let why = check_manifest(spec, &dir).expect_err("should refuse");
        assert!(why.contains("DESIGN document"), "{why}");
        assert!(why.contains("not been authored"), "{why}");
        // And it must say what would fix it.
        assert!(why.contains("single sheet"), "{why}");
    }

    #[test]
    fn a_plain_json_with_no_sheet_gets_the_plain_answer() {
        let dir = scratch("plain");
        let why = check_manifest(r#"{"id":"x","name":"X"}"#, &dir).expect_err("refuse");
        assert!(why.contains("no sheet section"), "{why}");
        assert!(!why.contains("DESIGN"), "{why}");
    }

    #[test]
    fn refuses_a_sheet_with_no_grid_and_names_the_missing_key() {
        let dir = scratch("nogrid");
        fs::write(dir.join("sheet.png"), b"x").expect("png");
        let spec = r#"{"id":"a","name":"A","sheet":{"file":"sheet.png","columns":4},
                       "moods":{"idle":{"from":0,"count":1}}}"#;
        let why = check_manifest(spec, &dir).expect_err("refuse");
        assert!(why.contains("rows"), "{why}");
    }

    #[test]
    fn refuses_a_pack_with_no_idle() {
        // Every other mood falls back to something. Idle is the floor.
        let dir = scratch("noidle");
        fs::write(dir.join("sheet.png"), b"x").expect("png");
        let spec = r#"{"id":"a","name":"A",
                       "sheet":{"file":"sheet.png","columns":4,"rows":4,
                                "frameWidth":10,"frameHeight":10},
                       "moods":{"happy":{"from":0,"count":1}}}"#;
        let why = check_manifest(spec, &dir).expect_err("refuse");
        assert!(why.contains("idle"), "{why}");
    }

    #[test]
    fn a_manifest_may_not_name_an_image_outside_its_folder() {
        // The same rule the reader applies. A pack is a stranger's file.
        let dir = scratch("escape");
        fs::write(dir.join("sheet.png"), b"x").expect("png");
        let spec = r#"{"id":"a","name":"A",
                       "sheet":{"file":"../../../windows/system32/evil.png",
                                "columns":4,"rows":4,"frameWidth":10,"frameHeight":10},
                       "moods":{"idle":{"from":0,"count":1}}}"#;
        // Reduced to its leaf, which does not exist here, so it is refused.
        let why = check_manifest(spec, &dir).expect_err("refuse");
        assert!(why.contains("evil.png"), "{why}");
        assert!(!why.contains(".."), "{why}");
    }

    #[test]
    fn installs_a_folder_and_leaves_both_files_where_the_reader_looks() {
        let src = scratch("src");
        fs::write(src.join(MANIFEST), GOOD).expect("manifest");
        fs::write(src.join("sheet.png"), b"png bytes").expect("png");
        let data = scratch("data");

        let out = install(&data, &src).expect("install");
        assert_eq!(out.id, "beezy");
        let landed = packs_dir(&data).join("beezy");
        assert!(landed.join(MANIFEST).is_file());
        assert!(landed.join("sheet.png").is_file());
    }

    #[test]
    fn dropping_the_manifest_itself_installs_its_folder() {
        // What actually happens when somebody drags the JSON rather than the
        // folder holding it.
        let src = scratch("src2");
        fs::write(src.join(MANIFEST), GOOD).expect("manifest");
        fs::write(src.join("sheet.png"), b"png").expect("png");
        let data = scratch("data2");
        let out = install(&data, &src.join(MANIFEST)).expect("install");
        assert_eq!(out.name, "BEEZY");
    }

    #[test]
    fn refuses_something_that_is_not_a_pack_at_all() {
        let data = scratch("data3");
        let stray = scratch("stray").join("holiday.png");
        fs::write(&stray, b"x").expect("write");
        let why = install(&data, &stray).expect_err("refuse");
        assert!(why.contains("folder"), "{why}");
    }
}
