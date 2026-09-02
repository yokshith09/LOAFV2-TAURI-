//! Loaf calling out to other MCP servers.
//!
//! THIS IS THE DIRECTION THAT CHANGES THE PRODUCT, so read this before adding
//! anything to it. `mcp.rs` makes Loaf a **server**: an assistant asks, Loaf
//! answers, nothing leaves. This file makes Loaf a **client**: Loaf starts
//! another program and sends it data. Slack, Gmail, Granola and Wispr Flow are
//! all servers, so talking to any of them means being a client, and that is
//! the only way to reach them.
//!
//! WHAT LOAF CANNOT PROMISE ONCE THIS IS USED, stated plainly rather than
//! buried: a connected server is a program on your machine that Loaf starts and
//! talks to. **It can do anything that program can do**, including making
//! network calls Loaf cannot see, to services Loaf has never heard of. Loaf
//! does not sandbox it and cannot. "Loaf makes no network calls" stays true of
//! Loaf itself and stops being a useful thing to say about the whole system.
//!
//! SO THE RULES HERE ARE ABOUT CONSENT AND VISIBILITY, not containment:
//!
//!  1. NOTHING IS CONNECTED BY DEFAULT. There is no built-in server list, no
//!     discovery, and no "recommended integrations". A server exists because
//!     the user wrote it into the config file.
//!  2. NOTHING IS STARTED UNTIL IT IS USED. Adding a server does not launch it.
//!  3. EVERY CALL IS RECORDED. What was sent, to which server, and when — kept
//!     locally so the user can look. A feature that moves data off the machine
//!     has to be auditable by the person whose data it is.
//!  4. NO SERVER IS ASKED FOR ANYTHING LOAF WAS NOT TOLD TO ASK FOR. This file
//!     forwards named calls. It does not decide on its own to send your day to
//!     anybody.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// One server the user has chosen to connect.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServerSpec {
    /// What the user calls it. Used to address it from the app.
    pub name: String,
    /// The program to run.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment for the child, e.g. an API key the user supplies.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The user's own note about what this is for. Shown in the UI.
    #[serde(default)]
    pub note: String,
}

/// The whole config file.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Config {
    #[serde(default)]
    pub servers: Vec<ServerSpec>,
}

/// Parse a config, refusing anything that is not clearly a server list.
///
/// A malformed config connects NOTHING rather than connecting what it could
/// make sense of. Half-understanding a file that decides which programs get
/// started is not a place to be forgiving.
pub fn parse_config(json: &str) -> Result<Config, String> {
    if json.trim().is_empty() {
        return Ok(Config::default());
    }
    let config: Config = serde_json::from_str(json).map_err(|e| e.to_string())?;
    for server in &config.servers {
        if server.name.trim().is_empty() {
            return Err("A server has no name.".into());
        }
        if server.command.trim().is_empty() {
            return Err(format!("Server {} has no command to run.", server.name));
        }
    }
    let mut names: Vec<&str> = config.servers.iter().map(|s| s.name.as_str()).collect();
    names.sort_unstable();
    let before = names.len();
    names.dedup();
    if names.len() != before {
        return Err("Two servers share a name.".into());
    }
    Ok(config)
}

/// One thing Loaf sent to a server, for the user to look at later.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CallRecord {
    pub server: String,
    pub tool: String,
    /// The arguments, as sent. This is the part that left the machine.
    pub arguments: String,
    /// Seconds since the epoch.
    pub at: u64,
    pub ok: bool,
}

/// A running server and the pipes to it.
pub struct Connection {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl Connection {
    /// Start a server. Does not happen until something actually calls it.
    pub fn open(spec: &ServerSpec) -> Result<Self, String> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The child's stderr goes to Loaf's, rather than being captured and
            // silently discarded: a server that cannot start says why.
            .stderr(Stdio::inherit());
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            // No console window for a child of a GUI app.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", spec.command))?;
        let stdin = child.stdin.take().ok_or("no stdin on the server")?;
        let stdout = child.stdout.take().ok_or("no stdout on the server")?;

        let mut conn = Connection {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        // Handshake first. A server that will not initialise is not usable, and
        // finding that out now is better than on the user's first real call.
        conn.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "loaf", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        conn.notify("notifications/initialized", serde_json::json!({}));
        Ok(conn)
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) {
        let payload = serde_json::json!({
            "jsonrpc": "2.0", "method": method, "params": params
        });
        let _ = writeln!(self.stdin, "{payload}");
        let _ = self.stdin.flush();
    }

    /// Send one request and read until its answer comes back.
    ///
    /// Answers that are not ours are skipped rather than treated as the reply:
    /// a server may emit notifications and log lines between the request and
    /// the response, and taking the first line back would read a log message as
    /// an answer.
    pub fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        });
        writeln!(self.stdin, "{payload}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        // Bounded so a chatty or broken server cannot hang the caller forever.
        for _ in 0..200 {
            let mut line = String::new();
            let read = self
                .stdout
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            if read == 0 {
                return Err("The server stopped talking.".into());
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(serde_json::Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("the server refused");
                return Err(message.to_string());
            }
            return Ok(value.get("result").cloned().unwrap_or_default());
        }
        Err("The server did not answer.".into())
    }

    pub fn tools(&mut self) -> Result<Vec<String>, String> {
        let result = self.request("tools/list", serde_json::json!({}))?;
        Ok(result
            .get("tools")
            .and_then(serde_json::Value::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|t| t.get("name").and_then(serde_json::Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn call(&mut self, tool: &str, arguments: serde_json::Value) -> Result<String, String> {
        let result = self.request(
            "tools/call",
            serde_json::json!({ "name": tool, "arguments": arguments }),
        )?;
        Ok(text_of(&result))
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Asked to stop rather than left running: a server Loaf started should
        // not outlive the app that started it.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Pull the readable text out of an MCP tool result.
pub fn text_of(result: &serde_json::Value) -> String {
    let Some(content) = result.get("content").and_then(serde_json::Value::as_array) else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|c| c.get("text").and_then(serde_json::Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Where the config and the call log live.
pub fn config_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("LoafPlus").join("mcp.json")
}

pub fn log_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("LoafPlus").join("mcp-calls.json")
}

/// Append to the local record of what was sent where.
///
/// Best effort: a failure to write the log must not stop the call, but it also
/// must not pass silently, so it returns the error for the caller to surface.
pub fn record(data_dir: &std::path::Path, entry: &CallRecord) -> Result<(), String> {
    let path = log_path(data_dir);
    let mut entries: Vec<CallRecord> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    entries.push(entry.clone());
    // Kept to a length a person could actually read through.
    let len = entries.len();
    if len > 500 {
        entries.drain(..len - 500);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_config_connects_nothing() {
        assert!(parse_config("").unwrap().servers.is_empty());
        assert!(parse_config("{}").unwrap().servers.is_empty());
    }

    #[test]
    fn reads_a_server() {
        let config = parse_config(
            r#"{"servers":[{"name":"granola","command":"npx","args":["-y","granola-mcp"],
                "note":"meeting notes"}]}"#,
        )
        .unwrap();
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers[0].name, "granola");
        assert_eq!(config.servers[0].args, vec!["-y", "granola-mcp"]);
    }

    // Half-understanding a file that decides which programs get started is not
    // a place to be forgiving.
    #[test]
    fn refuses_a_config_it_only_half_understands() {
        assert!(parse_config("not json").is_err());
        assert!(parse_config(r#"{"servers":[{"name":"","command":"x"}]}"#).is_err());
        assert!(parse_config(r#"{"servers":[{"name":"a","command":"  "}]}"#).is_err());
        assert!(parse_config(r#"{"servers":[{"name":"a"}]}"#).is_err());
    }

    #[test]
    fn refuses_two_servers_with_one_name() {
        let json = r#"{"servers":[{"name":"a","command":"x"},{"name":"a","command":"y"}]}"#;
        assert!(parse_config(json).is_err());
    }

    #[test]
    fn reads_the_text_out_of_a_result() {
        let result = serde_json::json!({
            "content": [{ "type": "text", "text": "one" }, { "type": "text", "text": "two" }]
        });
        assert_eq!(text_of(&result), "one\ntwo");
        assert_eq!(text_of(&serde_json::json!({})), "");
        assert_eq!(text_of(&serde_json::json!({ "content": [] })), "");
    }

    #[test]
    fn ignores_content_that_is_not_text() {
        let result = serde_json::json!({
            "content": [{ "type": "image", "data": "..." }, { "type": "text", "text": "hi" }]
        });
        assert_eq!(text_of(&result), "hi");
    }

    /// A real round trip: the client starts Loaf's OWN server and talks to it.
    ///
    /// Ignored by default because it spawns a process and needs that binary
    /// built. Run it by hand after `cargo build --bin loaf-mcp`:
    ///
    ///     cargo test -- --ignored --nocapture talks_to_a_real_server
    ///
    /// This exists because every part of this file can look correct and still
    /// not speak the protocol, and the only way to know is to speak it.
    #[test]
    #[ignore]
    fn talks_to_a_real_server() {
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join(if cfg!(windows) {
                "loaf-mcp.exe"
            } else {
                "loaf-mcp"
            });
        assert!(
            exe.exists(),
            "build the server first: cargo build --bin loaf-mcp"
        );

        let spec = ServerSpec {
            name: "loaf".into(),
            command: exe.to_string_lossy().into_owned(),
            args: vec![],
            env: BTreeMap::new(),
            note: "Loaf's own server".into(),
        };
        let mut conn = Connection::open(&spec).expect("handshake");
        let tools = conn.tools().expect("tools/list");
        println!("tools: {tools:?}");
        assert!(tools.contains(&"screen_time_today".to_string()));

        let answer = conn
            .call("screen_time_today", serde_json::json!({}))
            .expect("tools/call");
        println!("answer: {answer}");
        assert!(!answer.is_empty());
    }

    #[test]
    fn keeps_the_config_and_log_beside_the_history() {
        let dir = std::path::Path::new("C:/data");
        assert!(config_path(dir).ends_with("LoafPlus/mcp.json"));
        assert!(log_path(dir).ends_with("LoafPlus/mcp-calls.json"));
    }
}
