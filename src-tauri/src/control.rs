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

/// Windows virtual-key codes translated into AppleScript, for macOS.
///
/// NOT BEHIND A `cfg`, on purpose. The development machine for this project is
/// a PC, so anything gated to macOS is code nobody here can run and whose tests
/// only CI ever sees. This is a lookup table — the part most likely to have a
/// wrong number in it and least likely to be noticed — so it is compiled and
/// tested everywhere.
///
/// The key names in [`KEY_NAMES`] are Windows codes because Windows was written
/// first. Rather than a second table of names, the codes are translated here:
/// one place, one direction, and the spoken vocabulary stays identical on both
/// platforms.
pub mod macos_keys {
    /// Windows VK -> macOS virtual key code, for keys that are not characters.
    ///
    /// macOS key codes are positional and look arbitrary because they are: they
    /// describe where a key sits on a 1984 Apple keyboard, not what it says.
    const SPECIAL: &[(u16, u16)] = &[
        (0x09, 48),  // tab
        (0x0D, 36),  // return
        (0x1B, 53),  // escape
        (0x20, 49),  // space
        (0x08, 51),  // delete (backwards)
        (0x2E, 117), // forward delete
        (0x24, 115), // home
        (0x23, 119), // end
        (0x21, 116), // page up
        (0x22, 121), // page down
        (0x25, 123), // left
        (0x26, 126), // up
        (0x27, 124), // right
        (0x28, 125), // down
        (0x70, 122), // F1
        (0x71, 120), // F2
        (0x72, 99),  // F3
        (0x73, 118), // F4
        (0x74, 96),  // F5
        (0x75, 97),  // F6
        (0x76, 98),  // F7
        (0x77, 100), // F8
        (0x78, 101), // F9
        (0x79, 109), // F10
        (0x7A, 103), // F11
        (0x7B, 111), // F12
        // THE MODIFIERS, AS KEYS IN THEIR OWN RIGHT.
        //
        // Found by the same test that found the media keys: `parse_combo("ctrl")`
        // is legal and yields no modifiers and ctrl as the key, so "press
        // control" parsed fine on both platforms and could only be sent on one.
        // These are the positions of the left-hand modifier keys.
        (0x10, 56), // shift
        (0x11, 59), // control
        (0x12, 58), // option
        (0x5B, 55), // command
    ];

    /// Windows modifier VK -> the words AppleScript wants.
    ///
    /// `win` becomes `command`, which is what a person means when they say the
    /// modifier key next to the space bar. `ctrl` stays `control` rather than
    /// being helpfully translated to command: a spoken "control C" means the
    /// control key, and quietly sending something else is the kind of guess
    /// this codebase does not make.
    fn modifier(vk: u16) -> Option<&'static str> {
        match vk {
            0x11 => Some("control down"),
            0x12 => Some("option down"),
            0x10 => Some("shift down"),
            0x5B => Some("command down"),
            _ => None,
        }
    }

    /// The media and volume keys, which are not keyboard positions at all.
    ///
    /// FOUND BY A TEST, NOT BY READING. `KEY_NAMES` carries volumeup, mute,
    /// nexttrack and the rest because Windows sends them as ordinary virtual
    /// keys. macOS has no key code for any of them — they are system-defined
    /// events — so a straight code translation would have left six spoken
    /// commands silently doing nothing on a Mac while working on Windows. The
    /// test that every named key is pressable on both platforms is what caught
    /// it.
    ///
    /// Volume goes through the same AppleScript the volume commands use.
    /// Transport asks whichever music app is actually running, in the order a
    /// person would expect: the one in front of the other.
    fn media(key: u16) -> Option<String> {
        let transport = |verb: &str| {
            format!(
                r#"tell application "System Events"
    if exists process "Spotify" then
        tell application "Spotify" to {verb}
    else if exists process "Music" then
        tell application "Music" to {verb}
    end if
end tell"#
            )
        };
        Some(match key {
            // Six points a step, which is roughly what the key does on a Mac.
            0xAF => "set volume output volume \
                 (((output volume of (get volume settings)) + 6) as integer)"
                .to_string(),
            0xAE => "set volume output volume \
                 (((output volume of (get volume settings)) - 6) as integer)"
                .to_string(),
            0xAD => "set volume output muted \
                 not (output muted of (get volume settings))"
                .to_string(),
            0xB3 => transport("playpause"),
            0xB0 => transport("next track"),
            0xB1 => transport("previous track"),
            _ => return None,
        })
    }

    /// The AppleScript for one key combination, or None if it cannot be said.
    ///
    /// None rather than a best effort: half a key combination is its own
    /// command and usually a worse one, which is the rule `parse_combo` already
    /// follows.
    pub fn script(held: &[u16], key: u16) -> Option<String> {
        // Media keys are whole actions rather than keystrokes, so a modifier
        // held with one is meaningless and is refused rather than ignored.
        if let Some(action) = media(key) {
            return if held.is_empty() { Some(action) } else { None };
        }
        let mut using = Vec::new();
        for m in held {
            using.push(modifier(*m)?);
        }
        let suffix = if using.is_empty() {
            String::new()
        } else if using.len() == 1 {
            format!(" using {}", using[0])
        } else {
            format!(" using {{{}}}", using.join(", "))
        };

        // A letter or digit is typed as a character; everything else is a
        // position on the keyboard.
        let body = match SPECIAL.iter().find(|(vk, _)| *vk == key) {
            Some((_, code)) => format!("key code {code}"),
            None => {
                let c = char::from_u32(key as u32).filter(char::is_ascii_alphanumeric)?;
                format!("keystroke \"{}\"", c.to_ascii_lowercase())
            }
        };

        Some(format!(
            "tell application \"System Events\" to {body}{suffix}"
        ))
    }

    /// Make text safe to sit inside an AppleScript string literal.
    ///
    /// The text here is a dictation result — whatever a recogniser heard near a
    /// microphone — and it is being pasted into a script that is about to run.
    /// Backslash first, or it would escape the escapes.
    pub fn escape(text: &str) -> String {
        text.replace('\\', "\\\\").replace('"', "\\\"")
    }

    /// The AppleScript that types a piece of text.
    pub fn typing(text: &str) -> String {
        format!(
            "tell application \"System Events\" to keystroke \"{}\"",
            escape(text)
        )
    }
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

    /// Ask macOS a one-line question and get the answer back.
    #[cfg(target_os = "macos")]
    fn ask(script: &str) -> Result<String, String> {
        let out = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("could not run osascript: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Volume on macOS, through the one API that has always been there.
    ///
    /// `osascript` rather than CoreAudio: setting a level exactly is what "set
    /// the volume to forty" needs, AppleScript's `set volume output volume` does
    /// exactly that, and it needs no permission and no linked framework. The
    /// in-process route would be a lot of unsafe for the same number.
    #[cfg(target_os = "macos")]
    pub fn volume() -> Result<u8, String> {
        let raw = ask("output volume of (get volume settings)")?;
        raw.parse::<i32>()
            .map(|v| v.clamp(0, 100) as u8)
            // "missing value" is what macOS answers when the output device does
            // not report a level — a few USB and Bluetooth devices do this.
            .map_err(|_| "This output device does not report its volume.".to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn set_volume(percent: u8) -> Result<(), String> {
        ask(&format!("set volume output volume {}", percent.min(100))).map(|_| ())
    }

    #[cfg(target_os = "macos")]
    pub fn set_muted(on: bool) -> Result<(), String> {
        ask(&format!(
            "set volume output muted {}",
            if on { "true" } else { "false" }
        ))
        .map(|_| ())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn volume() -> Result<u8, String> {
        Err(ELSEWHERE.into())
    }
    #[cfg(not(target_os = "macos"))]
    pub fn set_volume(_percent: u8) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    #[cfg(not(target_os = "macos"))]
    pub fn set_muted(_on: bool) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }

    /// Screen brightness on macOS, through DisplayServices.
    ///
    /// THIS WAS REFUSED ONCE, AND THE REASON WAS WRONG. The argument was that
    /// DisplayServices is a private framework and calling one in an app heading
    /// for notarisation is a bad bet. But Loaf already builds with Tauri's
    /// `macos-private-api` feature — it is required for a transparent window,
    /// which is the entire product — so the app already uses private API and
    /// already cannot go to the Mac App Store. Notarisation does not inspect
    /// which APIs are called; App Store review does, and that door is shut
    /// either way. The cost had already been paid, and refusing a feature to
    /// avoid paying it twice was not a trade, just a mistake.
    ///
    /// Loaded with `dlopen` at the moment it is first used, rather than linked.
    /// A private framework that disappears in some future macOS then costs this
    /// one feature, saying so, instead of stopping the app from launching.
    ///
    /// BUILT-IN DISPLAY ONLY. An external monitor is driven over DDC/CI, which
    /// is a different and much larger job, and DisplayServices reports an error
    /// for it rather than a wrong number. That error is passed through, so the
    /// answer is "Loaf cannot set the brightness on this display" rather than a
    /// silent no-op.
    #[cfg(target_os = "macos")]
    mod display {
        use std::ffi::CString;
        use std::os::raw::{c_char, c_int, c_void};
        use std::sync::OnceLock;

        extern "C" {
            fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
            fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        }

        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGMainDisplayID() -> u32;
        }

        const RTLD_LAZY: c_int = 0x1;
        const FRAMEWORK: &str =
            "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices";

        type GetFn = unsafe extern "C" fn(u32, *mut f32) -> c_int;
        type SetFn = unsafe extern "C" fn(u32, f32) -> c_int;

        /// The opened framework, or null if it is not there.
        ///
        /// `usize` rather than a pointer so it can live in a `OnceLock`, which
        /// must be `Sync`. The handle is never closed: it is process-lifetime,
        /// and `dlclose` on a framework other code may hold is worse than
        /// leaking one handle.
        fn handle() -> usize {
            static HANDLE: OnceLock<usize> = OnceLock::new();
            *HANDLE.get_or_init(|| {
                let Ok(path) = CString::new(FRAMEWORK) else {
                    return 0;
                };
                // SAFETY: a valid C string and a documented flag. dlopen
                // returns null on failure, which is checked by every caller.
                unsafe { dlopen(path.as_ptr(), RTLD_LAZY) as usize }
            })
        }

        fn symbol(name: &str) -> Option<*mut c_void> {
            let h = handle();
            if h == 0 {
                return None;
            }
            let cname = CString::new(name).ok()?;
            // SAFETY: `h` came from a successful dlopen and `cname` is a valid
            // C string. dlsym returns null when the symbol is absent.
            let ptr = unsafe { dlsym(h as *mut c_void, cname.as_ptr()) };
            if ptr.is_null() {
                None
            } else {
                Some(ptr)
            }
        }

        const MISSING: &str = "This version of macOS will not let Loaf read the screen brightness.";
        const REFUSED: &str = "Loaf cannot set the brightness on this display. \
             External monitors have their own controls.";

        pub fn get() -> Result<u8, String> {
            let ptr = symbol("DisplayServicesGetBrightness").ok_or(MISSING)?;
            // SAFETY: the symbol exists in DisplayServices with this signature,
            // and `level` is a valid, aligned, initialised f32 for the call.
            let f = unsafe { std::mem::transmute::<*mut c_void, GetFn>(ptr) };
            let mut level: f32 = 0.0;
            let rc = unsafe { f(CGMainDisplayID(), &mut level) };
            if rc != 0 {
                return Err(REFUSED.into());
            }
            Ok(super::super::clamp_percent((level * 100.0).round() as i64))
        }

        pub fn set(percent: u8) -> Result<(), String> {
            let ptr = symbol("DisplayServicesSetBrightness").ok_or(MISSING)?;
            // SAFETY: as above. The level is clamped into 0.0..=1.0 first, so
            // no out-of-range float reaches the framework.
            let f = unsafe { std::mem::transmute::<*mut c_void, SetFn>(ptr) };
            let level = (percent.min(100) as f32 / 100.0).clamp(0.0, 1.0);
            let rc = unsafe { f(CGMainDisplayID(), level) };
            if rc != 0 {
                return Err(REFUSED.into());
            }
            Ok(())
        }
    }

    #[cfg(target_os = "macos")]
    pub fn brightness() -> Result<u8, String> {
        display::get()
    }
    #[cfg(target_os = "macos")]
    pub fn set_brightness(percent: u8) -> Result<(), String> {
        display::set(percent)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn brightness() -> Result<u8, String> {
        Err(ELSEWHERE.into())
    }
    #[cfg(not(target_os = "macos"))]
    pub fn set_brightness(_percent: u8) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    /// Type text on macOS, through System Events.
    ///
    /// NEEDS THE ACCESSIBILITY PERMISSION, and there is no way around that:
    /// putting keystrokes into another application is exactly what that
    /// permission governs. macOS returns -1719 when it has not been granted,
    /// and that is turned into a sentence naming the switch to flip rather than
    /// a number nobody can act on.
    #[cfg(target_os = "macos")]
    pub fn type_text(text: &str) -> Result<(), String> {
        run(&super::macos_keys::typing(text))
    }

    #[cfg(target_os = "macos")]
    pub fn press(held: &[u16], key: u16) -> Result<(), String> {
        let script = super::macos_keys::script(held, key)
            .ok_or("Loaf does not know how to press that on a Mac.")?;
        run(&script)
    }

    #[cfg(target_os = "macos")]
    fn run(script: &str) -> Result<(), String> {
        let out = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("could not run osascript: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr).to_lowercase();
        // -1719 is errAEAccessDenied: Accessibility permission not granted.
        if err.contains("-1719") || err.contains("not allowed assistive") {
            return Err("macOS needs to let Loaf control your keyboard. \
                 System Settings, Privacy & Security, Accessibility, then switch Loaf on."
                .into());
        }
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn type_text(_text: &str) -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
    #[cfg(not(target_os = "macos"))]
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

    // ---- the macOS key translation ----------------------------------------
    //
    // Compiled and run on every platform on purpose. It is a lookup table, which
    // is the part most likely to hold a wrong number and least likely to be
    // noticed, and the machine this project is developed on is a PC.

    #[test]
    fn a_plain_letter_is_typed_as_a_character() {
        let (held, key) = parse_combo("a").unwrap();
        let script = macos_keys::script(&held, key).unwrap();
        assert!(script.contains(r#"keystroke "a""#), "{script}");
        assert!(!script.contains("using"), "{script}");
    }

    #[test]
    fn a_named_key_becomes_a_position_not_a_character() {
        let (held, key) = parse_combo("escape").unwrap();
        let script = macos_keys::script(&held, key).unwrap();
        assert!(script.contains("key code 53"), "{script}");
    }

    #[test]
    fn one_modifier_reads_as_a_single_using() {
        let (held, key) = parse_combo("ctrl+c").unwrap();
        let script = macos_keys::script(&held, key).unwrap();
        assert!(script.contains("using control down"), "{script}");
        assert!(
            !script.contains('{'),
            "a single modifier should not be a list: {script}"
        );
    }

    #[test]
    fn several_modifiers_read_as_a_list() {
        let (held, key) = parse_combo("ctrl+shift+t").unwrap();
        let script = macos_keys::script(&held, key).unwrap();
        assert!(script.contains("{control down, shift down}"), "{script}");
    }

    // The key next to the space bar is what a person means by "win", and on a
    // Mac that is command.
    #[test]
    fn win_becomes_command() {
        let (held, key) = parse_combo("win+h").unwrap();
        let script = macos_keys::script(&held, key).unwrap();
        assert!(script.contains("using command down"), "{script}");
    }

    // NOT helpfully translated to command. A spoken "control C" means the
    // control key, and quietly sending something else is a guess.
    #[test]
    fn ctrl_stays_control() {
        let (held, key) = parse_combo("ctrl+a").unwrap();
        let script = macos_keys::script(&held, key).unwrap();
        assert!(script.contains("control down"), "{script}");
        assert!(!script.contains("command down"), "{script}");
    }

    /// THE TEST THAT FOUND THE MEDIA-KEY GAP.
    ///
    /// If a name can be parsed on Windows it must be sendable on macOS, or a
    /// spoken command works on one platform and silently does nothing on the
    /// other — which is the exact failure the both-platforms rule exists to
    /// stop, and is invisible without a test like this one.
    #[test]
    fn every_named_key_can_be_pressed_on_a_mac() {
        for (name, _) in KEY_NAMES {
            let Some((held, key)) = parse_combo(name) else {
                panic!("{name} does not parse");
            };
            assert!(
                macos_keys::script(&held, key).is_some(),
                "{name} parses but cannot be pressed on a Mac"
            );
        }
    }

    // "press control" is a legal command: parse_combo yields no modifiers and
    // ctrl as the key. It parsed on both platforms and could be sent on only
    // one, which is exactly the silent gap the parity test exists to find.
    #[test]
    fn a_modifier_on_its_own_is_a_key_that_can_be_pressed() {
        for (name, code) in [("shift", 56), ("ctrl", 59), ("alt", 58), ("win", 55)] {
            let (held, key) = parse_combo(name).unwrap();
            assert!(
                held.is_empty(),
                "{name} should parse as the key, not a modifier"
            );
            let script = macos_keys::script(&held, key).unwrap();
            assert!(
                script.contains(&format!("key code {code}")),
                "{name}: {script}"
            );
        }
    }

    #[test]
    fn the_volume_keys_change_the_volume_rather_than_pressing_nothing() {
        for name in ["volumeup", "volumedown", "volumemute"] {
            let (held, key) = parse_combo(name).unwrap();
            let script = macos_keys::script(&held, key).unwrap();
            assert!(script.contains("set volume"), "{name}: {script}");
        }
    }

    #[test]
    fn the_transport_keys_ask_a_music_app_that_is_actually_running() {
        for (name, verb) in [
            ("playpause", "playpause"),
            ("nexttrack", "next track"),
            ("previoustrack", "previous track"),
        ] {
            let (held, key) = parse_combo(name).unwrap();
            let script = macos_keys::script(&held, key).unwrap();
            assert!(script.contains(verb), "{name}: {script}");
            // Never launches one that is closed, the same rule browser_macos
            // follows.
            assert!(script.contains("exists process"), "{name}: {script}");
        }
    }

    #[test]
    fn a_modifier_held_with_a_media_key_is_refused_rather_than_ignored() {
        let (_, key) = parse_combo("volumeup").unwrap();
        assert!(macos_keys::script(&[0x10], key).is_none());
    }

    #[test]
    fn the_arrow_keys_are_not_muddled() {
        // Transposing two of these is the classic way to get this table wrong,
        // and nothing else would ever notice.
        for (name, code) in [("left", 123), ("right", 124), ("down", 125), ("up", 126)] {
            let (held, key) = parse_combo(name).unwrap();
            let script = macos_keys::script(&held, key).unwrap();
            assert!(
                script.contains(&format!("key code {code}")),
                "{name}: {script}"
            );
        }
    }

    /// Written as a named constant because a lone escaped backslash inside a
    /// generated patch has been mangled twice on this project.
    const BACKSLASH: u8 = 92;

    #[test]
    fn dictated_text_cannot_carry_applescript_with_it() {
        let nasty = r#"hello" & (do shell script "rm -rf /") & ""#;
        let script = macos_keys::typing(nasty);
        // Every quote from the text is escaped; the only bare ones are the two
        // this function put around the literal itself.
        let bare = script
            .char_indices()
            .filter(|(i, c)| *c == '"' && *i > 0 && script.as_bytes()[i - 1] != BACKSLASH)
            .count();
        assert_eq!(bare, 4, "{script}");
    }

    /// Backslash before quote, or the escaping comes apart.
    ///
    /// If quotes were escaped first, the backslash each one added would then
    /// itself be doubled and the result would no longer close its own literal.
    /// Built from a named constant rather than written inline: a lone escaped
    /// backslash in a generated patch has now been mangled twice on this
    /// project, and a corrupt test string fails while the code is correct.
    #[test]
    fn a_backslash_is_escaped_before_the_quotes() {
        let bs = char::from(BACKSLASH);
        let input = format!("a{bs}b\"c");
        let expected = format!("a{bs}{bs}b{bs}\"c");
        assert_eq!(macos_keys::escape(&input), expected);
    }

    #[test]
    fn ordinary_dictation_is_left_alone() {
        let script = macos_keys::typing("remind me at ten");
        assert!(
            script.contains(r#"keystroke "remind me at ten""#),
            "{script}"
        );
    }

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
