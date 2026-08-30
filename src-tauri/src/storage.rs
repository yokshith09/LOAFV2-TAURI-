//! Where the screen-time history lives on disk.
//!
//! Deliberately two narrow commands rather than a filesystem plugin. Loaf's
//! whole pitch is that it does not read things it has no business reading, and
//! granting the webview general file access to make one JSON file work would
//! undercut that for no gain. The path is decided here and the frontend never
//! names a file.
//!
//! THE PATH IS A COMPATIBILITY CONTRACT. Existing users have history at
//! `<data dir>/LoafPlus/stats.json`, written by the Swift app. It is spelled
//! out literally rather than derived from the bundle identifier — Tauri's
//! `app_data_dir()` would resolve to `com.loaf.app` or similar and quietly
//! start those users over with an empty file.

use std::fs;
use std::path::{Path, PathBuf};

/// Folder the Swift app used, and that we must keep using.
const APP_DIR: &str = "LoafPlus";
/// The free tier's folder, inherited once on first launch.
const LEGACY_DIR: &str = "Loaf";
const FILE: &str = "stats.json";

pub fn stats_path(data_dir: &Path) -> PathBuf {
    data_dir.join(APP_DIR).join(FILE)
}

pub fn legacy_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LEGACY_DIR).join(FILE)
}

/// Read the history, inheriting the free app's file on a first launch.
///
/// `Ok(None)` means "there is genuinely nothing recorded yet". A read that
/// fails for any other reason is an error, not an empty history: reporting a
/// permission problem as "no data" would let the app cheerfully overwrite a
/// file it simply could not open.
pub fn read_or_inherit(data_dir: &Path) -> Result<Option<String>, String> {
    let path = stats_path(data_dir);

    // Loaf+ keeps its own file so the free app and the paid one can run side by
    // side without fighting over one document. On the very first launch, though,
    // inherit whatever free Loaf already recorded — upgrading should not look
    // like starting over. Copy, never move: free Loaf keeps its history too.
    if !path.exists() {
        let legacy = legacy_path(data_dir);
        if legacy.is_file() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // A failed inheritance is not a failed launch. The user still gets a
            // working tracker; they lose the old rows, which is bad but
            // recoverable, and the file they came from is untouched.
            let _ = fs::copy(&legacy, &path);
        }
    }

    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Replace the history file in one step.
///
/// Written to a sibling temporary file and renamed, because this is the user's
/// only copy of months of history and a crash partway through a plain write
/// leaves them holding half a JSON document. `rename` replaces the destination
/// on both platforms we ship.
pub fn write_atomic(data_dir: &Path, json: &str) -> Result<(), String> {
    let path = stats_path(data_dir);
    let dir = path
        .parent()
        .ok_or_else(|| "stats path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        // Leaving the temp file behind after a failed rename would have us
        // retry into a file that already exists on the next save.
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A unique scratch directory. Hand-rolled rather than pulling in a crate:
    /// this machine's Smart App Control blocks unsigned build scripts, so every
    /// avoided dependency is one less way for the build to fail.
    fn scratch(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("loaf-storage-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn reports_nothing_recorded_rather_than_failing() {
        let dir = scratch("empty");
        assert_eq!(read_or_inherit(&dir).unwrap(), None);
    }

    #[test]
    fn round_trips_what_it_wrote() {
        let dir = scratch("round");
        write_atomic(&dir, r#"{"2026-08-30":{"apps":{"Xcode":300}}}"#).unwrap();
        let back = read_or_inherit(&dir).unwrap().expect("history");
        assert!(back.contains("Xcode"));
    }

    #[test]
    fn creates_the_folder_on_the_first_save() {
        // A first-run save must not fail just because nothing has made the
        // directory yet.
        let dir = scratch("mkdir");
        assert!(!stats_path(&dir).parent().unwrap().exists());
        write_atomic(&dir, "{}").unwrap();
        assert!(stats_path(&dir).is_file());
    }

    #[test]
    fn leaves_no_temp_file_behind() {
        let dir = scratch("tmp");
        write_atomic(&dir, "{}").unwrap();
        let stray = fs::read_dir(dir.join(APP_DIR))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!stray, "a partial write was left on disk");
    }

    #[test]
    fn a_second_save_replaces_the_first() {
        // The failure this guards against is platform-specific: renaming onto an
        // existing file is an error on some systems, and a tracker that can save
        // exactly once would look fine for a whole first session.
        let dir = scratch("replace");
        write_atomic(&dir, r#"{"a":1}"#).unwrap();
        write_atomic(&dir, r#"{"b":2}"#).unwrap();
        assert_eq!(read_or_inherit(&dir).unwrap().unwrap(), r#"{"b":2}"#);
    }

    #[test]
    fn inherits_the_free_apps_history_on_a_first_launch() {
        let dir = scratch("inherit");
        fs::create_dir_all(dir.join(LEGACY_DIR)).unwrap();
        fs::write(
            legacy_path(&dir),
            r#"{"2026-08-01":{"apps":{"Safari":60}}}"#,
        )
        .unwrap();

        let text = read_or_inherit(&dir).unwrap().expect("inherited history");
        assert!(text.contains("Safari"));
    }

    #[test]
    fn inheriting_copies_rather_than_moves() {
        // Free Loaf keeps running after the upgrade; taking its file away would
        // wipe the history of an app the user never asked us to touch.
        let dir = scratch("copy");
        fs::create_dir_all(dir.join(LEGACY_DIR)).unwrap();
        fs::write(legacy_path(&dir), r#"{"x":{}}"#).unwrap();

        read_or_inherit(&dir).unwrap();
        assert!(legacy_path(&dir).is_file(), "the free app's file was moved");
    }

    #[test]
    fn never_inherits_over_an_existing_file() {
        // Re-running the copy on every launch would throw away today's rows and
        // restore a stale snapshot each time the app started.
        let dir = scratch("noclobber");
        fs::create_dir_all(dir.join(LEGACY_DIR)).unwrap();
        fs::write(legacy_path(&dir), r#"{"old":{}}"#).unwrap();
        write_atomic(&dir, r#"{"current":{}}"#).unwrap();

        assert_eq!(read_or_inherit(&dir).unwrap().unwrap(), r#"{"current":{}}"#);
    }

    #[test]
    fn uses_the_folder_the_swift_app_used() {
        // Spelled out because deriving it from the bundle identifier is the
        // obvious refactor and it silently orphans every existing user.
        let p = stats_path(Path::new("/data"));
        assert!(p.ends_with("LoafPlus/stats.json") || p.ends_with("LoafPlus\\stats.json"));
    }
}
