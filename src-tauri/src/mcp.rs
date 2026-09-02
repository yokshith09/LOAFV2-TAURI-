//! Answering an assistant's questions about your own screen time.
//!
//! THE DIRECTION IS THE WHOLE DESIGN. Loaf is an MCP **server**: an assistant
//! you already use asks it questions, and it answers from a file that is
//! already on your disk. It is not an MCP client, does not call out to
//! anything, and nothing here opens a socket. That direction is what keeps
//! "Loaf makes no network calls" true — the assistant is the one with the
//! network, and it was already reading and writing on your behalf before Loaf
//! was involved.
//!
//! IT IS READ-ONLY, AND THAT IS LOAD-BEARING. There is no tool here that
//! resets a day, deletes a site, adds a task or changes a setting. An assistant
//! that can be talked into "clear my history" by a web page it read is a
//! confused deputy with access to the one file Loaf exists to protect. Every
//! tool below is a question.
//!
//! SITES ARE OFF BY DEFAULT. The history holds three things: which apps you
//! used, which hours you were at the machine, and which domains you visited.
//! The first two describe your working day; the third describes your life. It
//! is excluded unless `LOAF_MCP_SITES=1` is set deliberately, and that split is
//! the difference between "how long was I coding" and "what was he reading".
//!
//! It reads the same `stats.json` the app writes, so it works whether or not
//! Loaf is running. The cost is that the companion holds up to a minute of
//! unsaved ticks in memory, so "today" can be a minute behind. That is worth
//! saying in the tool description rather than hiding.

use std::collections::BTreeMap;

/// One day, as the file stores it.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct Day {
    #[serde(default)]
    pub apps: BTreeMap<String, f64>,
    #[serde(default)]
    pub hours: Vec<f64>,
    /// Browser name, then domain, then seconds. Nested, not flat: the file
    /// records which browser a site was seen in. Getting this wrong made
    /// every single day fail to parse and the whole history read as empty,
    /// while the protocol itself answered perfectly.
    #[serde(default)]
    pub sites: BTreeMap<String, BTreeMap<String, f64>>,
}

/// The whole history: date string to day.
pub type History = BTreeMap<String, Day>;

/// Parse a history, tolerating anything unexpected in it.
///
/// Every key is optional and every day that will not parse is skipped rather
/// than failing the whole read. Real users' files predate this code by
/// versions, and one malformed day must not make the other two hundred
/// unreadable.
pub fn parse(json: &str) -> History {
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(json) else {
        return History::new();
    };
    let Some(object) = raw.as_object() else {
        return History::new();
    };
    let mut out = History::new();
    for (date, value) in object {
        if let Ok(day) = serde_json::from_value::<Day>(value.clone()) {
            out.insert(date.clone(), day);
        }
    }
    out
}

pub fn total_seconds(day: &Day) -> f64 {
    day.apps
        .values()
        .copied()
        .filter(|v| v.is_finite() && *v > 0.0)
        .sum()
}

/// Apps by time spent, longest first.
pub fn top_apps(day: &Day, limit: usize) -> Vec<(String, f64)> {
    let mut apps: Vec<(String, f64)> = day
        .apps
        .iter()
        .filter(|(_, v)| v.is_finite() && **v > 0.0)
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    // Ties broken by name so the same history always produces the same answer.
    apps.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    apps.truncate(limit);
    apps
}

/// "2h 14m", or "0m". Hours are what people ask for; seconds are noise.
pub fn human(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "0m".into();
    }
    let total = seconds.round() as i64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

/// The last `n` dates present, oldest first.
pub fn recent_dates(history: &History, n: usize) -> Vec<String> {
    let mut dates: Vec<String> = history.keys().cloned().collect();
    dates.sort();
    if dates.len() > n {
        dates.drain(..dates.len() - n);
    }
    dates
}

/// Whether site data may be reported at all.
///
/// Deliberately an environment variable rather than a tool argument: an
/// assistant must not be able to opt itself in. The person running the server
/// decides once, outside the conversation.
pub fn sites_allowed() -> bool {
    std::env::var("LOAF_MCP_SITES")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// A summary of one day, as prose an assistant can quote.
pub fn describe_day(date: &str, day: &Day, with_sites: bool) -> String {
    let total = total_seconds(day);
    if total <= 0.0 {
        return format!("{date}: nothing recorded.");
    }
    let mut out = format!("{date}: {} at the machine.", human(total));
    let apps = top_apps(day, 5);
    if !apps.is_empty() {
        out.push_str("\nMost time in:");
        for (name, seconds) in apps {
            out.push_str(&format!("\n  {name} — {}", human(seconds)));
        }
    }
    if with_sites {
        let sites = top_sites(day, 5);
        if !sites.is_empty() {
            out.push_str("\nSites:");
            for (name, seconds) in sites {
                out.push_str(&format!("\n  {name} — {}", human(seconds)));
            }
        }
    }
    out
}

/// Domains across every browser, longest first.
///
/// Flattened: which browser a site was open in is not what anyone is asking,
/// and the same domain in two browsers is one habit rather than two.
pub fn top_sites(day: &Day, limit: usize) -> Vec<(String, f64)> {
    let mut totals: BTreeMap<String, f64> = BTreeMap::new();
    for domains in day.sites.values() {
        for (domain, seconds) in domains {
            if seconds.is_finite() && *seconds > 0.0 {
                *totals.entry(domain.clone()).or_insert(0.0) += *seconds;
            }
        }
    }
    let mut sites: Vec<(String, f64)> = totals.into_iter().collect();
    sites.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    sites.truncate(limit);
    sites
}

/// The busiest hours of a day, as "09:00 — 42m" lines.
pub fn describe_hours(day: &Day) -> String {
    let mut hours: Vec<(usize, f64)> = day
        .hours
        .iter()
        .enumerate()
        .filter(|(_, v)| v.is_finite() && **v > 0.0)
        .map(|(i, v)| (i, *v))
        .collect();
    if hours.is_empty() {
        return "Nothing recorded by hour.".into();
    }
    hours.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    hours.truncate(5);
    hours
        .into_iter()
        .map(|(hour, seconds)| format!("{hour:02}:00 — {}", human(seconds)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One meeting, as the app writes it. Mirrors `Meeting` in meetings.ts.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct Meeting {
    #[serde(default)]
    pub where_: String,
    #[serde(default)]
    pub started_at: f64,
    #[serde(default)]
    pub seconds: f64,
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Parse the meeting log, tolerating anything odd in it.
///
/// The frontend writes `where`, which is a Rust keyword, so the field is
/// renamed here rather than in the TypeScript — the file format belongs to the
/// app, and bending it to suit this language would be the wrong way round.
pub fn parse_meetings(json: &str) -> Vec<Meeting> {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(default, rename = "where")]
        where_: String,
        #[serde(default, rename = "startedAt")]
        started_at: f64,
        #[serde(default)]
        seconds: f64,
        #[serde(default)]
        notes: Vec<String>,
    }
    let Ok(raw) = serde_json::from_str::<Vec<Raw>>(json) else {
        return Vec::new();
    };
    raw.into_iter()
        .filter(|m| !m.where_.is_empty() && m.seconds.is_finite() && m.seconds > 0.0)
        .map(|m| Meeting {
            where_: m.where_,
            started_at: m.started_at,
            seconds: m.seconds,
            notes: m.notes,
        })
        .collect()
}

/// The most recent meetings, as prose.
///
/// Says plainly what this is and is not, because an assistant reading it will
/// otherwise assume a meeting record contains what was said.
pub fn describe_meetings(meetings: &[Meeting], limit: usize) -> String {
    if meetings.is_empty() {
        return "No meetings recorded. Loaf notices calls from which application \
                is in front; it does not record or transcribe them."
            .into();
    }
    let mut recent: Vec<&Meeting> = meetings.iter().collect();
    recent.sort_by(|a, b| {
        b.started_at
            .partial_cmp(&a.started_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    recent.truncate(limit);
    let mut out = String::from(
        "Meetings Loaf noticed. These are times and the user's own typed notes \
         — no audio was recorded and nothing was transcribed.\n",
    );
    for m in recent {
        out.push_str(&format!("\n{} in {}", human(m.seconds), m.where_));
        for note in &m.notes {
            out.push_str(&format!("\n    note: {note}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day() -> Day {
        let mut apps = BTreeMap::new();
        apps.insert("Code".to_string(), 7200.0);
        apps.insert("Chrome".to_string(), 3600.0);
        apps.insert("Slack".to_string(), 600.0);
        let mut chrome = BTreeMap::new();
        chrome.insert("example.com".to_string(), 1800.0);
        chrome.insert("other.com".to_string(), 60.0);
        let mut firefox = BTreeMap::new();
        firefox.insert("example.com".to_string(), 600.0);
        let mut sites = BTreeMap::new();
        sites.insert("Chrome".to_string(), chrome);
        sites.insert("Firefox".to_string(), firefox);
        Day {
            apps,
            hours: vec![0.0; 9].into_iter().chain([2400.0, 1200.0]).collect(),
            sites,
        }
    }

    #[test]
    fn parses_the_meeting_log_the_app_writes() {
        let json = r#"[{"id":"1","where":"Zoom","startedAt":1000,"endedAt":2000,
            "seconds":1800,"notes":["send the spec"]}]"#;
        let meetings = parse_meetings(json);
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0].where_, "Zoom");
        assert_eq!(meetings[0].notes, vec!["send the spec"]);
    }

    #[test]
    fn drops_meetings_that_make_no_sense() {
        assert!(parse_meetings("not json").is_empty());
        assert!(parse_meetings(r#"[{"where":"","seconds":10}]"#).is_empty());
        assert!(parse_meetings(r#"[{"where":"Zoom","seconds":0}]"#).is_empty());
    }

    // An assistant reading this will otherwise assume a meeting record holds
    // what was said in it.
    #[test]
    fn says_that_nothing_was_recorded() {
        let text = describe_meetings(&[], 5);
        assert!(text.contains("does not record"));
        let one =
            parse_meetings(r#"[{"where":"Zoom","startedAt":1,"seconds":1800,"notes":["a"]}]"#);
        let text = describe_meetings(&one, 5);
        assert!(text.contains("nothing was transcribed"), "{text}");
        assert!(text.contains("30m in Zoom"));
        assert!(text.contains("note: a"));
    }

    #[test]
    fn totals_only_positive_finite_time() {
        let mut d = day();
        d.apps.insert("Broken".into(), f64::NAN);
        d.apps.insert("Negative".into(), -100.0);
        assert_eq!(total_seconds(&d), 11400.0);
    }

    #[test]
    fn ranks_apps_by_time() {
        let apps = top_apps(&day(), 2);
        assert_eq!(apps[0].0, "Code");
        assert_eq!(apps[1].0, "Chrome");
    }

    #[test]
    fn reads_hours_as_hours_and_minutes() {
        assert_eq!(human(7200.0), "2h 0m");
        assert_eq!(human(3660.0), "1h 1m");
        assert_eq!(human(600.0), "10m");
        assert_eq!(human(0.0), "0m");
        assert_eq!(human(-5.0), "0m");
        assert_eq!(human(f64::NAN), "0m");
    }

    // Real users' files predate this code by versions. One malformed day must
    // not make the other two hundred unreadable.
    #[test]
    fn survives_a_file_it_does_not_recognise() {
        assert!(parse("not json at all").is_empty());
        assert!(parse("[1,2,3]").is_empty());
        let mixed = r#"{"2026-01-01":{"apps":{"A":60}},"2026-01-02":"nonsense"}"#;
        let history = parse(mixed);
        assert_eq!(history.len(), 1);
        assert!(history.contains_key("2026-01-01"));
    }

    #[test]
    fn tolerates_missing_keys() {
        let history = parse(r#"{"2026-01-01":{}}"#);
        assert_eq!(history.len(), 1);
        assert_eq!(total_seconds(&history["2026-01-01"]), 0.0);
    }

    #[test]
    fn takes_the_most_recent_dates_in_order() {
        let history = parse(r#"{"2026-01-03":{},"2026-01-01":{},"2026-01-02":{},"2026-01-04":{}}"#);
        assert_eq!(recent_dates(&history, 2), vec!["2026-01-03", "2026-01-04"]);
        assert_eq!(recent_dates(&history, 99).len(), 4);
    }

    // The third thing in the file describes your life rather than your working
    // day, so it is excluded unless somebody deliberately turned it on.
    #[test]
    fn leaves_sites_out_unless_asked() {
        let text = describe_day("2026-01-01", &day(), false);
        assert!(!text.contains("example.com"), "{text}");
        let with = describe_day("2026-01-01", &day(), true);
        assert!(with.contains("example.com"));
    }

    // The shape that broke it: sites are nested by browser, and a flat type
    // here made EVERY day fail to parse while the server answered perfectly.
    #[test]
    fn parses_the_shape_the_app_actually_writes() {
        let real = r#"{"2026-09-02":{"apps":{"Claude":1485,"Chrome":4100},
            "hours":[1095,610,0,0],
            "sites":{"Chrome":{"chatgpt.com":1630,"web.whatsapp.com":15}}}}"#;
        let history = parse(real);
        assert_eq!(history.len(), 1, "the real file shape must parse");
        let day = &history["2026-09-02"];
        assert_eq!(total_seconds(day), 5585.0);
        assert_eq!(top_sites(day, 1)[0].0, "chatgpt.com");
    }

    #[test]
    fn adds_a_domain_up_across_browsers() {
        // The same domain in two browsers is one habit, not two.
        assert_eq!(top_sites(&day(), 1)[0], ("example.com".to_string(), 2400.0));
    }

    #[test]
    fn says_so_when_a_day_is_empty() {
        let text = describe_day("2026-01-01", &Day::default(), true);
        assert!(text.contains("nothing recorded"));
    }

    #[test]
    fn describes_the_busiest_hours() {
        let text = describe_hours(&day());
        assert!(text.starts_with("09:00"), "{text}");
        assert!(text.contains("40m"), "{text}");
    }

    #[test]
    fn has_something_to_say_with_no_hours() {
        assert!(describe_hours(&Day::default()).contains("Nothing recorded"));
    }
}
