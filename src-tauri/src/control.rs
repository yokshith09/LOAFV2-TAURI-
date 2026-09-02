//! Driving the machine: volume, brightness, the keyboard, and UI elements.
//!
//! WHAT THIS DELIBERATELY DOES NOT DO. There is no delete, no move, and no
//! overwrite anywhere in this file. Every other capability here is reversible
//! by the person watching it happen — a wrong volume is turned back, a wrong
//! window is reopened, a wrong keystroke is undone. Deleting a file by voice is
//! not, and speech is the least reliable input the app has. Loaf can OPEN a
//! file and SHOW you where it lives; removing it stays a thing you do with your
//! own hands. That is a product decision, not a missing feature, and it should
//! not be quietly relaxed later.
//!
//! THE SECOND LIMIT IS THE VOCABULARY. Loaf hears a closed phrase list so that
//! recognition stays on the machine (see `speech.rs`). That means "type out my
//! address" can work — the text is known in advance — but "type whatever I say
//! next" cannot, because free speech is the cloud path. Anything here that
//! takes arbitrary text is reachable from the command box, not from the
//! microphone, and that asymmetry is the privacy promise showing through the
//! feature list rather than a gap in it.

/// A percentage that cannot be out of range.
pub fn clamp_percent(value: i64) -> u8 {
    value.clamp(0, 100) as u8
}

/// Keys that can appear in a combination, by the name a person would use.
///
/// Deliberately small. Every key here is one a spoken or typed command has a
/// reason to press; a full keyboard map would mostly be a way to send
/// keystrokes nobody meant.
pub const KEY_NAMES: &[(&str, u16)] = &[
    ("ctrl", 0x11),
    ("control", 0x11),
    ("alt", 0x12),
    ("shift", 0x10),
    ("win", 0x5B),
    ("tab", 0x09),
    ("enter", 0x0D),
    ("return", 0x0D),
    ("escape", 0x1B),
    ("esc", 0x1B),
    ("space", 0x20),
    ("backspace", 0x08),
    ("delete", 0x2E),
    ("home", 0x24),
    ("end", 0x23),
    ("pageup", 0x21),
    ("pagedown", 0x22),
    ("left", 0x25),
    ("up", 0x26),
    ("right", 0x27),
    ("down", 0x28),
    ("f1", 0x70),
    ("f2", 0x71),
    ("f3", 0x72),
    ("f4", 0x73),
    ("f5", 0x74),
    ("f6", 0x75),
    ("f11", 0x7A),
    ("f12", 0x7B),
    // Media and volume, so "next track" and "mute" need no separate plumbing.
    ("volumeup", 0xAF),
    ("volumedown", 0xAE),
    ("volumemute", 0xAD),
    ("nexttrack", 0xB0),
    ("previoustrack", 0xB1),
    ("playpause", 0xB3),
];

fn key_code(name: &str) -> Option<u16> {
    let key = name.trim().to_lowercase().replace([' ', '_', '-'], "");
    if let Some((_, code)) = KEY_NAMES.iter().find(|(n, _)| *n == key) {
        return Some(*code);
    }
    // A single letter or digit is its own virtual-key code in ASCII uppercase.
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => Some(c.to_ascii_uppercase() as u16),
        _ => None,
    }
}

/// Split "ctrl+shift+t" into the modifiers to hold and the key to press.
///
/// Returns None for anything it does not fully understand rather than pressing
/// the part it recognised. Half a key combination is its own command, and
/// usually a worse one.
pub fn parse_combo(combo: &str) -> Option<(Vec<u16>, u16)> {
    let parts: Vec<&str> = combo
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let (last, modifiers) = parts.split_last()?;
    let mut held = Vec::with_capacity(modifiers.len());
    for m in modifiers {
        held.push(key_code(m)?);
    }
    Some((held, key_code(last)?))
}

/// Whether a path is one Loaf will hand to the shell.
///
/// The rule is narrow on purpose: it must exist. Loaf opens things that are
/// already there, and refusing a path that does not exist turns a misheard name
/// into "I could not find that" rather than into the shell being asked to
/// interpret a sentence.
pub fn openable(path: &str) -> bool {
    !path.trim().is_empty() && std::path::Path::new(path).exists()
}

pub fn volume() -> Result<u8, String> {
    imp::volume()
}
pub fn set_volume(percent: u8) -> Result<(), String> {
    imp::set_volume(percent.min(100))
}
pub fn set_muted(on: bool) -> Result<(), String> {
    imp::set_muted(on)
}
pub fn brightness() -> Result<u8, String> {
    imp::brightness()
}
pub fn set_brightness(percent: u8) -> Result<(), String> {
    imp::set_brightness(percent.min(100))
}
pub fn type_text(text: &str) -> Result<(), String> {
    imp::type_text(text)
}
pub fn press(combo: &str) -> Result<(), String> {
    let (held, key) =
        parse_combo(combo).ok_or_else(|| format!("I do not know the keys {combo}."))?;
    imp::press(&held, key)
}
pub fn click_named(name: &str) -> Result<bool, String> {
    imp::click_named(name)
}
pub fn clickables() -> Vec<String> {
    imp::clickables()
}

/// Show a file or folder in the file manager, selected.
pub fn reveal(path: &str) -> Result<(), String> {
    if !openable(path) {
        return Err(format!("There is nothing at {path}."));
    }
    imp::reveal(path)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY,
    };

    /// Same reason as `speech.rs`: Tauri's thread pool has no COM apartment and
    /// every COM call here would fail with CO_E_NOTINITIALIZED without one.
    struct Apartment(bool);

    impl Apartment {
        fn enter() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Apartment(hr.is_ok())
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// The default playback device's volume control.
    fn endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| e.to_string())?;
            device
                .Activate::<IAudioEndpointVolume>(CLSCTX_INPROC_SERVER, None)
                .map_err(|e| e.to_string())
        }
    }

    pub fn volume() -> Result<u8, String> {
        let _apartment = Apartment::enter();
        let volume = endpoint()?;
        let level = unsafe {
            volume
                .GetMasterVolumeLevelScalar()
                .map_err(|e| e.to_string())?
        };
        Ok((level * 100.0).round().clamp(0.0, 100.0) as u8)
    }

    pub fn set_volume(percent: u8) -> Result<(), String> {
        let _apartment = Apartment::enter();
        let volume = endpoint()?;
        unsafe {
            volume
                .SetMasterVolumeLevelScalar(f32::from(percent) / 100.0, std::ptr::null())
                .map_err(|e| e.to_string())
        }
    }

    pub fn set_muted(on: bool) -> Result<(), String> {
        let _apartment = Apartment::enter();
        let volume = endpoint()?;
        unsafe {
            volume
                .SetMute(on, std::ptr::null())
                .map_err(|e| e.to_string())
        }
    }

    /// Brightness goes through WMI, which has no usable Rust binding here.
    ///
    /// This is the internal panel only: external monitors are driven over
    /// DDC/CI, which most of them implement badly or not at all. Saying so is
    /// better than appearing to work on a desktop and silently doing nothing.
    fn wmi(script: &str) -> Result<String, String> {
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err("This display does not report brightness to Windows.".into());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub fn brightness() -> Result<u8, String> {
        let text = wmi(
            "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness",
        )?;
        text.lines()
            .next()
            .and_then(|l| l.trim().parse::<u8>().ok())
            .ok_or_else(|| "This display does not report brightness to Windows.".into())
    }

    pub fn set_brightness(percent: u8) -> Result<(), String> {
        wmi(&format!(
            "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1,{percent})"
        ))
        .map(|_| ())
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            // The usual cause is a window running as administrator: Windows
            // refuses synthetic input from a lower integrity level, silently.
            Err("Windows would not accept the keystrokes. A window running as administrator will refuse them.".into())
        }
    }

    fn unit(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        // KEYEVENTF_UNICODE carries the character itself rather than a key
        // code, so this types the same thing whatever the keyboard layout is.
        // encode_utf16 rather than chars(): anything above the basic plane is
        // two units and both have to be sent.
        let mut inputs = Vec::with_capacity(text.len() * 2);
        for unit_value in text.encode_utf16() {
            inputs.push(unit(0, unit_value, KEYEVENTF_UNICODE));
            inputs.push(unit(0, unit_value, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    pub fn press(held: &[u16], key: u16) -> Result<(), String> {
        let mut inputs = Vec::with_capacity(held.len() * 2 + 2);
        for m in held {
            inputs.push(unit(*m, 0, KEYBD_EVENT_FLAGS(0)));
        }
        inputs.push(unit(key, 0, KEYBD_EVENT_FLAGS(0)));
        inputs.push(unit(key, 0, KEYEVENTF_KEYUP));
        // Released in reverse, so the modifiers outlive the key they modified.
        for m in held.iter().rev() {
            inputs.push(unit(*m, 0, KEYEVENTF_KEYUP));
        }
        send(&inputs)
    }

    /// Everything clickable in the window that is in front, by name.
    ///
    /// This is what makes "click Save" possible through a closed vocabulary:
    /// the names on screen become phrases, exactly as the installed programs
    /// do. It reads control names and nothing else — no values, no text
    /// content, no page contents.
    pub fn clickables() -> Vec<String> {
        let _apartment = Apartment::enter();
        ui::names().unwrap_or_default()
    }

    pub fn click_named(name: &str) -> Result<bool, String> {
        let _apartment = Apartment::enter();
        ui::invoke(name)
    }

    mod ui {
        use windows::core::{Interface, BSTR};
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
        use windows::Win32::UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
            TreeScope_Descendants, UIA_InvokePatternId, UIA_IsOffscreenPropertyId,
            UIA_NamePropertyId,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

        /// Names longer than this are paragraphs of content, not buttons.
        const MAX_NAME: usize = 40;

        fn automation() -> Option<IUIAutomation> {
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok() }
        }

        fn foreground(automation: &IUIAutomation) -> Option<IUIAutomationElement> {
            let hwnd = unsafe { GetForegroundWindow() };
            if hwnd.0.is_null() {
                return None;
            }
            unsafe { automation.ElementFromHandle(hwnd).ok() }
        }

        pub fn names() -> Option<Vec<String>> {
            let automation = automation()?;
            let root = foreground(&automation)?;
            let condition = unsafe {
                automation
                    .CreatePropertyCondition(UIA_IsOffscreenPropertyId, &false.into())
                    .ok()?
            };
            let found = unsafe { root.FindAll(TreeScope_Descendants, &condition).ok()? };
            let count = unsafe { found.Length().ok()? };
            let mut out = Vec::new();
            for i in 0..count {
                let Ok(element) = (unsafe { found.GetElement(i) }) else {
                    continue;
                };
                // Only things that can actually be invoked; a label named
                // "Save" that does nothing would be a phrase Loaf hears and
                // then cannot act on.
                if unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }.is_err() {
                    continue;
                }
                let Ok(name) = (unsafe { element.GetCurrentPropertyValue(UIA_NamePropertyId) })
                else {
                    continue;
                };
                let name = BSTR::try_from(&name)
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let trimmed = name.trim();
                if trimmed.is_empty() || trimmed.len() > MAX_NAME {
                    continue;
                }
                out.push(trimmed.to_string());
            }
            out.sort();
            out.dedup();
            Some(out)
        }

        pub fn invoke(want: &str) -> Result<bool, String> {
            let Some(automation) = automation() else {
                return Err("Windows UI Automation is not available.".into());
            };
            let Some(root) = foreground(&automation) else {
                return Ok(false);
            };
            let condition = unsafe {
                automation
                    .CreatePropertyCondition(UIA_NamePropertyId, &BSTR::from(want).into())
                    .map_err(|e| e.to_string())?
            };
            let Ok(element) = (unsafe { root.FindFirst(TreeScope_Descendants, &condition) }) else {
                return Ok(false);
            };
            let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }) else {
                return Ok(false);
            };
            let invoker: IUIAutomationInvokePattern = pattern.cast().map_err(|e| e.to_string())?;
            unsafe { invoker.Invoke() }.map_err(|e| e.to_string())?;
            Ok(true)
        }
    }

    pub fn reveal(path: &str) -> Result<(), String> {
        std::process::Command::new("explorer.exe")
            .args(["/select,", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    const ELSEWHERE: &str = "That is Windows-only for now.";

    pub fn volume() -> Result<u8, String> {
        Err(ELSEWHERE.into())
    }
    pub fn set_volume(_percent: u8) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    pub fn set_muted(_on: bool) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    pub fn brightness() -> Result<u8, String> {
        Err(ELSEWHERE.into())
    }
    pub fn set_brightness(_percent: u8) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    pub fn type_text(_text: &str) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    pub fn press(_held: &[u16], _key: u16) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    pub fn click_named(_name: &str) -> Result<bool, String> {
        Err(ELSEWHERE.into())
    }
    pub fn clickables() -> Vec<String> {
        Vec::new()
    }
    pub fn reveal(path: &str) -> Result<(), String> {
        std::process::Command::new("open")
            .args(["-R", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentages_cannot_escape() {
        assert_eq!(clamp_percent(-40), 0);
        assert_eq!(clamp_percent(50), 50);
        assert_eq!(clamp_percent(1000), 100);
    }

    #[test]
    fn reads_a_key_combination() {
        let (held, key) = parse_combo("ctrl+t").unwrap();
        assert_eq!(held, vec![0x11]);
        assert_eq!(key, u16::from(b'T'));

        let (held, key) = parse_combo("ctrl+shift+tab").unwrap();
        assert_eq!(held, vec![0x11, 0x10]);
        assert_eq!(key, 0x09);
    }

    #[test]
    fn is_relaxed_about_how_a_combination_is_written() {
        for text in ["CTRL + T", "control+t", "Ctrl+T"] {
            assert_eq!(parse_combo(text), parse_combo("ctrl+t"), "{text}");
        }
    }

    // Half a key combination is its own command, and usually a worse one.
    #[test]
    fn refuses_a_combination_it_only_half_knows() {
        assert!(parse_combo("ctrl+banana").is_none());
        assert!(parse_combo("hyper+t").is_none());
        assert!(parse_combo("").is_none());
        assert!(parse_combo("+").is_none());
    }

    #[test]
    fn knows_the_media_keys() {
        assert_eq!(parse_combo("playpause").unwrap().1, 0xB3);
        assert_eq!(parse_combo("volume up").unwrap().1, 0xAF);
    }

    // A misheard name should become "I could not find that", never a sentence
    // handed to the shell to interpret.
    #[test]
    fn only_opens_things_that_exist() {
        assert!(!openable(""));
        assert!(!openable("   "));
        assert!(!openable(r"C:\definitely\not\here\at\all.txt"));
        assert!(openable(env!("CARGO_MANIFEST_DIR")));
    }

    /// What this machine actually reports. Read-only: it changes nothing.
    ///
    ///     cargo test -- --ignored --nocapture what_this_machine_does
    #[test]
    #[ignore]
    fn what_this_machine_does() {
        println!("volume:     {:?}", volume());
        println!("brightness: {:?}", brightness());
        let names = clickables();
        println!("clickable in the front window: {}", names.len());
        for n in names.iter().take(8) {
            println!("  - {n}");
        }
    }

    #[test]
    fn will_not_reveal_something_that_is_not_there() {
        assert!(reveal(r"C:\definitely\not\here").is_err());
    }
}
