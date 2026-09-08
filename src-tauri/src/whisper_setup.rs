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
//!  - which files inside that zip `whisper-cli.exe` actually needs was
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

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin";
const MODEL_BYTES: u64 = 190_098_681;
const MODEL_FILENAME: &str = "ggml-small.en-q5_1.bin";

/// Where the installed engine lives, under the app's own data directory.
pub fn install_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("LoafPlus").join("whisper")
}

pub fn model_path(data_dir: &Path) -> PathBuf {
    install_dir(data_dir).join(MODEL_FILENAME)
}

/// Whether the model has been downloaded.
///
/// ONE FILE NOW, WHERE THERE WERE THIRTEEN. The engine used to be a downloaded
/// zip of a Windows build, and this function also had to check that the fast
/// CPU backends were among the extracted files — because an install from before
/// those shipped kept working at a fourteenth of the speed, forever, with no
/// way for the user to find out why.
///
/// None of that can happen now. whisper.cpp is compiled into Loaf, built for
/// the machine it was compiled for, so there is no version to drift, no backend
/// to be missing and no half-unzipped install to detect. There is a model file
/// or there is not.
pub fn is_installed(data_dir: &Path) -> bool {
    model_path(data_dir).is_file()
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

fn install_model(data_dir: &Path, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
    let dest = model_path(data_dir);
    fetch(MODEL_URL, MODEL_BYTES, &dest, "model", &mut on_progress)
}

/// Fetch and install both pieces. Reports progress for each in turn.
///
/// Deliberately not parallel: these are two large sequential downloads run
/// from a UI showing one progress bar, and interleaving their progress would
/// make that bar move backwards.
/// Fetch and install the engine.
///
/// WINDOWS ONLY FOR NOW, AND IT SAYS SO RATHER THAN TRYING. The release
/// fetched here is `whisper-bin-x64.zip` — Windows executables and Windows
/// DLLs. Pulling two hundred megabytes of those onto a Mac and then reporting
/// the engine as installed would be worse than not offering it: every later
/// failure would look like a bug in transcription rather than a platform that
/// was never wired up.
///
/// The guard is a runtime check inside one function rather than two `cfg`
/// bodies, because everything it calls — the download, the unzip, the size
/// checks — is ordinary cross-platform Rust. Splitting the function turned all
/// of that into dead code on macOS, which is a clippy failure and, more to the
/// point, two versions of a function to keep in step.
/// Fetch what Whisper still needs, which is now only the model.
///
/// THE WINDOWS-ONLY GUARD IS GONE, and that is the whole point of the change
/// this belongs to. It used to refuse on macOS with "the engine Loaf downloads
/// is a Windows build", which was true and made meeting transcription — a
/// headline feature — silently unavailable on half the platforms Loaf ships
/// for. The engine is compiled in now, so there is nothing platform-specific
/// left to download.
pub fn install(data_dir: &Path, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
    install_model(data_dir, &mut on_progress)
}

/// Total bytes this installs, for showing before the download starts.
pub fn total_bytes() -> u64 {
    MODEL_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_live_under_the_app_data_dir_not_the_bundle() {
        let dir = Path::new("C:/data");
        assert!(model_path(dir).starts_with(dir));
        assert!(model_path(dir).ends_with(MODEL_FILENAME));
    }

    #[test]
    fn reports_nothing_installed_on_a_fresh_directory() {
        let dir = std::env::temp_dir().join(format!("loaf-whisper-test-{}", std::process::id()));
        assert!(!is_installed(&dir));
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
        let model = model_path(&dir);
        println!(
            "model at {} ({} bytes)",
            model.display(),
            std::fs::metadata(&model).unwrap().len()
        );
        assert_eq!(std::fs::metadata(&model).unwrap().len(), MODEL_BYTES);
        let _ = last;
    }

    /// One download now, where there were two.
    ///
    /// The engine was an 8 MB zip of a Windows build and is now compiled into
    /// Loaf, so the only thing that still crosses the network is the model. If
    /// this ever needs changing back, the reason should be written down first.
    #[test]
    fn the_only_download_left_is_the_model() {
        assert_eq!(total_bytes(), MODEL_BYTES);
        // Sanity bound: this is a size a person can be told before downloading,
        // not accidentally the extracted/uncompressed footprint.
        assert!(total_bytes() < 250_000_000);
    }
}
