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

/// The files a working `whisper-cli.exe` needs beside it, verified by
/// running it and adding files until `STATUS_DLL_NOT_FOUND` stopped.
const NEEDED_FILES: &[&str] = &[
    "Release/whisper-cli.exe",
    "Release/whisper.dll",
    "Release/ggml.dll",
    "Release/ggml-base.dll",
    // EVERY CPU BACKEND, NOT JUST THE BASELINE — THIS IS A 14x SPEED
    // DIFFERENCE AND IT WAS MEASURED, TWICE.
    //
    // ggml loads ONE of these at runtime, picking the best your processor can
    // actually run. Shipping only `ggml-cpu-x64.dll` meant it always picked
    // the fallback: plain x86-64 with no SIMD at all. whisper printed the
    // evidence every single run and nobody read it —
    //
    //   CPU : OPENMP = 1 | REPACK = 1          <- no AVX, no AVX2, no FMA
    //
    // where a machine with the right file loads haswell and prints
    //
    //   CPU : AVX = 1 | AVX2 = 1 | F16C = 1 | FMA = 1 | BMI2 = 1
    //
    // On one 5.7-second clip, same model, same thread count: 33 seconds on the
    // baseline, 5.8 seconds on haswell. It was 83 seconds before the thread
    // count was fixed too. That is the difference between dictation that
    // works and a feature people report as broken — and it looked like
    // "Whisper is failing" rather than "Whisper is running scalar code",
    // because nothing surfaced which backend had been chosen.
    //
    // They are about 800 KB each and only one is ever loaded. Carrying all
    // nine costs ~7 MB on disk and removes an entire class of "it is slow on
    // my machine" that nobody could have diagnosed from inside the app.
    "Release/ggml-cpu-x64.dll",
    "Release/ggml-cpu-sse42.dll",
    "Release/ggml-cpu-sandybridge.dll",
    "Release/ggml-cpu-haswell.dll",
    "Release/ggml-cpu-skylakex.dll",
    "Release/ggml-cpu-icelake.dll",
    "Release/ggml-cpu-cascadelake.dll",
    "Release/ggml-cpu-cannonlake.dll",
    "Release/ggml-cpu-alderlake.dll",
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
    binary_path(data_dir).is_file() && model_path(data_dir).is_file() && has_fast_backend(data_dir)
}

/// Whether the install has the optimised CPU backends, not just the fallback.
///
/// AN INSTALL FROM BEFORE THOSE WERE SHIPPED IS TREATED AS NOT INSTALLED, on
/// purpose. It would otherwise keep working — at a fourteenth of the speed,
/// forever, with no way for the user to find out why and no reason for them to
/// press a download button next to an engine that says it is ready. Reporting
/// it as missing is what gets the fast files onto machines that already ran
/// the old installer.
fn has_fast_backend(data_dir: &Path) -> bool {
    install_dir(data_dir).join("ggml-cpu-haswell.dll").is_file()
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
pub fn install(data_dir: &Path, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Meeting transcription is Windows-only for now.                     The engine Loaf downloads is a Windows build."
            .into());
    }
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
    fn the_file_list_is_exactly_what_was_proven_necessary() {
        // Changing this list changes what gets installed. It should only ever
        // change alongside re-running the empirical check this module's doc
        // comment describes, not by guessing.
        //
        // Four to run at all, found by extracting them one at a time until the
        // executable stopped failing with STATUS_DLL_NOT_FOUND, plus one CPU
        // backend per instruction set. ggml loads exactly one of those at
        // runtime and picks the best the processor supports.
        assert_eq!(NEEDED_FILES.len(), 13);
        assert!(NEEDED_FILES.contains(&"Release/whisper-cli.exe"));
        assert!(NEEDED_FILES.iter().all(|f| f.starts_with("Release/")));
        assert_eq!(
            NEEDED_FILES
                .iter()
                .filter(|f| f.contains("ggml-cpu-"))
                .count(),
            9
        );
    }

    /// The baseline backend alone is what made transcription fourteen times
    /// slower than it needed to be, and it is invisible from inside the app:
    /// whisper reports the chosen backend and nothing read it. An install
    /// carrying only the fallback must therefore read as INCOMPLETE, or a
    /// machine that ran the old installer keeps the slow one forever.
    #[test]
    fn an_install_without_the_fast_backends_is_not_finished() {
        let dir = std::env::temp_dir().join(format!("loaf-stale-{}", std::process::id()));
        let engine = install_dir(&dir);
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::write(binary_path(&dir), b"x").unwrap();
        std::fs::write(model_path(&dir), b"x").unwrap();
        std::fs::write(engine.join("ggml-cpu-x64.dll"), b"x").unwrap();
        assert!(!is_installed(&dir), "the fallback alone must not count");

        std::fs::write(engine.join("ggml-cpu-haswell.dll"), b"x").unwrap();
        assert!(is_installed(&dir), "with a fast backend it is finished");
        let _ = std::fs::remove_dir_all(&dir);
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
