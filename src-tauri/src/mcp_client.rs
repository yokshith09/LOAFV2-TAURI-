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
    /// The program to run, for a local server. Empty when `url` is set.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The address of a REMOTE server. When this is set, nothing is installed
    /// and no process is started — see `remote.rs` for why that is the only
    /// shape an ordinary person can set up.
    #[serde(default)]
    pub url: String,
    /// A bearer token for a remote server, if it wants one.
    ///
    /// A secret, and handled like the `env` values: it lives in the config Rust
    /// owns and is never sent to a window. The panel is told whether one is set,
    /// never what it is.
    #[serde(default)]
    pub token: String,
    /// A browser sign-in, once one has been done. See `oauth.rs`.
    ///
    /// Separate from `token` rather than replacing it, because the two are
    /// different promises. `token` is a value the user pasted and Loaf must not
    /// touch; this one Loaf obtained itself, can renew without asking, and can
    /// throw away when the user signs out. When both exist the sign-in wins,
    /// since it is the one that can be kept fresh.
    ///
    /// Skipped when absent so a config that never used this stays exactly as it
    /// was. Nobody should find a block of OAuth fields in their file because
    /// they once opened the panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<crate::oauth::Session>,
    /// Extra environment for the child, e.g. an API key the user supplies.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The user's own note about what this is for. Shown in the UI.
    #[serde(default)]
    pub note: String,
}

impl ServerSpec {
    /// The bearer token to send, preferring a sign-in over a pasted one.
    pub fn bearer(&self) -> String {
        match &self.oauth {
            Some(session) if session.signed_in() => session.tokens.access_token.clone(),
            _ => self.token.clone(),
        }
    }
}

/// The whole config file.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Config {
    #[serde(default)]
    pub servers: Vec<ServerSpec>,
    /// Things Loaf checks on its own. Empty unless the user made one — there
    /// is no built-in list and nothing is suggested. See `watch.rs`.
    #[serde(default)]
    pub watches: Vec<crate::watch::Watch>,
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
        // EITHER a program to run OR an address to reach. This used to demand a
        // command, which would have refused every remote server on the way in —
        // the config would have been rejected by the same function that was
        // added to keep it honest.
        let has_command = !server.command.trim().is_empty();
        let has_url = crate::remote::is_remote(&server.url);
        if !has_command && !has_url {
            return Err(format!(
                "Server {} has neither a program to run nor an address.",
                server.name
            ));
        }
        if has_url {
            crate::remote::check_url(&server.url)?;
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

/// The names to try when launching `command`, in order.
///
/// Rust's `Command::new` on Windows appends only `.exe` when searching PATH. npm
/// ships `npx` as `npx.cmd` and `npx.ps1` with no `.exe` anywhere, so `npx` —
/// the command every server in the catalog is launched with — was simply
/// "program not found". Every one-click connection on Windows failed there, and
/// the panel then threw the message away, which is what "I try to connect and
/// nothing happens" was.
///
/// The extensions are tried by SPAWNING, never by handing a line to `cmd /c`:
/// a shell would mean quoting the user's own arguments correctly forever, and
/// the first mistake in that is a command injection. Rust has escaped arguments
/// to batch files itself since 1.77.2, so spawning `npx.cmd` needs no shell of
/// our own.
///
/// A command that already has an extension, or any path with a separator in it,
/// is left exactly as the user wrote it.
fn candidate_programs(command: &str) -> Vec<String> {
    let trimmed = command.trim().to_string();
    if !cfg!(windows) {
        return vec![trimmed];
    }
    let leaf = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&trimmed)
        .to_string();
    if leaf.contains('.') {
        return vec![trimmed];
    }
    vec![
        trimmed.clone(),
        format!("{trimmed}.cmd"),
        format!("{trimmed}.bat"),
        format!("{trimmed}.exe"),
    ]
}

/// Whatever the server managed to say before it gave up, if anything.
///
/// Read on a thread with a deadline rather than straight through, and the reason
/// is specific: killing `npx` does not necessarily kill the `node` it started,
/// and a surviving grandchild keeps its end of this pipe open — so a plain
/// read-to-end can wait forever for a process nobody is waiting for. A second is
/// long enough for a program that has already failed to have finished
/// complaining.
///
/// Trimmed to the last 800 characters: a stack trace's useful line is the last
/// one, and this is going into a panel, not a log file.
fn server_complaint(stderr: Option<std::process::ChildStderr>) -> Option<String> {
    use std::io::Read;
    let mut stderr = stderr?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut said = String::new();
        let _ = stderr.read_to_string(&mut said);
        let _ = tx.send(said);
    });
    let said = rx
        .recv_timeout(std::time::Duration::from_millis(1000))
        .unwrap_or_default();
    let said = said.trim();
    if said.is_empty() {
        return None;
    }
    let tail: String = if said.chars().count() > 800 {
        said.chars().skip(said.chars().count() - 800).collect()
    } else {
        said.to_string()
    };
    Some(tail)
}

/// The most a `PATH` may be before a command processor throws it away.
///
/// Windows' documented ceiling for one environment variable in `cmd.exe`. The
/// important part is what happens at the ceiling, which is worse than it sounds
/// and was measured rather than assumed: cmd does not truncate an oversized
/// PATH, it **discards it**. A child launched through a `.cmd` with a
/// 9,032-character PATH sees `PATH` as the empty string. With 3,112 it sees it
/// whole.
const CMD_PATH_LIMIT: usize = 8_191;

/// How much of the budget to actually use.
///
/// Well under the limit because we are not the last one to touch this variable:
/// npm PREPENDS its own temp shim directory before running a package's binary,
/// and if that push takes the total over the line the whole PATH vanishes at the
/// step that matters most.
const PATH_BUDGET: usize = 6_000;

/// npm PREPENDS its own shim directory before running a package's binary. If
/// that push crossed the line the whole variable would vanish at the one step
/// that matters most, so the GAP is the actual safety property — checked here
/// rather than in a test, because a test cannot stop the build.
const _: () = assert!(PATH_BUDGET + 1000 < CMD_PATH_LIMIT);

/// Build a `PATH` under `budget`, keeping `first` at the front whatever happens.
///
/// Order is preserved for everything else and duplicates are dropped, which on a
/// developer's machine is often the whole saving. `first` jumps the queue
/// because it is the directory holding the program being launched — if anything
/// has to survive the cut, it is the one that makes the command runnable at all.
///
/// Pure and separate so the arithmetic can be tested without a real PATH.
///
/// Deliberately NOT behind `cfg(windows)`, even though only Windows calls it.
/// The development machine for this project is a PC and the macOS half is only
/// ever seen by CI, so gating this would make its tests Windows-only too — and
/// then a change that broke the arithmetic would be found on a runner instead of
/// here. The `allow` is narrowed to "not Windows" so that on the platform which
/// does call it, an unused function is still an error.
#[cfg_attr(not(windows), allow(dead_code))]
fn trimmed_path(entries: &[String], first: Option<&str>, budget: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut used = 0usize;

    let push = |dir: &str, out: &mut Vec<String>, seen: &mut Vec<String>, used: &mut usize| {
        let dir = dir.trim().trim_end_matches(['\\', '/']);
        if dir.is_empty() {
            return;
        }
        // Windows paths are case-insensitive, so `C:\Tools` and `c:\tools` are
        // one directory listed twice and only one of them is worth the room.
        let key = dir.to_lowercase();
        if seen.contains(&key) {
            return;
        }
        let cost = dir.len() + 1;
        if *used + cost > budget {
            return;
        }
        *used += cost;
        seen.push(key);
        out.push(dir.to_string());
    };

    if let Some(dir) = first {
        push(dir, &mut out, &mut seen, &mut used);
    }
    for dir in entries {
        push(dir, &mut out, &mut seen, &mut used);
    }
    out.join(";")
}

/// The directory holding `program`, found the way the loader would.
#[cfg(windows)]
fn program_dir(program: &str) -> Option<std::path::PathBuf> {
    if program.contains(['\\', '/']) {
        return std::path::Path::new(program)
            .parent()
            .map(std::path::Path::to_path_buf);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find(|dir| dir.join(program).is_file())
}

/// A shorter `PATH` for the child, or None to leave the inherited one alone.
///
/// WHY THIS IS NEEDED AT ALL, since it looks like meddling. `cargo run` and
/// `cargo test` hand their children a PATH of roughly 18,000 characters. Every
/// server in the catalog runs through `npx`, which is a `.cmd`, which means
/// cmd.exe, which means the PATH is thrown away — so npx installs the package
/// perfectly and then cannot find the binary it just installed:
///
/// ```text
/// 'notion-mcp-server' is not recognized as an internal or external command
/// ```
///
/// which reads as a broken package and is nothing of the kind. Development
/// builds hit this every time. So do plenty of real machines: 8,191 characters
/// is not a lot on a workstation with many toolchains installed.
///
/// Nothing is changed when the inherited PATH is already fine, so an ordinary
/// installed build behaves exactly as before.
#[cfg(windows)]
fn child_path(program: &str) -> Option<String> {
    let inherited = std::env::var("PATH").ok()?;
    if inherited.len() <= CMD_PATH_LIMIT {
        return None;
    }
    let entries: Vec<String> = inherited.split(';').map(str::to_string).collect();
    let dir = program_dir(program);
    let first = dir.as_deref().map(|d| d.to_string_lossy().into_owned());
    Some(trimmed_path(&entries, first.as_deref(), PATH_BUDGET))
}

/// Where a Mac keeps the tools an MCP server is launched with.
///
/// An app started from Finder or the Dock does NOT inherit the shell PATH. It
/// gets roughly `/usr/bin:/bin:/usr/sbin:/sbin`, and `node` lives in neither —
/// Homebrew puts it in `/opt/homebrew/bin` on Apple silicon and
/// `/usr/local/bin` on Intel, and nvm puts it under the home directory.
///
/// So every catalog server, all of which run through `npx`, fails to start on a
/// Mac that has Node installed perfectly well. It surfaces as Loaf telling the
/// user to go and install Node, which is the most annoying possible wrong
/// answer. The Windows half of this file already learned the same lesson from
/// the other direction — see `CMD_PATH_LIMIT`.
#[cfg(target_os = "macos")]
const MAC_TOOL_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
];

/// Add the usual tool directories to the child's PATH, if they are missing.
///
/// Appended rather than replacing, and only directories that actually exist, so
/// a machine with a sensible PATH is left exactly as it was.
#[cfg(target_os = "macos")]
fn child_path() -> Option<String> {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut entries: Vec<String> = inherited
        .split(':')
        .filter(|e| !e.trim().is_empty())
        .map(str::to_string)
        .collect();
    let mut added = false;
    for dir in MAC_TOOL_DIRS {
        let known = entries.iter().any(|e| e.trim_end_matches('/') == *dir);
        if !known && std::path::Path::new(dir).is_dir() {
            entries.push((*dir).to_string());
            added = true;
        }
    }
    // Also whatever sits beside the user's node, for nvm and friends.
    if !added {
        return None;
    }
    Some(entries.join(":"))
}

/// What to tell the user when nothing would start.
///
/// "Could not start npx: program not found" is true and useless. The reason npx
/// is missing is almost always that Node.js is not installed, and that is the
/// sentence worth showing, because it names something the user can actually go
/// and do.
fn start_failure(command: &str, underlying: &str) -> String {
    let leaf = command
        .trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(command)
        .trim_end_matches(".cmd")
        .trim_end_matches(".exe");
    if matches!(leaf, "npx" | "npm" | "node") {
        return format!(
            "Could not start {command}. This connection needs Node.js, which does not \
             look like it is installed — get it from nodejs.org, then try again."
        );
    }
    format!("Could not start {command}: {underlying}")
}

/// How a connection carries messages.
///
/// Two transports, because MCP defines two and they are not interchangeable
/// from the user's side: a local one has to be installed and a remote one has
/// to be signed into. Everything above this enum — initialise, list the tools,
/// call one — is identical for both, which is why only `request` and `notify`
/// know which is which.
enum Wire {
    /// A program on this machine, talking over its own stdin and stdout.
    Local {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    },
    /// An address, one POST per message.
    Remote {
        agent: ureq::Agent,
        url: String,
        token: String,
        /// Handed back by the server on the first call and required on every
        /// call after it. Without this a server treats each request as a brand
        /// new client and nothing that depends on state works.
        session: Option<String>,
    },
}

/// A live connection to a server, local or remote.
pub struct Connection {
    wire: Wire,
    next_id: i64,
}

impl Connection {
    /// Start a server. Does not happen until something actually calls it.
    pub fn open(spec: &ServerSpec) -> Result<Self, String> {
        // A URL wins over a command. See the note on `is_remote`: a config with
        // both was edited by hand, and choosing the remote one is the guess that
        // cannot start a process on somebody's machine.
        if crate::remote::is_remote(&spec.url) {
            return Self::open_remote(spec);
        }
        Self::open_local(spec)
    }

    /// A remote server: no install, no child process, one address.
    fn open_remote(spec: &ServerSpec) -> Result<Self, String> {
        crate::remote::check_url(&spec.url)?;
        // Timeouts rather than none. A remote call happens on a Tauri worker
        // thread, and a server that accepts the connection and never answers
        // would hold that thread for as long as the app runs.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout_read(std::time::Duration::from_secs(60))
            .build();
        let mut conn = Connection {
            wire: Wire::Remote {
                agent,
                url: spec.url.trim().to_string(),
                // The sign-in when there is one, the pasted token otherwise.
                token: spec.bearer(),
                session: None,
            },
            next_id: 1,
        };
        conn.handshake()?;
        Ok(conn)
    }

    fn open_local(spec: &ServerSpec) -> Result<Self, String> {
        if spec.command.trim().is_empty() {
            return Err("This connection has neither a program to run nor an address.".into());
        }

        let mut child = None;
        let mut last = String::new();
        for program in candidate_programs(&spec.command) {
            let mut command = Command::new(&program);
            command
                .args(&spec.args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                // CAPTURED, not inherited. A server that refuses to start
                // explains itself on stderr — "NOTION_TOKEN is not set" is the
                // whole answer to why a connection failed — and inheriting it
                // sent that explanation to Loaf's own stderr, which in a
                // packaged GUI build goes nowhere at all. The user was left
                // with "The server stopped talking" and no way to find out
                // what it said on the way out. It is read back in
                // `server_complaint` and shown.
                .stderr(Stdio::piped());
            for (key, value) in &spec.env {
                command.env(key, value);
            }
            #[cfg(windows)]
            {
                // No console window for a child of a GUI app.
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
                // A PATH too long for cmd.exe is thrown away rather than cut
                // short, and every catalog server runs through a `.cmd`. See
                // `child_path` — this is a no-op unless the inherited PATH is
                // already over the line.
                if let Some(path) = child_path(&program) {
                    command.env("PATH", path);
                }
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(path) = child_path() {
                    command.env("PATH", path);
                }
            }
            match command.spawn() {
                Ok(c) => {
                    child = Some(c);
                    break;
                }
                Err(e) => last = e.to_string(),
            }
        }
        let mut child = child.ok_or_else(|| start_failure(&spec.command, &last))?;
        let stdin = child.stdin.take().ok_or("no stdin on the server")?;
        let stdout = child.stdout.take().ok_or("no stdout on the server")?;
        let stderr = child.stderr.take();

        let mut conn = Connection {
            wire: Wire::Local {
                child,
                stdin,
                stdout: BufReader::new(stdout),
            },
            next_id: 1,
        };
        if let Err(why) = conn.handshake() {
            // Dropping `conn` kills the child, which closes the write end of
            // the pipe so the read below can reach the end of it.
            drop(conn);
            return Err(match server_complaint(stderr) {
                Some(said) => format!(
                    "{why}

The server said:
{said}"
                ),
                None => why,
            });
        }
        Ok(conn)
    }

    /// Introduce ourselves, and refuse to go on if that fails.
    ///
    /// Shared by both transports: a server that will not initialise is not
    /// usable, and finding that out now is better than on the user's first real
    /// call. Identical for local and remote, which is the point of the split.
    fn handshake(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "loaf", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        self.notify("notifications/initialized", serde_json::json!({}));
        Ok(())
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) {
        let payload = serde_json::json!({
            "jsonrpc": "2.0", "method": method, "params": params
        });
        match &mut self.wire {
            Wire::Local { stdin, .. } => {
                let _ = writeln!(stdin, "{payload}");
                let _ = stdin.flush();
            }
            Wire::Remote { .. } => {
                // A notification has no reply to wait for, and whatever the
                // server answers with is of no interest — but the POST still has
                // to happen, or the server never learns we finished initialising.
                let _ = self.post(&payload.to_string());
            }
        }
    }

    /// One POST to a remote server, returning the body and its content type.
    ///
    /// Captures the session id the first time the server offers one. That is not
    /// optional bookkeeping: without it every subsequent request looks like a new
    /// client, and a server that keeps any state per session behaves as though
    /// nothing was ever initialised.
    fn post(&mut self, body: &str) -> Result<(String, Option<String>), String> {
        let Wire::Remote {
            agent,
            url,
            token,
            session,
        } = &mut self.wire
        else {
            return Err("that connection is not a remote one".into());
        };

        let mut request = agent
            .post(url)
            .set("Content-Type", "application/json")
            .set("Accept", crate::remote::ACCEPT);
        if !token.trim().is_empty() {
            request = request.set("Authorization", &format!("Bearer {}", token.trim()));
        }
        if let Some(id) = session.as_deref() {
            request = request.set(crate::remote::SESSION_HEADER, id);
        }

        match request.send_string(body) {
            Ok(response) => {
                if let Some(id) = response.header(crate::remote::SESSION_HEADER) {
                    if session.is_none() {
                        *session = Some(id.to_string());
                    }
                }
                let kind = response.header("Content-Type").map(str::to_string);
                let text = response
                    .into_string()
                    .map_err(|e| format!("Could not read the answer: {e}"))?;
                Ok((text, kind))
            }
            // A refusal WITH a body is the useful case: the server usually says
            // why, and "401" on its own has sent people looking in the wrong
            // place. See `http_failure`.
            Err(ureq::Error::Status(code, response)) => {
                let text = response.into_string().unwrap_or_default();
                Err(crate::remote::http_failure(code, &text))
            }
            Err(e) => Err(format!("Could not reach that server: {e}")),
        }
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

        if matches!(self.wire, Wire::Remote { .. }) {
            let (body, kind) = self.post(&payload.to_string())?;
            return match crate::remote::reply_with_id(&body, kind.as_deref(), id)? {
                Some(result) => Ok(result),
                // Answered, but not with this. Named differently from a timeout
                // on purpose: one means the server is talking to somebody else's
                // request, the other means it is not talking at all.
                None => Err("That server answered without answering the question.".into()),
            };
        }

        let Wire::Local { stdin, stdout, .. } = &mut self.wire else {
            return Err("that connection has no pipes".into());
        };
        writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;

        // Bounded so a chatty or broken server cannot hang the caller forever.
        for _ in 0..200 {
            let mut line = String::new();
            let read = stdout.read_line(&mut line).map_err(|e| e.to_string())?;
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
        // Only a local server has anything to stop. Loaf started that process,
        // so it should not outlive the app that started it. A remote server is
        // somebody else's and closing the connection is the whole of goodbye.
        if let Wire::Local { child, .. } = &mut self.wire {
            let _ = child.kill();
            let _ = child.wait();
        }
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
    fn accepts_a_remote_server_with_no_command() {
        // The rule this replaced demanded a command, which would have refused
        // every remote connection at the moment of saving it.
        let json = r#"{"servers":[{"name":"gmail","url":"https://example.com/mcp"}]}"#;
        let config = parse_config(json).expect("a remote server is a valid server");
        assert_eq!(config.servers[0].url, "https://example.com/mcp");
        assert!(config.servers[0].command.is_empty());
    }

    #[test]
    fn refuses_a_server_with_neither_a_command_nor_an_address() {
        let json = r#"{"servers":[{"name":"nothing"}]}"#;
        let err = parse_config(json).unwrap_err();
        assert!(err.contains("neither"));
    }

    #[test]
    fn refuses_an_address_that_is_not_one() {
        let json = r#"{"servers":[{"name":"x","url":"ftp://nope"}]}"#;
        // Not a URL we handle, and no command either, so it has neither.
        assert!(parse_config(json).is_err());
    }

    #[test]
    fn a_token_is_read_but_never_part_of_the_view() {
        let json =
            r#"{"servers":[{"name":"g","url":"https://a.example/mcp","token":"secret-xyz"}]}"#;
        let config = parse_config(json).unwrap();
        assert_eq!(config.servers[0].token, "secret-xyz");
        let shown = serde_json::to_string(&crate::connections::redact(&config)).unwrap();
        assert!(
            !shown.contains("secret-xyz"),
            "the token reached the window: {shown}"
        );
        assert!(shown.contains("has_token"));
    }

    #[test]
    fn a_connection_with_nothing_to_connect_to_is_refused_before_anything_runs() {
        let spec = ServerSpec {
            name: "empty".into(),
            command: String::new(),
            args: vec![],
            env: Default::default(),
            note: String::new(),
            url: String::new(),
            token: String::new(),
            oauth: None,
        };
        // `unwrap_err` would need Connection: Debug, and a live connection is
        // not a thing worth making printable for one test.
        match Connection::open(&spec) {
            Ok(_) => panic!("a connection with nothing to connect to was opened"),
            Err(err) => assert!(err.contains("neither"), "{err}"),
        }
    }

    #[test]
    fn a_bad_address_is_refused_before_anything_is_sent() {
        let spec = ServerSpec {
            name: "bad".into(),
            command: String::new(),
            args: vec![],
            env: Default::default(),
            note: String::new(),
            url: "https://a".into(),
            token: String::new(),
            oauth: None,
        };
        assert!(
            Connection::open(&spec).is_err(),
            "a too-short address connected"
        );
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
            url: String::new(),
            token: String::new(),
            oauth: None,
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

    #[test]
    fn looks_for_the_windows_script_shim_as_well_as_the_exe() {
        let tried = candidate_programs("npx");
        assert_eq!(tried[0], "npx", "the plain name is still tried first");
        if cfg!(windows) {
            // The actual bug: npm ships npx.cmd and npx.ps1, never npx.exe, and
            // Rust's Command only appends .exe — so every catalog server failed
            // to start on Windows with "program not found".
            assert!(tried.contains(&"npx.cmd".to_string()));
            assert!(tried.contains(&"npx.bat".to_string()));
        } else {
            assert_eq!(tried.len(), 1, "only Windows needs the shims");
        }
    }

    #[test]
    fn leaves_a_command_the_user_spelled_out_alone() {
        // Already has an extension, or is a real path: taking it apart and
        // guessing would be worse than running exactly what was asked for.
        assert_eq!(candidate_programs("python.exe"), vec!["python.exe"]);
        assert_eq!(
            candidate_programs("C:/tools/my-server.bat"),
            vec!["C:/tools/my-server.bat"]
        );
        assert_eq!(candidate_programs("  node.exe  "), vec!["node.exe"]);
    }

    #[test]
    fn a_path_without_an_extension_still_gets_the_shims_on_windows() {
        let tried = candidate_programs("C:/tools/server");
        assert_eq!(tried[0], "C:/tools/server");
        if cfg!(windows) {
            assert!(tried.contains(&"C:/tools/server.cmd".to_string()));
        }
    }

    #[test]
    fn says_node_is_missing_rather_than_program_not_found() {
        // "Could not start npx: program not found" is true and useless. The
        // reason npx is absent is almost always that Node.js is not installed,
        // and that is the sentence that names something a person can go and do.
        let said = start_failure("npx", "program not found");
        assert!(said.contains("Node.js"), "{said}");
        assert!(said.contains("nodejs.org"), "{said}");
    }

    #[test]
    fn still_quotes_the_real_reason_for_anything_else() {
        let said = start_failure("granola-mcp", "Access is denied. (os error 5)");
        assert!(said.contains("granola-mcp"));
        assert!(said.contains("Access is denied"));
        assert!(!said.contains("Node.js"));
    }

    #[test]
    fn recognises_node_through_a_full_path_and_an_extension() {
        for command in [
            "C:/Program Files/nodejs/npx.cmd",
            "/usr/local/bin/node",
            "npm",
        ] {
            assert!(
                start_failure(command, "whatever").contains("Node.js"),
                "{command}"
            );
        }
    }
    /// A real round trip to a server LOAF DID NOT WRITE, fetched from npm.
    ///
    /// Ignored by default: it needs Node.js and a network on first run, because
    /// `npx` downloads the package. Run it by hand with
    ///
    ///     cargo test -- --ignored --nocapture connects_to_an_external_server
    ///
    /// This is the test that would have caught the Windows bug immediately.
    /// `talks_to_a_real_server` above passes an absolute path to a `.exe`, so it
    /// never exercised PATH lookup at all — and every server a user can actually
    /// pick from the catalog is launched as the bare word `npx`, which Rust could
    /// not find on Windows because npm ships `npx.cmd` and no `npx.exe`.
    #[test]
    #[ignore]
    fn connects_to_an_external_server() {
        let dir = std::env::temp_dir().join("loaf-mcp-live-test");
        std::fs::create_dir_all(&dir).expect("make a folder for it to read");
        std::fs::write(dir.join("hello.txt"), "loaf was here").expect("write a file");

        let spec = ServerSpec {
            name: "files".into(),
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                dir.to_string_lossy().into_owned(),
            ],
            env: BTreeMap::new(),
            note: "a folder on this computer".into(),
            url: String::new(),
            token: String::new(),
            oauth: None,
        };

        // This used to skip itself when PATH was over 8,191 characters,
        // because cmd.exe discards an oversized PATH and npx could then not
        // find the binary it had just installed. `child_path` now hands the
        // child a short one, so the test that had to be skipped under
        // `cargo test` is exactly the test that proves the fix.
        let mut conn = match Connection::open(&spec) {
            Ok(c) => c,
            Err(e) => panic!("could not start the external server: {e}"),
        };
        let tools = conn.tools().expect("tools/list");
        println!("external server offered {} tools: {tools:?}", tools.len());
        assert!(
            tools
                .iter()
                .any(|t| t == "read_text_file" || t == "read_file"),
            "expected a file-reading tool, got {tools:?}"
        );

        let answer = conn
            .call(
                "list_directory",
                serde_json::json!({ "path": dir.to_string_lossy() }),
            )
            .expect("tools/call");
        println!("list_directory said: {answer}");
        assert!(answer.contains("hello.txt"), "got: {answer}");
    }
    /// A real round trip to a REMOTE server over HTTP, run by somebody else.
    ///
    /// Ignored by default: it needs a network and it talks to a third party.
    ///
    ///     cargo test -- --ignored --nocapture connects_to_a_remote_server
    ///
    /// DeepWiki is used because it is a public MCP server that needs no account,
    /// which makes it the only way to exercise this path end to end without
    /// putting somebody's credential in a test. Nothing about this machine is
    /// sent — the one call asks about a public repository by name.
    ///
    /// This covers what the stdio tests cannot: SSE framing, the session header,
    /// and the fact that `remote.rs` has never once been run against a server it
    /// did not also write.
    #[test]
    #[ignore]
    fn connects_to_a_remote_server() {
        let spec = ServerSpec {
            name: "deepwiki".into(),
            command: String::new(),
            args: vec![],
            env: BTreeMap::new(),
            note: "public docs, no account".into(),
            url: "https://mcp.deepwiki.com/mcp".into(),
            token: String::new(),
            oauth: None,
        };

        let mut conn = match Connection::open(&spec) {
            Ok(c) => c,
            Err(e) => panic!("could not reach the remote server: {e}"),
        };
        let tools = conn.tools().expect("tools/list");
        println!("remote server offered {} tools: {tools:?}", tools.len());
        assert!(
            tools.iter().any(|t| t == "read_wiki_structure"),
            "got {tools:?}"
        );

        let answer = conn
            .call(
                "read_wiki_structure",
                serde_json::json!({ "repoName": "tauri-apps/tauri" }),
            )
            .expect("tools/call");
        println!(
            "first 300 chars back: {}",
            answer.chars().take(300).collect::<String>()
        );
        assert!(!answer.trim().is_empty(), "empty answer");
    }
    /// A local server that starts, complains, and dies must say WHY on screen.
    ///
    ///     cargo test -- --ignored --nocapture shows_what_a_failing_server_said
    ///
    /// This is the last layer of "I press connect and nothing happens": the
    /// spawn succeeds, the program refuses to run, and its reason went to a
    /// stderr nobody could see. Uses `node -e` because it is the one interpreter
    /// every catalog entry already depends on.
    #[test]
    #[ignore]
    fn shows_what_a_failing_server_said() {
        let spec = ServerSpec {
            name: "broken".into(),
            command: "node".into(),
            args: vec![
                "-e".into(),
                "console.error('NOTION_TOKEN is not set'); process.exit(1);".into(),
            ],
            env: BTreeMap::new(),
            note: String::new(),
            url: String::new(),
            token: String::new(),
            oauth: None,
        };
        match Connection::open(&spec) {
            Ok(_) => panic!("that should not have connected"),
            Err(why) => {
                println!(
                    "the panel would show:
{why}"
                );
                assert!(
                    why.contains("NOTION_TOKEN is not set"),
                    "the server's own reason was lost: {why}"
                );
                assert!(why.contains("The server said"), "{why}");
            }
        }
    }
    #[test]
    fn keeps_the_program_directory_at_the_front_of_a_trimmed_path() {
        // If anything survives the cut it has to be the directory holding the
        // program, or the command is not runnable at all.
        let entries: Vec<String> = (0..500).map(|i| format!("C:/filler/number/{i}")).collect();
        let out = trimmed_path(&entries, Some("C:/Program Files/nodejs"), 6000);
        assert!(
            out.starts_with("C:/Program Files/nodejs;"),
            "{}",
            &out[..60]
        );
        assert!(out.len() <= 6000, "{} chars", out.len());
    }

    #[test]
    fn drops_directories_listed_twice_however_they_are_spelled() {
        let entries = vec![
            "C:/Tools".to_string(),
            "c:/tools".to_string(),
            "C:/Tools/".to_string(),
            "C:/Other".to_string(),
        ];
        assert_eq!(trimmed_path(&entries, None, 6000), "C:/Tools;C:/Other");
    }

    #[test]
    fn leaves_out_empty_entries() {
        let entries = vec![String::new(), "C:/Real".to_string(), "   ".to_string()];
        // A trailing separator produces an empty entry, and an empty entry in
        // PATH means the current directory — not something to hand a server.
        let out = trimmed_path(&entries, None, 6000);
        assert_eq!(out, "C:/Real");
    }

    #[test]
    fn a_short_path_survives_completely_intact() {
        let entries = vec!["C:/One".to_string(), "C:/Two".to_string()];
        assert_eq!(trimmed_path(&entries, None, 6000), "C:/One;C:/Two");
    }
}
