//! Loaf answering questions over MCP, on stdin and stdout.
//!
//! SPAWNED BY AN ASSISTANT, not by the app. Claude Desktop (or anything else
//! that speaks MCP) starts this and talks to it over pipes. It works whether
//! the companion is open or not, it cannot be used to drive the character, and
//! a crash here cannot take the pet down.
//!
//! IT SPEAKS ONLY ON STDIN AND STDOUT. No socket, no port, no network. The
//! assistant that spawned it is the one with a network connection, and it had
//! that before Loaf was involved. The one thing it writes is a small activity
//! file — see `note_activity` — which is how the companion knows to look busy
//! while Claude is using it, and which is a file precisely so that this stays
//! true.
//!
//! EVERY TOOL ABOUT YOUR DATA IS A QUESTION. Nothing here writes, resets, or
//! deletes `stats.json` or `meetings.json`. See the note at the top of
//! `mcp.rs` for why that is not merely a missing feature — it is what stops
//! an assistant confused by something it read from being able to touch the
//! one file Loaf exists to protect.
//!
//! `report_status` IS THE ONE EXCEPTION, AND DELIBERATELY A NARROW ONE. It
//! never touches that file or any other user data — it writes a status word
//! from a small fixed list to its own file, purely so the character on
//! screen can react. There is no freeform message: the caller picks a KIND
//! (`build_failed`, `pushed`, ...), never the words Loaf says about it, so
//! there is nothing here for an assistant to be tricked into saying on
//! Loaf's behalf.
//!
//! THIS LIVES IN THE LIBRARY so that two entry points can share one
//! implementation: the `loaf-mcp` binary, and the main application launched
//! with `--mcp-server`. The second is what an installed copy actually uses,
//! because the separate binary is not part of the installer — see
//! `claude_desktop.rs`.

use crate::mcp;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// The MCP revision this speaks. Sent back verbatim in `initialize`.
const PROTOCOL: &str = "2024-11-05";

fn data_dir() -> Option<std::path::PathBuf> {
    // The same place the app writes, spelled out rather than derived — see the
    // compatibility note in storage.rs.
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .map(|h| h.join("Library").join("Application Support"))
    }
}

fn read_history() -> mcp::History {
    let Some(dir) = data_dir() else {
        return mcp::History::new();
    };
    let path = dir.join("LoafPlus").join("stats.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => mcp::parse(&text),
        // No file is a real answer: nothing has been recorded yet.
        Err(_) => mcp::History::new(),
    }
}

fn tools() -> Value {
    let sites_note = if mcp::sites_allowed() {
        " Site data IS included, because LOAF_MCP_SITES=1 was set."
    } else {
        " Site data is excluded. Set LOAF_MCP_SITES=1 to include it."
    };
    json!([
        {
            "name": "screen_time_today",
            "description": format!(
                "How long the user has been at their computer today and which \
                 applications took the time. Read from Loaf's local history, \
                 which can be up to a minute behind.{sites_note}"
            ),
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "screen_time_recent",
            "description": format!(
                "The last few days of screen time, one summary per day.{sites_note}"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "days": {
                        "type": "integer",
                        "description": "How many days back, 1 to 30. Defaults to 7.",
                        "minimum": 1,
                        "maximum": 30
                    }
                }
            }
        },
        {
            "name": "recent_meetings",
            "description":
                "Calls the user has been in recently: where, how long, and any \
                 notes they typed. Loaf notices meetings from which application \
                 is in the foreground. IT DOES NOT RECORD OR TRANSCRIBE THEM \
                 and holds nothing anyone else said.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "How many, 1 to 50. Defaults to 10.",
                        "minimum": 1,
                        "maximum": 50
                    }
                }
            }
        },
        {
            "name": "busiest_hours",
            "description":
                "Which hours of today the user was most at the machine. Useful \
                 for questions about when someone actually works.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "report_status",
            "description":
                "Tell Loaf what you are doing right now, so the character on \
                 screen reacts and shows a bubble: thinking, working, a build \
                 passing or failing, checks passing or failing, a push, or a \
                 deploy succeeding or failing. Call this as an assistant working \
                 in a coding session (Claude Code or similar) does these things, \
                 not for ordinary conversation. `status` MUST be one of: \
                 thinking, working, build_passed, build_failed, checks_passed, \
                 checks_failed, pushed, deploy_succeeded, deploy_failed, done. \
                 Loaf chooses what to say — this only picks which reaction.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": [
                            "thinking", "working", "build_passed", "build_failed",
                            "checks_passed", "checks_failed", "pushed",
                            "deploy_succeeded", "deploy_failed", "done"
                        ]
                    }
                },
                "required": ["status"]
            }
        }
    ])
}

fn read_meetings() -> Vec<mcp::Meeting> {
    let Some(dir) = data_dir() else {
        return Vec::new();
    };
    match std::fs::read_to_string(dir.join("LoafPlus").join("meetings.json")) {
        Ok(text) => mcp::parse_meetings(&text),
        Err(_) => Vec::new(),
    }
}

fn newest_date(history: &mcp::History) -> Option<String> {
    history.keys().max().cloned()
}

fn call(name: &str, args: &Value) -> String {
    let history = read_history();
    let with_sites = mcp::sites_allowed();

    match name {
        "screen_time_today" => match newest_date(&history) {
            None => "Nothing has been recorded yet.".into(),
            Some(date) => mcp::describe_day(&date, &history[&date], with_sites),
        },
        "screen_time_recent" => {
            let days = args
                .get("days")
                .and_then(Value::as_u64)
                .unwrap_or(7)
                .clamp(1, 30) as usize;
            let dates = mcp::recent_dates(&history, days);
            if dates.is_empty() {
                return "Nothing has been recorded yet.".into();
            }
            dates
                .iter()
                .map(|d| mcp::describe_day(d, &history[d], with_sites))
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        "recent_meetings" => {
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, 50) as usize;
            mcp::describe_meetings(&read_meetings(), limit)
        }
        "busiest_hours" => match newest_date(&history) {
            None => "Nothing has been recorded yet.".into(),
            Some(date) => mcp::describe_hours(&history[&date]),
        },
        "report_status" => {
            let status = args.get("status").and_then(Value::as_str).unwrap_or("");
            if !STATUS_KINDS.contains(&status) {
                return format!(
                    "\"{status}\" is not a status Loaf understands. Use one of: {}.",
                    STATUS_KINDS.join(", ")
                );
            }
            note_status(status);
            "Noted.".into()
        }
        other => format!("There is no tool called {other}."),
    }
}

fn respond(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// The file this writes so the companion can tell Claude is using it.
///
/// A FILE, not a socket, and that is the whole point. This process is spawned
/// by an assistant and has no connection to the running app; the module header
/// promises no socket and no port, and a pet that looks busy is not worth
/// breaking that for. The companion polls this; see `claude_watch` in lib.rs.
///
/// Writing it is best-effort in the strongest sense: every failure is ignored.
/// Loaf answering Claude's question matters, and a decoration that could stop
/// it from answering would be a bad trade.
pub fn activity_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("LoafPlus").join("claude-activity.json")
}

/// Milliseconds since the epoch, or 0 if the clock is unreadable.
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Leave a note that Claude just asked something.
///
/// `tool` is empty for the protocol chatter — initialize, ping, tools/list —
/// which is how the companion tells "Claude is connected" from "Claude is
/// actually asking about your day". Only the second deserves a bubble.
fn note_activity(tool: &str) {
    let Some(dir) = data_dir() else { return };
    let path = activity_path(&dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let record = json!({ "tool": tool, "at": now_ms() as u64 });
    let _ = std::fs::write(&path, record.to_string());
}

/// A dev-workflow moment worth a reaction. Fixed set, on purpose — see
/// `report_status` below for why this is not a freeform message.
const STATUS_KINDS: &[&str] = &[
    "thinking",
    "working",
    "build_passed",
    "build_failed",
    "checks_passed",
    "checks_failed",
    "pushed",
    "deploy_succeeded",
    "deploy_failed",
    "done",
];

/// The file this writes so the companion can react to Claude Code's own work
/// — a build, a push, a deploy — separate from `activity_path`, which is
/// about a QUESTION being asked. Same reasoning as that file: a file, not a
/// socket, because this process has no connection to the running app.
pub fn status_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("LoafPlus").join("claude-status.json")
}

fn note_status(status: &str) {
    let Some(dir) = data_dir() else { return };
    let path = status_path(&dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let record = json!({ "status": status, "at": now_ms() as u64 });
    let _ = std::fs::write(&path, record.to_string());
}

/// Serve MCP on stdin and stdout until the other end closes.
///
/// Blocks. The caller has nothing to do afterwards but exit.
pub fn serve() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        // A request without an id is a notification: act on it, answer nothing.
        let id = request.get("id").cloned();

        let result = match method {
            "initialize" => {
                // Marks the session as live so the companion can say Claude is
                // connected without waiting for somebody to ask something.
                note_activity("");
                Some(json!({
                "protocolVersion": PROTOCOL,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "loaf", "version": env!("CARGO_PKG_VERSION") }
                }))
            }
            "tools/list" => Some(json!({ "tools": tools() })),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or(json!({}));
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                // Before answering, not after: the companion should look busy
                // while the work happens, and the answer is what takes the time.
                note_activity(name);
                Some(json!({
                    "content": [{ "type": "text", "text": call(name, &args) }]
                }))
            }
            "ping" => {
                note_activity("");
                Some(json!({}))
            }
            _ => None,
        };

        let Some(id) = id else { continue };
        let payload = match result {
            Some(result) => respond(id, result),
            None => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("no method {method}") }
            }),
        };
        if writeln!(stdout, "{payload}").is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_status_is_offered_with_the_fixed_enum() {
        let tools = tools();
        let report = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "report_status")
            .expect("report_status should be in the tool list");
        let enum_values = report["inputSchema"]["properties"]["status"]["enum"]
            .as_array()
            .expect("status must be an enum, not freeform text");
        let listed: Vec<&str> = enum_values.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(listed, STATUS_KINDS);
        // "required" matters as much as the enum: a caller that can omit
        // status entirely gets the same effect as a freeform field.
        assert_eq!(report["inputSchema"]["required"], json!(["status"]));
    }

    #[test]
    fn every_status_kind_is_actually_a_word_a_caller_could_pick() {
        // Guards against a typo silently shrinking the enum to nothing useful.
        assert!(STATUS_KINDS.len() >= 9);
        for kind in STATUS_KINDS {
            assert!(!kind.is_empty());
            assert!(kind.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }

    #[test]
    fn refuses_a_status_outside_the_fixed_list_rather_than_recording_it() {
        // No filesystem write should even be attempted for a bad value — this
        // path returns before `note_status` is ever called.
        let result = call("report_status", &json!({ "status": "vibing" }));
        assert!(result.contains("not a status Loaf understands"), "{result}");
        for kind in STATUS_KINDS {
            assert!(result.contains(kind), "{result} should mention {kind}");
        }
    }

    #[test]
    fn refuses_a_missing_status_the_same_way_as_a_wrong_one() {
        let result = call("report_status", &json!({}));
        assert!(result.contains("not a status Loaf understands"), "{result}");
    }
}
