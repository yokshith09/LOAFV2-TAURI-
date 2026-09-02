//! Recording the user's own microphone, and nothing else.
//!
//! THE ONE RULE THIS FILE EXISTS TO ENFORCE. It captures the default INPUT
//! device — the microphone — and never system audio. On Windows the loopback
//! capture that would record what everyone else in a call is saying is a
//! different API (`WASAPI` render-loopback), and it is not used here, not
//! behind a flag, and not reachable by passing a different device name. If
//! recording other people ever becomes a feature it will be a deliberate,
//! separate, differently-consented piece of work, not a parameter to this one.
//!
//! WHY THAT IS THE CHOICE. A meeting recording captures colleagues who never
//! installed anything. Their consent is not the user's to give, and in several
//! places it is not merely rude. Recording your own microphone captures half a
//! conversation — your half — which is the half that is unambiguously yours.
//!
//! WHAT IT PRODUCES. 16 kHz mono 16-bit WAV, which is exactly what Whisper
//! wants, so nothing downstream has to resample. Written to a temporary file
//! the caller owns and is expected to delete.
//!
//! NOTHING HERE STARTS ON ITS OWN. There is no timer, no wake word and no
//! background thread that begins recording. A recording exists because
//! something called `start` in response to a person asking for it.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// Whisper's native rate. Recording at anything else means resampling later.
pub const TARGET_HZ: u32 = 16_000;

/// A recording in progress.
pub struct Recording {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<i16>>>,
    handle: Option<std::thread::JoinHandle<Result<(), String>>>,
    started: std::time::Instant,
}

impl Recording {
    /// How long it has been recording. Drives the indicator.
    pub fn seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }
}

/// The name of the microphone that would be used, for showing before starting.
pub fn input_device_name() -> Option<String> {
    imp::input_device_name()
}

/// Whether a microphone exists at all.
pub fn has_input() -> bool {
    input_device_name().is_some()
}

/// Begin recording the default microphone.
pub fn start() -> Result<Recording, String> {
    imp::start()
}

/// Stop, and write what was captured to `path` as a 16 kHz mono WAV.
///
/// Returns how many seconds were written. Zero means nothing was captured,
/// which is a real answer — a muted microphone produces silence, not an error.
pub fn stop(recording: Recording, path: &std::path::Path) -> Result<f32, String> {
    imp::stop(recording, path)
}

#[cfg(any(windows, target_os = "macos"))]
mod imp {
    use super::{Recording, TARGET_HZ};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    pub fn input_device_name() -> Option<String> {
        // default_input_device, never default_output_device. See the note at
        // the top of this file: the output device is everyone else's voice.
        cpal::default_host()
            .default_input_device()
            .and_then(|d| d.name().ok())
    }

    pub fn start() -> Result<Recording, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));

        let stop_thread = Arc::clone(&stop);
        let sink = Arc::clone(&samples);

        // The stream lives on its own thread because cpal's Stream is not Send
        // on every backend, and because a blocked audio callback must never be
        // able to stall the UI thread.
        let handle = std::thread::spawn(move || -> Result<(), String> {
            let device = cpal::default_host()
                .default_input_device()
                .ok_or("No microphone is available.")?;
            let config = device
                .default_input_config()
                .map_err(|e| format!("The microphone would not describe itself: {e}"))?;
            let channels = config.channels() as usize;
            let source_hz = config.sample_rate().0;

            let sink_for_cb = Arc::clone(&sink);
            let err = |e| eprintln!("audio input error: {e}");

            // Mixed to mono and resampled to 16 kHz in the callback, so the
            // buffer that grows over a long meeting is as small as it can be:
            // an hour at 48 kHz stereo would be six times the size for no gain.
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &_| {
                        let mut out = sink_for_cb.lock().unwrap();
                        push_resampled(&mut out, data, channels, source_hz);
                    },
                    err,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &_| {
                        let floats: Vec<f32> =
                            data.iter().map(|s| f32::from(*s) / 32768.0).collect();
                        let mut out = sink_for_cb.lock().unwrap();
                        push_resampled(&mut out, &floats, channels, source_hz);
                    },
                    err,
                    None,
                ),
                other => return Err(format!("Unsupported microphone format {other:?}.")),
            }
            .map_err(|e| format!("The microphone would not open: {e}"))?;

            stream.play().map_err(|e| e.to_string())?;
            while !stop_thread.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // Dropped explicitly so the device is released the moment recording
            // stops, rather than whenever the thread happens to unwind.
            drop(stream);
            Ok(())
        });

        Ok(Recording {
            stop,
            samples,
            handle: Some(handle),
            started: std::time::Instant::now(),
        })
    }

    /// Mix to mono and drop to 16 kHz by nearest-sample selection.
    ///
    /// Deliberately the simplest correct thing rather than a proper resampler:
    /// speech recognition is unbothered by the aliasing this introduces, and a
    /// filter bank here would be a lot of code between a microphone and a
    /// promise.
    fn push_resampled(out: &mut Vec<i16>, data: &[f32], channels: usize, source_hz: u32) {
        if channels == 0 || source_hz == 0 {
            return;
        }
        let frames = data.len() / channels;
        let step = source_hz as f64 / f64::from(TARGET_HZ);
        let wanted = (frames as f64 / step).floor() as usize;
        for i in 0..wanted {
            let frame = (i as f64 * step) as usize;
            if frame >= frames {
                break;
            }
            let base = frame * channels;
            let mut sum = 0.0f32;
            for c in 0..channels {
                sum += data.get(base + c).copied().unwrap_or(0.0);
            }
            let mono = (sum / channels as f32).clamp(-1.0, 1.0);
            out.push((mono * 32767.0) as i16);
        }
    }

    pub fn stop(mut recording: Recording, path: &std::path::Path) -> Result<f32, String> {
        recording.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = recording.handle.take() {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(e),
                Err(_) => return Err("The recording thread stopped unexpectedly.".into()),
            }
        }

        let samples = recording.samples.lock().map_err(|_| "recording poisoned")?;
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: TARGET_HZ,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
        for sample in samples.iter() {
            writer.write_sample(*sample).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
        Ok(samples.len() as f32 / TARGET_HZ as f32)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::Recording;

    pub fn input_device_name() -> Option<String> {
        None
    }
    pub fn start() -> Result<Recording, String> {
        Err("Recording is not supported here.".into())
    }
    pub fn stop(_recording: Recording, _path: &std::path::Path) -> Result<f32, String> {
        Err("Recording is not supported here.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_at_the_rate_whisper_wants() {
        // Anything else means resampling downstream, and a resampler between a
        // microphone and a transcript is a place for bugs nobody can hear.
        assert_eq!(TARGET_HZ, 16_000);
    }

    /// Whether this machine has a microphone at all. Ignored: a CI runner has
    /// none, and its answer would mean nothing.
    ///
    ///     cargo test -- --ignored --nocapture what_microphone
    #[test]
    #[ignore]
    fn what_microphone() {
        println!("input device: {:?}", input_device_name());
        assert!(has_input(), "no microphone found");
    }

    /// A real three-second recording, written to a real file.
    ///
    ///     cargo test -- --ignored --nocapture records_something
    #[test]
    #[ignore]
    fn records_something() {
        let recording = start().expect("start");
        std::thread::sleep(std::time::Duration::from_secs(3));
        let path = std::env::temp_dir().join("loaf-audio-test.wav");
        let seconds = stop(recording, &path).expect("stop");
        println!("wrote {seconds:.1}s to {}", path.display());
        assert!(seconds > 2.0, "expected about three seconds, got {seconds}");
        let size = std::fs::metadata(&path).expect("file").len();
        println!("file is {size} bytes");
        // 16 kHz mono 16-bit is 32000 bytes a second, plus a 44-byte header.
        assert!(size > 32_000 * 2, "file is too small to be three seconds");
        let _ = std::fs::remove_file(&path);
    }
}
