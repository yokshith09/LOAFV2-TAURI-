//! The user's own sounds. Ported from the folder half of `SoundKit.swift`.
//!
//! One rule shapes this: the companion is allowed to make a noise, and the user
//! is allowed to decide what that noise is. What ships is a placeholder; what
//! they drop in this folder wins.

use std::fs;
use std::path::{Path, PathBuf};

/// Formats a webview will decode. Narrower than the reference's list, which
/// includes AIFF and CAF — both are macOS-native and neither plays in WebView2,
/// so offering them would be a promise broken on half the installs.
pub const SUPPORTED_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "ogg", "flac"];

/// The occasions, and what each one is for. Kept in step with `voice.ts` by the
/// README below being the only place either is written out for the user.
const OCCASIONS: &[(&str, &str)] = &[
    ("finish", "a focus session ended"),
    ("tantrum", "too many tabs, and I start sulking"),
    ("praise", "you closed enough of them"),
    ("greeting", "you clicked me"),
];

pub fn sounds_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("LoafPlus").join("Sounds")
}

/// What the user has put in the folder: occasion -> absolute path.
///
/// Missing folder means an empty list, not an error. The reference deliberately
/// does not create this directory on launch — an app that scatters empty
/// folders through Application Support is rude — so "not there" is the normal
/// case, not a fault.
pub fn index(data_dir: &Path) -> Vec<(String, String)> {
    let dir = sounds_dir(data_dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let ext = ext.to_lowercase();
        if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let stem = stem.to_lowercase();
        if OCCASIONS.iter().any(|(token, _)| *token == stem) {
            if let Some(p) = path.to_str() {
                found.push((stem, p.to_string()));
            }
        }
    }
    found
}

/// Read one occasion's sound, if the user has provided it.
///
/// The caller names an OCCASION, never a path. That is the whole point: the
/// frontend cannot ask for a file, only for "whatever the user put there for
/// the tantrum", so there is no traversal surface to get wrong and no way for a
/// window to read something outside this folder.
pub fn read(data_dir: &Path, occasion: &str) -> Option<(String, Vec<u8>)> {
    let occasion = occasion.to_lowercase();
    if !OCCASIONS.iter().any(|(token, _)| *token == occasion) {
        return None;
    }
    for (found, path) in index(data_dir) {
        if found != occasion {
            continue;
        }
        let ext = Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if let Ok(bytes) = fs::read(&path) {
            return Some((mime_for(&ext).to_string(), bytes));
        }
    }
    None
}

/// Enough of a type for the webview to pick a decoder.
fn mime_for(ext: &str) -> &'static str {
    match ext {
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "audio/wav",
    }
}

/// Create the folder and explain it, then hand back the path to open.
///
/// Only ever called because the user asked for it, which is why creating the
/// directory here is fine and creating it on launch would not be.
pub fn ensure(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = sounds_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let readme = dir.join("READ ME.txt");
    // Never overwritten: someone may have written their own notes underneath it.
    if !readme.exists() {
        let _ = fs::write(&readme, readme_text());
    }
    Ok(dir)
}

fn readme_text() -> String {
    let mut out = String::from(
        "Loaf's sounds\n\
         =============\n\n\
         Drop a file in here named after the moment it should play, and Loaf\n\
         will use yours instead of the placeholder it ships with.\n\n",
    );
    for (token, note) in OCCASIONS {
        out.push_str(&format!("  {token}.wav   — {note}\n"));
    }
    out.push_str(&format!(
        "\nAny of these extensions work: {}.\n\n\
         The sounds Loaf makes on its own are synthesised placeholders, not\n\
         recordings — this app ships no audio at all. Yours will be better.\n\n\
         Nothing here is uploaded anywhere. Delete a file to go back to the\n\
         placeholder.\n",
        SUPPORTED_EXTENSIONS.join(", ")
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("loaf-sounds-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        // The normal case: the folder only exists once the user has asked for it.
        assert!(index(&scratch("none")).is_empty());
    }

    #[test]
    fn finds_a_sound_named_after_its_occasion() {
        let dir = scratch("find");
        ensure(&dir).unwrap();
        fs::write(sounds_dir(&dir).join("finish.wav"), b"x").unwrap();
        let found = index(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "finish");
    }

    #[test]
    fn ignores_a_file_named_after_nothing_in_particular() {
        let dir = scratch("stranger");
        ensure(&dir).unwrap();
        fs::write(sounds_dir(&dir).join("my-song.wav"), b"x").unwrap();
        assert!(index(&dir).is_empty());
    }

    #[test]
    fn ignores_a_format_the_webview_cannot_play() {
        // Offering AIFF because macOS likes it would be a promise broken on
        // every Windows install.
        let dir = scratch("aiff");
        ensure(&dir).unwrap();
        fs::write(sounds_dir(&dir).join("finish.aiff"), b"x").unwrap();
        assert!(index(&dir).is_empty());
    }

    #[test]
    fn is_not_fussy_about_case() {
        let dir = scratch("case");
        ensure(&dir).unwrap();
        fs::write(sounds_dir(&dir).join("Tantrum.WAV"), b"x").unwrap();
        assert_eq!(index(&dir)[0].0, "tantrum");
    }

    #[test]
    fn reads_back_a_sound_by_its_occasion() {
        let dir = scratch("read");
        ensure(&dir).unwrap();
        fs::write(sounds_dir(&dir).join("praise.mp3"), b"bytes").unwrap();
        let (mime, bytes) = read(&dir, "praise").unwrap();
        assert_eq!(mime, "audio/mpeg");
        assert_eq!(bytes, b"bytes");
    }

    #[test]
    fn refuses_to_read_anything_that_is_not_an_occasion() {
        // The frontend names an occasion, never a path. This is the check that
        // keeps it that way.
        let dir = scratch("traversal");
        ensure(&dir).unwrap();
        assert!(read(&dir, "../../../etc/passwd").is_none());
        assert!(read(&dir, "READ ME").is_none());
    }

    #[test]
    fn writes_a_readme_that_names_every_occasion() {
        let dir = scratch("readme");
        ensure(&dir).unwrap();
        let text = fs::read_to_string(sounds_dir(&dir).join("READ ME.txt")).unwrap();
        for (token, note) in OCCASIONS {
            assert!(text.contains(token), "{token} missing from the README");
            assert!(text.contains(note), "{note} missing from the README");
        }
    }

    #[test]
    fn never_overwrites_a_readme_someone_wrote_in() {
        let dir = scratch("keep");
        ensure(&dir).unwrap();
        let readme = sounds_dir(&dir).join("READ ME.txt");
        fs::write(&readme, "my own notes").unwrap();
        ensure(&dir).unwrap();
        assert_eq!(fs::read_to_string(&readme).unwrap(), "my own notes");
    }
}
