//! `loaf-mcp` — Loaf answering questions over MCP, on stdin and stdout.
//!
//! A SEPARATE BINARY ON PURPOSE. An assistant spawns this; it does not talk to
//! the running app. That means it works whether Loaf is open or not, it cannot
//! be used to drive the character, and a crash here cannot take the pet down.
//! The cost is that the companion holds up to a minute of unsaved ticks, so
//! "today" can be a minute behind — which the tool descriptions say.
//!
//! IT SPEAKS ONLY ON STDIN AND STDOUT. No socket, no port, no network. The
//! assistant that spawned it is the one with a network connection, and it had
//! that before Loaf was involved.
//!
//! EVERY TOOL IS A QUESTION. Nothing here writes, resets, or deletes. See the
//! note at the top of `mcp.rs` for why that is not merely a missing feature.

use loaf_lib::mcp;
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
            "name": "busiest_hours",
            "description":
                "Which hours of today the user was most at the machine. Useful \
                 for questions about when someone actually works.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
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
        "busiest_hours" => match newest_date(&history) {
            None => "Nothing has been recorded yet.".into(),
            Some(date) => mcp::describe_hours(&history[&date]),
        },
        other => format!("There is no tool called {other}."),
    }
}

fn respond(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn main() {
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
            "initialize" => Some(json!({
                "protocolVersion": PROTOCOL,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "loaf", "version": env!("CARGO_PKG_VERSION") }
            })),
            "tools/list" => Some(json!({ "tools": tools() })),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or(json!({}));
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                Some(json!({
                    "content": [{ "type": "text", "text": call(name, &args) }]
                }))
            }
            "ping" => Some(json!({})),
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
