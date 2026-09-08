//! Loaf saying something out loud.
//!
//! The last stage of the voice chain, and the one that costs nothing to build:
//! both platforms have ended up with a speech synthesiser in the box, so there
//! is no model to download, no runtime to bundle and no licence to read.
//!
//!   macOS    `/usr/bin/say`, which has been there since before Mac OS X.
//!   Windows  `System.Speech.Synthesis`, part of .NET, driven through
//!            PowerShell so nothing has to be linked.
//!
//! WHY IT MATTERS FOR A PET RATHER THAN A TOOL. Loaf has a face and a name and
//! it has never had a voice — everything it says arrives as a speech bubble you
//! have to be looking at. A companion that can answer while you are looking at
//! something else is a different thing to live with. It is also the half of a
//! conversation that makes the other half worth having: there is little point
//! being able to ask a question across the room if the answer is written in a
//! 134-pixel window behind your editor.
//!
//! IT IS OFF UNTIL IT IS ASKED FOR, like everything else here. A desktop pet
//! that starts talking unprompted is not a feature anybody wants twice.
//!
//! WHAT THIS DELIBERATELY DOES NOT DO YET: barge-in. Interrupting Loaf
//! mid-sentence needs the microphone to keep listening while the speakers are
//! playing, and that needs echo cancellation or Loaf hears itself and answers
//! its own voice. `stop` is here so a caller can cut it off, which is the
//! blunt version; the real thing is a later job and is named in the milestone
//! rather than half-built here.
//!
//! Everything except the actual spawn is a pure function, tested on every
//! platform. Both synthesisers take their text as a quoted string inside a
//! command, so the escaping is the part where a mistake is an injection — and
//! the text is a sentence Loaf assembled from things like an app name or a
//! meeting title, which are not ours.

/// The longest thing Loaf will say.
///
/// A companion reading out a whole transcript is a companion nobody can
/// interrupt. Anything longer is cut, because a sentence that stops is better
/// than a paragraph that cannot be stopped.
pub const MAX_CHARS: usize = 300;

/// Trim and cap a sentence before it is spoken.
pub fn shorten(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_CHARS).collect();
    out.push('…');
    out
}

/// Make text safe inside a single-quoted PowerShell string.
///
/// PowerShell escapes a single quote by doubling it, not with a backslash.
/// Getting that wrong is not a cosmetic bug: the text is inside a command that
/// is about to be executed, and a bare quote would end the string and leave the
/// rest as script.
pub fn powershell_quote(text: &str) -> String {
    text.replace('\'', "''")
}

/// The PowerShell that speaks a sentence on Windows.
///
/// `-Command` with the whole thing inline rather than a script file: there is
/// nothing to clean up afterwards and nothing on disk to be tampered with
/// between writing and running it.
pub fn windows_command(text: &str) -> String {
    format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.Speak('{}')",
        powershell_quote(&shorten(text))
    )
}

/// The arguments for `/usr/bin/say` on macOS.
///
/// The text goes as its own argument rather than inside a script, so there is
/// no quoting to get wrong — the operating system hands it to the process
/// whole. This is the safest shape available and it is worth preferring
/// wherever a platform allows it.
pub fn macos_args(text: &str) -> Vec<String> {
    vec![shorten(text)]
}

/// Whether this platform can speak at all.
pub fn available() -> bool {
    cfg!(any(windows, target_os = "macos"))
}

/// Say something. Returns as soon as it has started, not when it has finished.
///
/// Deliberately fire-and-forget. A companion that blocks a command for four
/// seconds while it finishes a sentence is a companion that feels broken, and
/// the caller has nothing useful to do with "it finished talking" anyway.
pub fn say(text: &str) -> Result<(), String> {
    let text = shorten(text);
    if text.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/say")
            .args(macos_args(&text))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not speak: {e}"))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &windows_command(&text),
            ])
            // Without this a console window flashes up on every sentence, which
            // is worse than not speaking at all.
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not speak: {e}"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = text;
        Err("This platform has no voice.".into())
    }
}

/// Stop whatever is being said.
///
/// The blunt version of barge-in: it cuts the synthesiser off rather than
/// letting somebody talk over it. Real barge-in needs echo cancellation, is
/// named in the milestone, and is not half-built here.
pub fn stop() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/killall")
            .args(["-q", "say"])
            .spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Only the synthesiser processes Loaf started: matched on the command
        // line, so a PowerShell window the user is working in is not touched.
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | \
                 Where-Object { $_.CommandLine -like '*SpeechSynthesizer*' } | \
                 ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_left_alone() {
        assert_eq!(shorten("Kept in your notes."), "Kept in your notes.");
    }

    #[test]
    fn surrounding_space_goes() {
        assert_eq!(shorten("  hello  "), "hello");
    }

    // A companion reading out a whole transcript is one nobody can interrupt.
    #[test]
    fn a_long_sentence_is_cut_rather_than_read_out_forever() {
        let long = "a".repeat(1000);
        let said = shorten(&long);
        assert!(
            said.chars().count() <= MAX_CHARS + 1,
            "{}",
            said.chars().count()
        );
        assert!(said.ends_with('…'));
    }

    #[test]
    fn cutting_counts_characters_not_bytes() {
        // Four bytes each. Counting bytes would cut one in half and produce
        // text no synthesiser can read.
        let emoji = "🍞".repeat(500);
        let said = shorten(&emoji);
        assert!(said.chars().count() <= MAX_CHARS + 1);
        // Still valid text, which is the actual thing being asserted.
        assert!(said.chars().all(|c| c == '🍞' || c == '…'));
    }

    #[test]
    fn nothing_to_say_is_not_an_error() {
        assert_eq!(shorten("   "), "");
        assert!(say("").is_ok());
    }

    // PowerShell escapes a single quote by DOUBLING it. A backslash does
    // nothing, and a bare quote would end the string and leave the rest as
    // script — inside a command that is about to be executed.
    /// True when every run of single quotes has even length.
    ///
    /// A doubled quote is an escaped one; an odd run means a bare quote
    /// survived and would end the PowerShell string. Asserted as the property
    /// rather than by hunting for a substring: the first version of this test
    /// checked that the output did not contain a quote followed by "; Remove",
    /// which correctly escaped text contains too — inside the doubled pair. It
    /// failed while the escaping was right, which is the worse of the two ways
    /// to be wrong, and is now the third time on this project.
    fn every_quote_is_doubled(s: &str) -> bool {
        let mut run = 0usize;
        for c in s.chars() {
            if c == '\'' {
                run += 1;
            } else {
                if run % 2 != 0 {
                    return false;
                }
                run = 0;
            }
        }
        run % 2 == 0
    }

    #[test]
    fn the_quote_check_itself_is_not_vacuous() {
        let q = '\'';
        assert!(!every_quote_is_doubled(&format!("a{q}b")));
        assert!(every_quote_is_doubled(&format!("a{q}{q}b")));
        assert!(!every_quote_is_doubled(&format!("a{q}{q}{q}b")));
        assert!(every_quote_is_doubled("no quotes here"));
    }

    #[test]
    fn a_quote_cannot_end_the_powershell_string() {
        let nasty = "'; Remove-Item C:\\ -Recurse; '";
        let quoted = powershell_quote(nasty);
        assert!(every_quote_is_doubled(&quoted), "{quoted}");
    }

    #[test]
    fn an_apostrophe_in_ordinary_speech_survives() {
        let said = windows_command("that's your third hour in Figma");
        assert!(said.contains("that''s"), "{said}");
    }

    #[test]
    fn the_windows_command_speaks_the_text() {
        let cmd = windows_command("hello there");
        assert!(cmd.contains("SpeechSynthesizer"));
        assert!(cmd.contains("$s.Speak('hello there')"), "{cmd}");
    }

    #[test]
    fn the_windows_command_caps_the_length_too() {
        let cmd = windows_command(&"a".repeat(1000));
        assert!(cmd.len() < 600, "{}", cmd.len());
    }

    // The text goes as its own argument, so the operating system hands it to
    // the process whole and there is no quoting to get wrong at all.
    #[test]
    fn macos_passes_the_text_as_one_argument() {
        let args = macos_args("hello; rm -rf /");
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], "hello; rm -rf /");
    }

    #[test]
    fn macos_caps_the_length_too() {
        assert!(macos_args(&"a".repeat(1000))[0].chars().count() <= MAX_CHARS + 1);
    }

    #[test]
    fn both_desktop_platforms_can_speak() {
        // Both have a synthesiser in the box, which is the whole reason this
        // stage cost nothing. If this ever fails, the claim in the module
        // comment has stopped being true.
        assert_eq!(available(), cfg!(any(windows, target_os = "macos")));
    }
}
