//! The store: one SQLite file holding everything Loaf remembers.
//!
//! WHAT THIS REPLACES, AND WHY IT HAD TO. Until now the history was a JSON file
//! rewritten whole on every save, the meetings were a second JSON file loaded
//! whole to be listed, and the knowledge graph lived in the WebView's own
//! storage — invisible to this process, capped at a few megabytes, and **wiped
//! without warning if site data is ever cleared**. Nothing could be searched at
//! all: a phrase said in a meeting six weeks ago could only be found by
//! scrolling. None of that survives contact with screen capture, which is
//! thousands of rows a day rather than one.
//!
//! THE MIGRATION NEVER DESTROYS ANYTHING. It reads the old files and writes
//! their contents in; it does not delete them, move them, or rewrite them. A
//! user who ends up on an older build finds their history exactly where it was.
//! That is deliberate and it costs one duplicated copy of a small file, which is
//! a trade worth making for months of somebody's recorded life.
//!
//! IT IS ALSO TOLERANT ON THE WAY IN AND STRICT ON THE WAY OUT. Real files
//! predate this code by many versions, so a day that will not parse is skipped
//! rather than failing the import — the same rule `storage.rs` and `mcp.rs`
//! already follow, and for the same reason: one malformed day must not make the
//! other two hundred unreadable.
//!
//! SEARCH IS FTS5 OVER TEXT THE USER PRODUCED. Meeting transcript lines and note
//! titles today; screen text later, into the same index, so one search covers
//! what was heard and what was seen. The index is kept in step with the rows by
//! triggers rather than by remembering to update it in every call site, because
//! "delete removed the row but left it in the search results" is exactly the
//! kind of bug that only shows up after somebody has deleted something they
//! badly wanted gone.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

/// The schema version this build writes. Bumped when the shape changes.
const SCHEMA: i32 = 1;

/// Where the store lives, beside the files it was built from.
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("LoafPlus").join("loaf.db")
}

/// One transcript line or note, as search returns it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Hit {
    pub id: i64,
    /// The meeting it was said in, or `None` for a standalone note.
    pub meeting: Option<String>,
    /// Where that meeting was — "Zoom", "Google Meet". Empty for a note.
    pub place: String,
    /// Seconds since the epoch.
    pub at: i64,
    pub text: String,
}

/// A finished meeting.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Meeting {
    pub id: String,
    pub place: String,
    pub started_at: i64,
    pub seconds: i64,
}

/// What a delete would remove, so it can be shown before it happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub struct Removal {
    pub meetings: usize,
    pub lines: usize,
    pub days: usize,
}

/// Open the store, creating and migrating it if needed.
pub fn open(data_dir: &Path) -> Result<Connection, String> {
    let path = db_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    prepare(&conn)?;
    Ok(conn)
}

/// An in-memory store, for tests and for anything that must not touch a disk.
pub fn open_in_memory() -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    prepare(&conn)?;
    Ok(conn)
}

fn prepare(conn: &Connection) -> Result<(), String> {
    // WAL so a long read cannot block the tracker's next write. The tracker
    // writes every minute and search reads can take a while over a year of
    // transcripts; the default rollback journal makes those exclude each other.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Time. One row per app per day rather than a JSON blob per day, so a
        -- range can be deleted and a total can be summed without reading and
        -- rewriting the whole history.
        CREATE TABLE IF NOT EXISTS app_seconds (
            day     TEXT NOT NULL,
            app     TEXT NOT NULL,
            seconds REAL NOT NULL,
            PRIMARY KEY (day, app)
        );
        CREATE TABLE IF NOT EXISTS hour_seconds (
            day     TEXT NOT NULL,
            hour    INTEGER NOT NULL,
            seconds REAL NOT NULL,
            PRIMARY KEY (day, hour)
        );
        CREATE TABLE IF NOT EXISTS site_seconds (
            day     TEXT NOT NULL,
            browser TEXT NOT NULL,
            domain  TEXT NOT NULL,
            seconds REAL NOT NULL,
            PRIMARY KEY (day, browser, domain)
        );

        CREATE TABLE IF NOT EXISTS meetings (
            id         TEXT PRIMARY KEY,
            place      TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL,
            seconds    INTEGER NOT NULL DEFAULT 0
        );

        -- The words. `meeting_id` is nullable because a dictated note that
        -- arrived outside a meeting is still worth finding later.
        CREATE TABLE IF NOT EXISTS lines (
            id         INTEGER PRIMARY KEY,
            meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
            at         INTEGER NOT NULL,
            text       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS lines_by_meeting ON lines(meeting_id);
        CREATE INDEX IF NOT EXISTS lines_by_time ON lines(at);

        -- External content: the text lives in `lines` and is not stored twice.
        CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
            text, content='lines', content_rowid='id', tokenize='porter unicode61'
        );

        -- TRIGGERS RATHER THAN REMEMBERING. Every path that deletes a line must
        -- also remove it from the index, and "deleted the row but left it in the
        -- search results" is the worst bug this file could have: the user asked
        -- for something to be gone and it still comes back when they search.
        CREATE TRIGGER IF NOT EXISTS lines_ai AFTER INSERT ON lines BEGIN
            INSERT INTO lines_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS lines_ad AFTER DELETE ON lines BEGIN
            INSERT INTO lines_fts(lines_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS lines_au AFTER UPDATE ON lines BEGIN
            INSERT INTO lines_fts(lines_fts, rowid, text) VALUES ('delete', old.id, old.text);
            INSERT INTO lines_fts(rowid, text) VALUES (new.id, new.text);
        END;
        "#,
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?1)",
        params![SCHEMA.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- importing --

/// Whether the one-time import has already run.
pub fn imported(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM meta WHERE key = 'imported'", [], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn mark_imported(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('imported', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bring the screen-time history in from `stats.json`.
///
/// Tolerant by design: a day that will not parse is skipped and the rest are
/// kept. Returns how many days were read, so the caller can say something true
/// rather than "done".
pub fn import_stats(conn: &Connection, json: &str) -> Result<usize, String> {
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(json) else {
        return Ok(0);
    };
    let Some(days) = raw.as_object() else {
        return Ok(0);
    };

    let mut read = 0usize;
    for (day, value) in days {
        let Some(entry) = value.as_object() else {
            continue;
        };
        read += 1;

        if let Some(apps) = entry.get("apps").and_then(|v| v.as_object()) {
            for (app, secs) in apps {
                let Some(s) = secs.as_f64() else { continue };
                conn.execute(
                    "INSERT OR REPLACE INTO app_seconds(day, app, seconds) VALUES (?1, ?2, ?3)",
                    params![day, app, s],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        if let Some(hours) = entry.get("hours").and_then(|v| v.as_array()) {
            for (hour, secs) in hours.iter().enumerate() {
                let Some(s) = secs.as_f64() else { continue };
                if s == 0.0 {
                    continue;
                }
                conn.execute(
                    "INSERT OR REPLACE INTO hour_seconds(day, hour, seconds) VALUES (?1, ?2, ?3)",
                    params![day, hour as i64, s],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // Nested browser -> domain -> seconds. Getting this shape wrong once
        // made every day fail to parse while the code around it looked correct,
        // so it is spelled out rather than inferred.
        if let Some(browsers) = entry.get("sites").and_then(|v| v.as_object()) {
            for (browser, domains) in browsers {
                let Some(domains) = domains.as_object() else {
                    continue;
                };
                for (domain, secs) in domains {
                    let Some(s) = secs.as_f64() else { continue };
                    conn.execute(
                        "INSERT OR REPLACE INTO site_seconds(day, browser, domain, seconds) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![day, browser, domain, s],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(read)
}

/// Turn whatever the frontend sent into SECONDS since the epoch.
///
/// The columns here are queried with `date(started_at, 'unixepoch')`, which
/// means seconds. The frontend stores JavaScript time, which means
/// milliseconds — `Sample.at` says so in as many words — and this function used
/// to write it through untouched.
///
/// Two things broke quietly as a result. `whenSaid` in the search panel
/// computed a wildly negative age and labelled EVERY result "just now"; and
/// `preview_range`/`delete_range`, comparing a millisecond value against a date
/// built from `unixepoch`, matched nothing — so "forget everything between
/// these dates" reported zero transcripts and deleted zero, which is the worst
/// possible way for a delete to fail.
///
/// Detected by magnitude rather than by trusting the caller: 1e11 seconds is
/// the year 5138, so anything larger is milliseconds. That keeps rows written
/// by older builds, which really were seconds, readable.
fn epoch_seconds(raw: i64) -> i64 {
    const MILLISECOND_THRESHOLD: i64 = 100_000_000_000;
    if raw.abs() >= MILLISECOND_THRESHOLD {
        raw / 1000
    } else {
        raw
    }
}

/// Bring the meetings and their transcripts in from `meetings.json`.
pub fn import_meetings(conn: &Connection, json: &str) -> Result<usize, String> {
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(json) else {
        return Ok(0);
    };
    // Tolerates both shapes seen in the wild: a bare array, and an object with
    // a `meetings` key.
    let list = raw
        .as_array()
        .cloned()
        .or_else(|| raw.get("meetings").and_then(|m| m.as_array()).cloned())
        .unwrap_or_default();

    let mut read = 0usize;
    for m in list {
        let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let place = m
            .get("where")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let started = epoch_seconds(m.get("startedAt").and_then(|v| v.as_i64()).unwrap_or(0));
        let seconds = m.get("seconds").and_then(|v| v.as_i64()).unwrap_or(0);

        conn.execute(
            "INSERT OR REPLACE INTO meetings(id, place, started_at, seconds) \
             VALUES (?1, ?2, ?3, ?4)",
            params![id, place, started, seconds],
        )
        .map_err(|e| e.to_string())?;
        read += 1;

        // Replace rather than append, so importing twice does not double every
        // transcript. The delete goes through the trigger, so the index follows.
        conn.execute("DELETE FROM lines WHERE meeting_id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        if let Some(notes) = m.get("notes").and_then(|v| v.as_array()) {
            for note in notes {
                let Some(text) = note.as_str() else { continue };
                if text.trim().is_empty() {
                    continue;
                }
                conn.execute(
                    "INSERT INTO lines(meeting_id, at, text) VALUES (?1, ?2, ?3)",
                    params![id, started, text],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(read)
}

/// Run the one-time import from whatever old files exist.
///
/// Safe to call at every launch: it does nothing once it has run, and the old
/// files are left exactly where they were.
pub fn import_once(conn: &Connection, data_dir: &Path) -> Result<(usize, usize), String> {
    if imported(conn) {
        return Ok((0, 0));
    }
    let dir = data_dir.join("LoafPlus");
    let days = std::fs::read_to_string(dir.join("stats.json"))
        .ok()
        .map(|t| import_stats(conn, &t))
        .transpose()?
        .unwrap_or(0);
    let meetings = std::fs::read_to_string(dir.join("meetings.json"))
        .ok()
        .map(|t| import_meetings(conn, &t))
        .transpose()?
        .unwrap_or(0);
    mark_imported(conn)?;
    Ok((days, meetings))
}

// ------------------------------------------------------------------ writing --

/// Record one line of transcript or one note.
pub fn add_line(
    conn: &Connection,
    meeting: Option<&str>,
    at: i64,
    text: &str,
) -> Result<i64, String> {
    if text.trim().is_empty() {
        return Err("there is nothing to remember".into());
    }
    conn.execute(
        "INSERT INTO lines(meeting_id, at, text) VALUES (?1, ?2, ?3)",
        params![meeting, at, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn add_meeting(conn: &Connection, m: &Meeting) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO meetings(id, place, started_at, seconds) VALUES (?1, ?2, ?3, ?4)",
        params![m.id, m.place, m.started_at, m.seconds],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- searching --

/// Turn what a person typed into something FTS5 will accept.
///
/// FTS5's query language treats plenty of ordinary punctuation as syntax, so a
/// search for `budget?` or `Q3 (draft)` is a **syntax error**, not zero results
/// — and an error message where results should be is worse than no matches.
/// Every word is quoted, which makes the whole thing a literal phrase search and
/// is what somebody typing into a search box means anyway.
pub fn to_query(input: &str) -> Option<String> {
    let words: Vec<String> = input
        .split_whitespace()
        .map(|w| {
            let cleaned: String = w
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'' || *c == '-')
                .collect();
            cleaned
        })
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w.replace('"', "")))
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(words.join(" "))
}

/// Find lines matching a phrase, newest first.
pub fn search(conn: &Connection, phrase: &str, limit: usize) -> Result<Vec<Hit>, String> {
    let Some(query) = to_query(phrase) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.meeting_id, COALESCE(m.place, ''), l.at, l.text \
             FROM lines_fts f \
             JOIN lines l ON l.id = f.rowid \
             LEFT JOIN meetings m ON m.id = l.meeting_id \
             WHERE lines_fts MATCH ?1 \
             ORDER BY l.at DESC, l.id DESC \
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![query, limit as i64], |r| {
            Ok(Hit {
                id: r.get(0)?,
                meeting: r.get(1)?,
                place: r.get(2)?,
                at: r.get(3)?,
                text: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn meetings(conn: &Connection) -> Result<Vec<Meeting>, String> {
    let mut stmt = conn
        .prepare("SELECT id, place, started_at, seconds FROM meetings ORDER BY started_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Meeting {
                id: r.get(0)?,
                place: r.get(1)?,
                started_at: r.get(2)?,
                seconds: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Total seconds per app for a day.
pub fn day_apps(conn: &Connection, day: &str) -> Result<BTreeMap<String, f64>, String> {
    let mut stmt = conn
        .prepare("SELECT app, seconds FROM app_seconds WHERE day = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![day], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (app, secs) = row.map_err(|e| e.to_string())?;
        out.insert(app, secs);
    }
    Ok(out)
}

// ----------------------------------------------------------------- deleting --

/// What deleting a date range would remove. Nothing is changed.
///
/// Separate from doing it, because "delete everything from March" is not a
/// sentence anybody should have to say twice to find out what it meant.
pub fn preview_range(conn: &Connection, from: &str, to: &str) -> Result<Removal, String> {
    let days: usize = conn
        .query_row(
            "SELECT COUNT(DISTINCT day) FROM app_seconds WHERE day BETWEEN ?1 AND ?2",
            params![from, to],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())? as usize;
    // Meetings are timestamped, not dated, so the range is matched on the date
    // rendered from the timestamp rather than by string comparison.
    let meetings: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM meetings WHERE date(started_at, 'unixepoch') BETWEEN ?1 AND ?2",
            params![from, to],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())? as usize;
    let lines: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM lines WHERE date(at, 'unixepoch') BETWEEN ?1 AND ?2",
            params![from, to],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())? as usize;
    Ok(Removal {
        meetings,
        lines,
        days,
    })
}

/// Delete everything within a date range, inclusive. Dates are `YYYY-MM-DD`.
pub fn delete_range(conn: &Connection, from: &str, to: &str) -> Result<Removal, String> {
    let going = preview_range(conn, from, to)?;
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        for table in ["app_seconds", "hour_seconds", "site_seconds"] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE day BETWEEN ?1 AND ?2"),
                params![from, to],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "DELETE FROM lines WHERE date(at, 'unixepoch') BETWEEN ?1 AND ?2",
            params![from, to],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM meetings WHERE date(started_at, 'unixepoch') BETWEEN ?1 AND ?2",
            params![from, to],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(going)
        }
        Err(e) => {
            // All of it or none of it. A half-deleted range leaves transcripts
            // whose meeting is gone, which is worse than not having tried.
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Forget one meeting and everything said in it.
pub fn delete_meeting(conn: &Connection, id: &str) -> Result<Removal, String> {
    let lines: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM lines WHERE meeting_id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())? as usize;
    // ON DELETE CASCADE takes the lines, and the trigger takes them out of the
    // index. Both are checked by a test, because both are invisible until wrong.
    let gone = conn
        .execute("DELETE FROM meetings WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(Removal {
        meetings: gone,
        lines,
        days: 0,
    })
}

/// Forget every line mentioning a phrase, wherever it was said.
///
/// The blunt instrument, and the one people actually reach for: "delete
/// everything about the acquisition".
pub fn delete_matching(conn: &Connection, phrase: &str) -> Result<Removal, String> {
    let hits = search(conn, phrase, 100_000)?;
    for hit in &hits {
        conn.execute("DELETE FROM lines WHERE id = ?1", params![hit.id])
            .map_err(|e| e.to_string())?;
    }
    Ok(Removal {
        meetings: 0,
        lines: hits.len(),
        days: 0,
    })
}

/// Throw the whole thing away.
pub fn delete_everything(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM lines; DELETE FROM meetings; DELETE FROM app_seconds; \
         DELETE FROM hour_seconds; DELETE FROM site_seconds;",
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- exporting --

/// Write everything to a folder as ordinary files.
///
/// JSON for the structure and plain text for the transcripts, because the point
/// of an export is that it opens in something that is not Loaf. A format only we
/// can read is a backup, not an export.
pub fn export_to(conn: &Connection, dir: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let all = meetings(conn)?;
    let json = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("meetings.json"), json).map_err(|e| e.to_string())?;

    let transcripts = dir.join("transcripts");
    std::fs::create_dir_all(&transcripts).map_err(|e| e.to_string())?;

    let mut written = 1usize;
    for m in &all {
        let mut stmt = conn
            .prepare("SELECT text FROM lines WHERE meeting_id = ?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![m.id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut body = String::new();
        for row in rows {
            body.push_str(&row.map_err(|e| e.to_string())?);
            body.push('\n');
        }
        // The id is ours and is safe, but it lands in a filename, so it is
        // filtered rather than trusted — the same rule save_recap follows.
        let safe: String =
            m.id.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .take(60)
                .collect();
        let name = if safe.is_empty() {
            "meeting".into()
        } else {
            safe
        };
        std::fs::write(transcripts.join(format!("{name}.txt")), body).map_err(|e| e.to_string())?;
        written += 1;
    }

    // Loose notes, the ones that never belonged to a meeting.
    let mut stmt = conn
        .prepare("SELECT text FROM lines WHERE meeting_id IS NULL ORDER BY at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut notes = String::new();
    for row in rows {
        notes.push_str(&row.map_err(|e| e.to_string())?);
        notes.push('\n');
    }
    if !notes.is_empty() {
        std::fs::write(dir.join("notes.txt"), notes).map_err(|e| e.to_string())?;
        written += 1;
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        open_in_memory().expect("open")
    }

    fn with_lines() -> Connection {
        let c = db();
        add_meeting(
            &c,
            &Meeting {
                id: "m1".into(),
                place: "Google Meet".into(),
                started_at: 1_700_000_000,
                seconds: 1800,
            },
        )
        .unwrap();
        add_line(
            &c,
            Some("m1"),
            1_700_000_000,
            "Priya is blocked on the billing migration",
        )
        .unwrap();
        add_line(
            &c,
            Some("m1"),
            1_700_000_060,
            "we agreed to ship pricing on Thursday",
        )
        .unwrap();
        add_line(&c, None, 1_700_000_500, "remember to email the invoice").unwrap();
        c
    }

    #[test]
    fn milliseconds_from_the_frontend_become_seconds() {
        // The frontend stores JavaScript time. These columns are queried with
        // `unixepoch`, which is seconds. Writing one through as the other made
        // every search result say "just now" and made range deletes match
        // nothing at all.
        let ms = 1_789_200_000_000_i64; // a real moment, in milliseconds
        assert_eq!(epoch_seconds(ms), 1_789_200_000);
    }

    #[test]
    fn a_value_already_in_seconds_is_left_alone() {
        // Rows written by older builds really were seconds, and dividing those
        // again would file them in 1970.
        assert_eq!(epoch_seconds(1_789_200_000), 1_789_200_000);
        assert_eq!(epoch_seconds(0), 0);
    }

    #[test]
    fn the_boundary_is_far_from_any_real_date() {
        // 1e11 seconds is the year 5138 and 1e11 milliseconds is 1973, so no
        // plausible timestamp sits near the line where the guess flips.
        assert_eq!(epoch_seconds(99_999_999_999), 99_999_999_999);
        assert_eq!(epoch_seconds(100_000_000_000), 100_000_000);
    }

    #[test]
    fn a_fresh_store_has_the_schema_and_nothing_else() {
        let c = db();
        assert!(search(&c, "anything", 10).unwrap().is_empty());
        assert!(meetings(&c).unwrap().is_empty());
        assert!(!imported(&c));
    }

    #[test]
    fn finds_a_phrase_from_the_middle_of_a_transcript() {
        let c = with_lines();
        let hits = search(&c, "billing migration", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting.as_deref(), Some("m1"));
        assert_eq!(hits[0].place, "Google Meet");
    }

    #[test]
    fn search_says_which_meeting_it_was_said_in() {
        let c = with_lines();
        let hits = search(&c, "pricing", 10).unwrap();
        assert_eq!(hits[0].place, "Google Meet");
    }

    #[test]
    fn finds_a_note_that_belongs_to_no_meeting() {
        let c = with_lines();
        let hits = search(&c, "invoice", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting, None);
        assert_eq!(hits[0].place, "");
    }

    #[test]
    fn newest_first() {
        let c = with_lines();
        let hits = search(&c, "the", 10).unwrap();
        assert!(hits.len() >= 2);
        assert!(hits[0].at >= hits[1].at);
    }

    // FTS5 treats plenty of ordinary punctuation as syntax. Without cleaning,
    // searching for `budget?` is a SYNTAX ERROR rather than zero results, and an
    // error where results should be is worse than no matches.
    #[test]
    fn punctuation_does_not_break_the_search() {
        let c = with_lines();
        for nasty in [
            "billing?",
            "(billing)",
            "billing OR",
            "\"billing",
            "billing*",
            "AND",
            "NEAR(a b)",
            "^billing",
            "-",
            "budget: Q3",
        ] {
            assert!(search(&c, nasty, 10).is_ok(), "blew up on {nasty:?}");
        }
    }

    #[test]
    fn an_empty_search_finds_nothing_rather_than_everything() {
        let c = with_lines();
        assert!(search(&c, "", 10).unwrap().is_empty());
        assert!(search(&c, "   ", 10).unwrap().is_empty());
        assert!(search(&c, "!!!", 10).unwrap().is_empty());
    }

    #[test]
    fn to_query_quotes_every_word() {
        assert_eq!(
            to_query("billing migration").unwrap(),
            "\"billing\" \"migration\""
        );
        assert_eq!(to_query("don't").unwrap(), "\"don't\"");
        assert!(to_query("   ").is_none());
    }

    // The bug this file exists to prevent: the user asked for something to be
    // gone and it still comes back when they search.
    #[test]
    fn deleting_a_meeting_removes_it_from_the_search_index_too() {
        let c = with_lines();
        assert_eq!(search(&c, "billing", 10).unwrap().len(), 1);
        let gone = delete_meeting(&c, "m1").unwrap();
        assert_eq!(gone.meetings, 1);
        assert_eq!(gone.lines, 2);
        assert!(
            search(&c, "billing", 10).unwrap().is_empty(),
            "the row was deleted but the search index still has it"
        );
    }

    #[test]
    fn deleting_a_meeting_leaves_the_loose_notes_alone() {
        let c = with_lines();
        delete_meeting(&c, "m1").unwrap();
        assert_eq!(search(&c, "invoice", 10).unwrap().len(), 1);
    }

    #[test]
    fn deleting_by_phrase_removes_every_line_that_matched() {
        let c = with_lines();
        let gone = delete_matching(&c, "billing").unwrap();
        assert_eq!(gone.lines, 1);
        assert!(search(&c, "billing", 10).unwrap().is_empty());
        // And left the rest.
        assert_eq!(search(&c, "pricing", 10).unwrap().len(), 1);
    }

    #[test]
    fn a_range_says_what_it_would_take_before_it_takes_it() {
        let c = with_lines();
        import_stats(
            &c,
            r#"{"2026-03-01":{"apps":{"Code":100.0},"hours":[],"sites":{}},
                "2026-06-01":{"apps":{"Code":50.0},"hours":[],"sites":{}}}"#,
        )
        .unwrap();
        let preview = preview_range(&c, "2026-01-01", "2026-04-01").unwrap();
        assert_eq!(preview.days, 1);
        // Nothing was removed by asking.
        assert_eq!(day_apps(&c, "2026-03-01").unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_range_takes_the_days_in_it_and_no_others() {
        let c = db();
        import_stats(
            &c,
            r#"{"2026-03-01":{"apps":{"Code":100.0}},
                "2026-06-01":{"apps":{"Code":50.0}}}"#,
        )
        .unwrap();
        delete_range(&c, "2026-01-01", "2026-04-01").unwrap();
        assert!(day_apps(&c, "2026-03-01").unwrap().is_empty());
        assert_eq!(day_apps(&c, "2026-06-01").unwrap().len(), 1);
    }

    #[test]
    fn deleting_everything_leaves_a_usable_store() {
        let c = with_lines();
        delete_everything(&c).unwrap();
        assert!(search(&c, "billing", 10).unwrap().is_empty());
        assert!(meetings(&c).unwrap().is_empty());
        // Still writable afterwards, rather than a store that has been broken.
        add_line(&c, None, 1, "still works").unwrap();
        assert_eq!(search(&c, "still works", 10).unwrap().len(), 1);
    }

    // ------------------------------------------------------------- importing --

    #[test]
    fn imports_a_real_looking_history() {
        let c = db();
        let days = import_stats(
            &c,
            r#"{"2026-09-01":{"apps":{"Code":3600.0,"Chrome":1200.0},
                              "hours":[0,0,0,0,0,0,0,0,0,600.0],
                              "sites":{"Chrome":{"github.com":900.0}}}}"#,
        )
        .unwrap();
        assert_eq!(days, 1);
        let apps = day_apps(&c, "2026-09-01").unwrap();
        assert_eq!(apps.get("Code"), Some(&3600.0));
        assert_eq!(apps.get("Chrome"), Some(&1200.0));
    }

    // Real users' files predate this code by many versions. One malformed day
    // must not make the other two hundred unreadable.
    #[test]
    fn skips_a_day_it_cannot_read_and_keeps_the_rest() {
        let c = db();
        let days = import_stats(
            &c,
            r#"{"2026-09-01":{"apps":{"Code":10.0}},
                "2026-09-02":"this is not a day",
                "2026-09-03":{"apps":{"Code":20.0}}}"#,
        )
        .unwrap();
        assert_eq!(days, 2);
        assert_eq!(day_apps(&c, "2026-09-01").unwrap().len(), 1);
        assert_eq!(day_apps(&c, "2026-09-03").unwrap().len(), 1);
    }

    #[test]
    fn tolerates_missing_keys_entirely() {
        let c = db();
        assert_eq!(import_stats(&c, r#"{"2026-09-01":{}}"#).unwrap(), 1);
        assert_eq!(import_stats(&c, "not json at all").unwrap(), 0);
        assert_eq!(import_stats(&c, "[]").unwrap(), 0);
        assert_eq!(import_stats(&c, "").unwrap(), 0);
    }

    #[test]
    fn imports_meetings_and_their_transcripts() {
        let c = db();
        let n = import_meetings(
            &c,
            r#"[{"id":"a1","where":"Zoom","startedAt":1700000000,"seconds":600,
                 "notes":["we talked about the roadmap","Priya will send it"]}]"#,
        )
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(search(&c, "roadmap", 10).unwrap().len(), 1);
        assert_eq!(meetings(&c).unwrap()[0].place, "Zoom");
    }

    #[test]
    fn accepts_the_object_shape_as_well_as_the_array() {
        let c = db();
        let n = import_meetings(
            &c,
            r#"{"meetings":[{"id":"a1","where":"Teams","startedAt":1,"notes":["hello"]}]}"#,
        )
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(search(&c, "hello", 10).unwrap().len(), 1);
    }

    // Running the import twice is the normal case after a crash, and it must not
    // leave two copies of every transcript.
    #[test]
    fn importing_twice_does_not_double_the_transcripts() {
        let c = db();
        let json = r#"[{"id":"a1","where":"Zoom","startedAt":1,"notes":["once only"]}]"#;
        import_meetings(&c, json).unwrap();
        import_meetings(&c, json).unwrap();
        assert_eq!(search(&c, "once only", 10).unwrap().len(), 1);
    }

    #[test]
    fn a_meeting_with_no_id_is_skipped_rather_than_invented() {
        let c = db();
        let n = import_meetings(&c, r#"[{"where":"Zoom","notes":["orphan"]}]"#).unwrap();
        assert_eq!(n, 0);
        assert!(search(&c, "orphan", 10).unwrap().is_empty());
    }

    #[test]
    fn the_import_runs_once_and_leaves_the_old_files_alone() {
        let dir = std::env::temp_dir().join("loaf-store-import-once");
        let _ = std::fs::remove_dir_all(&dir);
        let inner = dir.join("LoafPlus");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(
            inner.join("stats.json"),
            r#"{"2026-09-01":{"apps":{"Code":10.0}}}"#,
        )
        .unwrap();

        let c = open(&dir).unwrap();
        let (days, _) = import_once(&c, &dir).unwrap();
        assert_eq!(days, 1);
        assert!(imported(&c));

        // Second call does nothing.
        let (again, _) = import_once(&c, &dir).unwrap();
        assert_eq!(again, 0);

        // AND THE OLD FILE IS STILL THERE. A user who goes back to an older
        // build must find their history where they left it.
        assert!(inner.join("stats.json").exists());
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_old_file_is_not_an_error() {
        let dir = std::env::temp_dir().join("loaf-store-import-absent");
        let _ = std::fs::remove_dir_all(&dir);
        let c = open(&dir).unwrap();
        assert_eq!(import_once(&c, &dir).unwrap(), (0, 0));
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------- exporting --

    #[test]
    fn exports_files_that_open_in_something_that_is_not_loaf() {
        let dir = std::env::temp_dir().join("loaf-store-export");
        let _ = std::fs::remove_dir_all(&dir);
        let c = with_lines();
        export_to(&c, &dir).unwrap();

        let json = std::fs::read_to_string(dir.join("meetings.json")).unwrap();
        assert!(json.contains("Google Meet"));

        let txt = std::fs::read_to_string(dir.join("transcripts").join("m1.txt")).unwrap();
        assert!(txt.contains("billing migration"));
        assert!(txt.contains("pricing"));

        let notes = std::fs::read_to_string(dir.join("notes.txt")).unwrap();
        assert!(notes.contains("invoice"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_export_of_nothing_still_produces_a_folder() {
        let dir = std::env::temp_dir().join("loaf-store-export-empty");
        let _ = std::fs::remove_dir_all(&dir);
        let c = db();
        assert_eq!(export_to(&c, &dir).unwrap(), 1);
        assert!(dir.join("meetings.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The id is ours, but it lands in a filename, so it is filtered rather than
    // trusted — the same rule save_recap follows.
    #[test]
    fn an_id_with_separators_in_it_cannot_escape_the_export_folder() {
        let dir = std::env::temp_dir().join("loaf-store-export-escape");
        let _ = std::fs::remove_dir_all(&dir);
        let c = db();
        add_meeting(
            &c,
            &Meeting {
                id: "../../evil".into(),
                place: "Zoom".into(),
                started_at: 1,
                seconds: 1,
            },
        )
        .unwrap();
        export_to(&c, &dir).unwrap();
        assert!(dir.join("transcripts").join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_remember_nothing() {
        let c = db();
        assert!(add_line(&c, None, 1, "   ").is_err());
        assert!(add_line(&c, None, 1, "").is_err());
    }
}
