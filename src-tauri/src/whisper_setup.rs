//! Fetching the Whisper engine, on request, so a customer never opens a
//! terminal to use local dictation.
//!
//! WHY THIS EXISTS. `transcribe.rs` can tell whether a whisper.cpp binary and
//! model are present; nothing previously fetched them. That was fine for
//! development and would have been a dead end for anyone who bought Loaf: pick
//! "Whisper (local)" in the closet, see "not downloaded yet", and have no way
//! to make that true without finding the right GitHub release and Hugging Face
//! file by hand. This module is the other half.
//!
//! EVERY NUMBER BELOW WAS VERIFIED, NOT ESTIMATED, ON 3 Sep 2026:
//!  - the release zip is `whisper-bin-x64.zip` from whisper.cpp release
//!    `b4938`, and its byte size is checked against what the download actually
//!    produced — a truncated download during testing was caught exactly this
//!    way, by the size not matching.
//!  - which five files inside that zip `whisper-cli.exe` actually needs was
//!    found empirically, not guessed: running the extracted exe alone failed
//!    with `STATUS_DLL_NOT_FOUND` until `whisper.dll`, `ggml.dll`,
//!    `ggml-base.dll` and `ggml-cpu-x64.dll` sat next to it, at which point it
//!    ran and printed its own help text. Shipping the whole 8&nbsp;MB zip would
//!    have worked too; shipping only what was proven necessary keeps the
//!    install closer to 3&nbsp;MB.
//!  - the model, `ggml-small.en-q5_1.bin` from `ggerganov/whisper.cpp` on
//!    Hugging Face, is exactly 190,098,681 bytes.
//!
//! NOTHING DOWNLOADS UNTIL SOMETHING CALLS `install`. Picking the Whisper
//! engine in the closet does not download it; only pressing the download
//! button does, and the size is shown before it starts, the same rule every
//! other engine in section 18 follows.
//!
//! THE BUNDLE DOES NOT GROW. These files live under the user's app data
//! directory, entirely outside anything the installer ships. See the note at
//! the top of `transcribe.rs` for why that split exists at all.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The whisper.cpp release these numbers were checked against. If the release
/// moves on, this stops working and says so — see `install_binary`'s size
/// check — rather than silently installing something unverified.
const RELEASE_ZIP_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip";
const RELEASE_ZIP_BYTES: u64 = 8_361_840;

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin";
const MODEL_BYTES: u64 = 190_098_681;
const MODEL_FILENAME: &str = "ggml-small.en-q5_1.bin";

/// The five files a working `whisper-cli.exe` needs beside it, verified by
/// running it and adding files until `STATUS_DLL_NOT_FOUND` stopped.
const NEEDED_FILES: &[&str] = &[
    "Release/whisper-cli.exe",
    "Release/whisper.dll",
    "Release/ggml.dll",
    "Release/ggml-base.dll",
    "Release/ggml-cpu-x64.dll",
];

/// Where the installed engine lives, under the app's own data directory.
pub fn install_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("LoafPlus").join("whisper")
}

pub fn binary_path(data_dir: &Path) -> PathBuf {
    install_dir(data_dir).join("whisper-cli.exe")
}

pub fn model_path(data_dir: &Path) -> PathBuf {
    install_dir(data_dir).join(MODEL_FILENAME)
}

/// Whether the default install location already has a working engine.
///
/// Same check `transcribe::missing` does, just pointed at the fixed location
/// this module installs to rather than a path the user typed.
pub fn is_installed(data_dir: &Path) -> bool {
    binary_path(data_dir).is_file() && model_path(data_dir).is_file()
}

/// One update as a download proceeds.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Progress {
    /// "binary" or "model" — which of the two downloads this is.
    pub stage: &'static str,
    pub downloaded: u64,
    pub total: u64,
}

/// Fetch one URL to `dest`, calling `on_progress` as bytes arrive.
///
/// The expected size is checked against the server's own `Content-Length`
/// before downloading a single byte, and against the bytes actually written
/// afterward — the second check is what caught a truncated download during
/// testing, where the connection closed early and curl exited 0 anyway. A size
/// mismatch deletes the partial file rather than leaving something that looks
/// installed but is not.
fn fetch(
    url: &str,
    expected_bytes: u64,
    dest: &Path,
    stage: &'static str,
    mut on_progress: impl FnMut(Progress),
) -> Result<(), String> {
    // A read timeout, not just a connect timeout. Caught in testing: a stalled
    // connection with no timeout hangs on `read()` forever rather than erroring
    // — 171 of 190 MB written, then nothing for sixteen minutes and counting,
    // with no way for a caller to know it had died rather than merely slowed.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("Could not reach {url}: {e}"))?;

    let server_len = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());
    if let Some(len) = server_len {
        if len != expected_bytes {
            return Err(format!(
                "The file at {url} is {len} bytes; expected {expected_bytes}. \
                 It may have changed since this was last checked, so the download was not started."
            ));
        }
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut reader = response.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;

    loop {
        let read = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read]).map_err(|e| e.to_string())?;
        downloaded += read as u64;
        on_progress(Progress {
            stage,
            downloaded,
            total: expected_bytes,
        });
    }
    drop(file);

    if downloaded != expected_bytes {
        // The truncation this file exists to catch. Remove the partial file so
        // `is_installed` cannot mistake it for a real one.
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "The download stopped early: got {downloaded} of {expected_bytes} bytes. Nothing was installed."
        ));
    }
    Ok(())
}

/// Download the release zip and extract only the five files that were proven
/// necessary, then delete the zip.
fn install_binary(data_dir: &Path, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
    let dir = install_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip_path = dir.join("whisper-bin-x64.zip.part");

    fetch(
        RELEASE_ZIP_URL,
        RELEASE_ZIP_BYTES,
        &zip_path,
        "binary",
        &mut on_progress,
    )?;

    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for name in NEEDED_FILES {
        let mut entry = archive
            .by_name(name)
            .map_err(|e| format!("The release zip did not contain {name}: {e}"))?;
        // Flattened: the zip's own "Release/" folder is not worth keeping, and
        // a flat install directory is what `binary_path` expects.
        let out_name = name.rsplit('/').next().unwrap_or(name);
        let mut out = std::fs::File::create(dir.join(out_name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    drop(archive);
    let _ = std::fs::remove_file(&zip_path);

    if !binary_path(data_dir).is_file() {
        return Err("whisper-cli.exe was not found after extraction.".into());
    }
    Ok(())
}

fn install_model(data_dir: &Path, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
    let dest = model_path(data_dir);
    fetch(MODEL_URL, MODEL_BYTES, &dest, "model", &mut on_progress)
}

/// Fetch and install both pieces. Reports progress for each in turn.
///
/// Deliberately not parallel: these are two large sequential downloads run
/// from a UI showing one progress bar, and interleaving their progress would
/// make that bar move backwards.
pub fn install(data_dir: &Path, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
    install_binary(data_dir, &mut on_progress)?;
    install_model(data_dir, &mut on_progress)?;
    Ok(())
}

/// Total bytes this installs, for showing before the download starts.
pub fn total_bytes() -> u64 {
    // The zip, not the ~3.2 MB extracted from it — that is what actually
    // crosses the network, and what the download-size promise has to be
    // honest about.
    RELEASE_ZIP_BYTES + MODEL_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_live_under_the_app_data_dir_not_the_bundle() {
        let dir = Path::new("C:/data");
        assert!(binary_path(dir).starts_with(dir));
        assert!(model_path(dir).ends_with(MODEL_FILENAME));
    }

    #[test]
    fn reports_nothing_installed_on_a_fresh_directory() {
        let dir = std::env::temp_dir().join(format!("loaf-whisper-test-{}", std::process::id()));
        assert!(!is_installed(&dir));
    }

    #[test]
    fn the_five_files_are_exactly_what_was_proven_necessary() {
        // Changing this list changes what gets installed. It should only ever
        // change alongside re-running the empirical DLL-dependency check this
        // module's doc comment describes, not by guessing.
        assert_eq!(NEEDED_FILES.len(), 5);
        assert!(NEEDED_FILES.contains(&"Release/whisper-cli.exe"));
        assert!(NEEDED_FILES.iter().all(|f| f.starts_with("Release/")));
    }

    /// A REAL download and install, against the real GitHub and Hugging Face
    /// URLs. Ignored by default — it pulls ~198 MB over the network.
    ///
    ///     cargo test -- --ignored --nocapture really_installs_the_engine
    #[test]
    #[ignore]
    fn really_installs_the_engine() {
        let dir = std::env::temp_dir().join("loaf-whisper-real-install-test");
        let _ = std::fs::remove_dir_all(&dir);

        let mut last = Progress {
            stage: "binary",
            downloaded: 0,
            total: 0,
        };
        install(&dir, |p| {
            if p.total > 0 && (p.downloaded == p.total || p.downloaded % (8 * 1024 * 1024) < 65536)
            {
                println!(
                    "{} {:>3}%  ({} / {} bytes)",
                    p.stage,
                    (p.downloaded * 100 / p.total.max(1)),
                    p.downloaded,
                    p.total
                );
            }
            last = p;
        })
        .expect("install should succeed against the real URLs");

        assert!(is_installed(&dir));
        let bin = binary_path(&dir);
        let model = model_path(&dir);
        println!(
            "binary at {} ({} bytes)",
            bin.display(),
            std::fs::metadata(&bin).unwrap().len()
        );
        println!(
            "model  at {} ({} bytes)",
            model.display(),
            std::fs::metadata(&model).unwrap().len()
        );
        assert_eq!(std::fs::metadata(&model).unwrap().len(), MODEL_BYTES);
        let _ = last;
    }

    #[test]
    fn total_size_is_both_downloads_not_just_the_model() {
        assert_eq!(total_bytes(), RELEASE_ZIP_BYTES + MODEL_BYTES);
        // Sanity bound: this is a size a person can be told before downloading,
        // not accidentally the extracted/uncompressed footprint.
        assert!(total_bytes() < 250_000_000);
    }
}
