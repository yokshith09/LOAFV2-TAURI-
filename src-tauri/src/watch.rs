//! Loaf noticing something on its own, which is the only reason the MCP client
//! is worth having.
//!
//! WHY THIS EXISTS. Loaf can already start another program and call its tools —
//! but only when somebody presses a button, which is a worse version of the
//! chat window they already have. The thing a chat window cannot do is act at
//! the moment something happens, because nobody is sitting in it. Loaf is
//! already running. So the useful shape is always "when X changes, say so",
//! never "let me ask on your behalf".
//!
//! EVERY DECISION IS HERE AND THE LOOP HOLDS NONE. A poller that reaches the
//! network is the one part of this that cannot be tested honestly, so it is
//! reduced to: ask what is due, call it, ask whether that changed anything.
//! Each of those three questions is a pure function below with tests.
//!
//! THE RULES THIS ENCODES, all of which are about not being a nuisance or a
//! surprise:
//!
//!  - **A watch does nothing until the user makes one.** Nothing ships
//!    built-in, there is no discovery, and no list of suggestions.
//!  - **The first run never speaks.** It records what is there now. Otherwise
//!    adding a watch on a mailbox announces every message already in it, which
//!    is the version of this feature people turn off within a minute.
//!  - **A minimum interval.** A watch is a program being started and asked a
//!    question; letting someone set five seconds is letting them hammer
//!    somebody's server from a pet.
//!  - **Only changes speak.** The same answer as last time is silence.

use serde::{Deserialize, Serialize};

/// The shortest a watch may repeat, whatever the config says.
///
/// One minute. Mail is the motivating case and mail does not need better than
/// that; anything faster is a cost paid on somebody else's server for a
/// difference nobody can perceive.
pub const MIN_SECONDS: u64 = 60;

/// The longest a bubble may be. A speech bubble is not a reading window.
pub const BUBBLE_CHARS: usize = 160;

/// One thing Loaf keeps an eye on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watch {
    /// Which connected server, by the name the user gave it.
    pub server: String,
    /// The tool on that server to call.
    pub tool: String,
    /// Arguments as JSON text, exactly as the Connections panel sends them.
    #[serde(default)]
    pub arguments: String,
    /// How often to ask, in seconds. Clamped by [`interval`].
    pub every_seconds: u64,
    /// What Loaf says when it changes. Empty means a plain default.
    #[serde(default)]
    pub say: String,
    /// Off unless the user switched it on.
    #[serde(default)]
    pub enabled: bool,
}

/// How often this watch may actually run.
///
/// Clamped rather than rejected: a config asking for five seconds is a user
/// wanting it prompt, not a user wanting to be a nuisance, and refusing to load
/// their config over it would lose the whole file.
pub fn interval(watch: &Watch) -> u64 {
    watch.every_seconds.max(MIN_SECONDS)
}

/// Whether this watch should run now.
///
/// `last_run` is None the first time, which is always due — that run is what
/// establishes the baseline everything after it is compared against.
pub fn due(watch: &Watch, now: u64, last_run: Option<u64>) -> bool {
    if !watch.enabled {
        return false;
    }
    match last_run {
        None => true,
        // Saturating, because a clock that goes backwards over a daylight
        // change would otherwise make every watch overdue at once.
        Some(then) => now.saturating_sub(then) >= interval(watch),
    }
}

/// What a run turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing was known before. Remember it and stay quiet.
    First,
    /// The same answer as last time.
    Same,
    /// Different. This is the one that speaks.
    Changed,
}

pub fn compare(previous: Option<&str>, now: &str) -> Outcome {
    match previous {
        None => Outcome::First,
        Some(before) if before == now => Outcome::Same,
        Some(_) => Outcome::Changed,
    }
}

/// A short stable stand-in for an answer, so Loaf does not keep a copy of the
/// mailbox on disk in order to know the mailbox changed.
///
/// Not a cryptographic hash and does not need to be: it is comparing a value
/// against the previous value of the same thing. What it must be is *stable
/// across runs*, which rules out `DefaultHasher`, whose seed is not guaranteed
/// between releases — a hash that changes on upgrade would announce a change
/// nobody made, once, for every watch.
pub fn digest(text: &str) -> String {
    // FNV-1a, 64-bit. Fifteen lines, no dependency, and the same answer on
    // every machine and every build.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The line Loaf says when a watch changes.
///
/// The user's own words if they wrote any, because "you have mail" is better
/// than anything this code could infer from a JSON blob. Otherwise it names
/// what changed rather than pretending to summarise it — a bubble claiming to
/// know what a tool returned, when all Loaf did was notice the bytes differ,
/// would be inventing.
pub fn bubble_line(watch: &Watch, answer: &str) -> String {
    let said = if watch.say.trim().is_empty() {
        format!("Something changed in {} — {}.", watch.server, watch.tool)
    } else {
        watch.say.trim().to_string()
    };
    let extra = first_line(answer);
    if extra.is_empty() {
        return shorten(&said);
    }
    shorten(&format!("{said} {extra}"))
}

/// The first non-empty line of an answer, for the bubble.
///
/// Answers from a tool are frequently long and frequently JSON. One line is
/// what fits, and taking the first is at least honest about being a fragment.
fn first_line(answer: &str) -> String {
    answer
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Cut to length on a character boundary, never a byte one.
fn shorten(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= BUBBLE_CHARS {
        return trimmed.to_string();
    }
    let kept: String = trimmed
        .chars()
        .take(BUBBLE_CHARS.saturating_sub(1))
        .collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> Watch {
        Watch {
            server: "gmail".into(),
            tool: "list_unread".into(),
            arguments: "{}".into(),
            every_seconds: 300,
            say: String::new(),
            enabled: true,
        }
    }

    #[test]
    fn a_watch_that_is_off_is_never_due() {
        let mut w = watch();
        w.enabled = false;
        assert!(!due(&w, 10_000, None));
        assert!(!due(&w, 10_000, Some(0)));
    }

    #[test]
    fn the_first_run_is_always_due() {
        assert!(due(&watch(), 0, None));
    }

    #[test]
    fn it_waits_its_interval() {
        let w = watch();
        assert!(!due(&w, 1_100, Some(1_000)));
        assert!(due(&w, 1_300, Some(1_000)));
    }

    #[test]
    fn a_clock_that_goes_backwards_does_not_make_everything_overdue() {
        // The machine slept, or the timezone changed under it.
        assert!(!due(&watch(), 500, Some(1_000)));
    }

    #[test]
    fn nobody_may_poll_faster_than_the_floor() {
        let mut w = watch();
        w.every_seconds = 1;
        assert_eq!(interval(&w), MIN_SECONDS);
        assert!(!due(&w, 30, Some(0)));
        assert!(due(&w, MIN_SECONDS, Some(0)));
    }

    #[test]
    fn a_longer_interval_is_honoured_as_written() {
        let mut w = watch();
        w.every_seconds = 3_600;
        assert_eq!(interval(&w), 3_600);
    }

    // The bug this whole enum exists to prevent: adding a watch on a mailbox
    // and being told about every message already in it.
    #[test]
    fn the_first_answer_is_remembered_silently() {
        assert_eq!(compare(None, "anything"), Outcome::First);
    }

    #[test]
    fn the_same_answer_says_nothing() {
        assert_eq!(compare(Some("abc"), "abc"), Outcome::Same);
    }

    #[test]
    fn a_different_answer_speaks() {
        assert_eq!(compare(Some("abc"), "abd"), Outcome::Changed);
    }

    #[test]
    fn the_digest_is_the_same_every_run() {
        // If this ever stops holding, every watch announces a change nobody
        // made, once, on the release that broke it.
        assert_eq!(digest("hello"), digest("hello"));
        assert_eq!(digest("hello"), "a430d84680aabd0b");
    }

    #[test]
    fn different_text_digests_differently() {
        assert_ne!(digest("one message"), digest("two messages"));
        assert_ne!(digest(""), digest(" "));
    }

    #[test]
    fn the_bubble_uses_the_users_own_words_when_they_wrote_any() {
        let mut w = watch();
        w.say = "You have new mail.".into();
        assert!(bubble_line(&w, "").starts_with("You have new mail."));
    }

    #[test]
    fn the_bubble_names_the_server_and_tool_when_they_did_not() {
        let line = bubble_line(&watch(), "");
        assert!(line.contains("gmail"));
        assert!(line.contains("list_unread"));
    }

    #[test]
    fn the_bubble_adds_the_first_line_of_the_answer() {
        let mut w = watch();
        w.say = "New mail.".into();
        let line = bubble_line(&w, "\n\n  From: Priya — the pricing page  \nmore stuff");
        assert!(line.contains("From: Priya"));
        assert!(!line.contains("more stuff"));
    }

    #[test]
    fn a_long_answer_is_cut_to_something_sayable() {
        let mut w = watch();
        w.say = "New mail.".into();
        let line = bubble_line(&w, &"x".repeat(1_000));
        assert!(line.chars().count() <= BUBBLE_CHARS);
        assert!(line.ends_with('…'));
    }

    // Cutting a multi-byte character in half panics on a byte slice, and the
    // first person to receive mail with an emoji subject would have found it.
    #[test]
    fn cutting_never_splits_a_character() {
        let mut w = watch();
        w.say = "📬".repeat(200);
        let line = bubble_line(&w, "");
        assert!(line.chars().count() <= BUBBLE_CHARS);
    }

    #[test]
    fn a_short_answer_is_left_alone() {
        let mut w = watch();
        w.say = "New mail.".into();
        assert_eq!(bubble_line(&w, ""), "New mail.");
    }
}
