//! Connecting Loaf to Claude Desktop, and noticing when Claude uses it.
//!
//! THE DIRECTION IS THE OPPOSITE OF `mcp_client.rs`, and confusing the two is
//! the easiest mistake here. Everything in the Connections tab is Loaf being a
//! CLIENT: Loaf starts someone else's server and asks it things. This file is
//! Loaf being a SERVER: Claude Desktop starts Loaf and asks IT things. People
//! ask to "connect Loaf to Claude" meaning this, and there is no client-side
//! Claude to connect to, because Claude is not an MCP server.
//!
//! WHAT CONNECTING ACTUALLY MEANS. Claude Desktop reads one JSON file and
//! spawns whatever programs it names. So connecting is: put an entry in that
//! file. Disconnecting is: take it out. There is no account, no token and no
//! network. The whole feature is a careful edit of a file belonging to another
//! application.
//!
//! CAREFUL IS DOING A LOT OF WORK IN THAT SENTENCE. That file is not ours. It
//! may already list servers the user depends on, and rewriting it from a
//! template would silently delete them. So every edit here reads the existing
//! file, changes exactly one key inside `mcpServers`, writes everything else
//! back as parsed, and takes a backup first.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The key Loaf uses inside `mcpServers`.
///
/// Stable, because it is also how "are we already connected" is answered and
/// how disconnecting finds what to remove.
pub const ENTRY: &str = "loaf";

/// Where Claude Desktop keeps its configuration.
///
/// Spelled out per platform rather than derived, the same way `storage.rs`
/// spells out the Loaf directory: these paths belong to another application,
/// and a clever derivation that drifts would edit the wrong file.
pub fn config_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|d| d.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(PathBuf::from).map(|h| {
            h.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json")
        })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

/// Whether Claude Desktop appears to be installed at all.
///
/// The FOLDER, not the config file. Claude makes its folder on first run but
/// writes the config only once a server is added, so requiring the file would
/// report a fresh install as missing.
pub fn installed() -> bool {
    config_path()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .map(|d| d.is_dir())
        .unwrap_or(false)
}

/// Where the copy of Loaf that Claude starts actually lives.
///
/// Beside the history rather than wherever this build happens to sit — see
/// `keep_a_copy` for why a copy exists at all.
pub fn server_binary(data_dir: &Path) -> PathBuf {
    data_dir.join("LoafPlus").join(if cfg!(windows) {
        "loaf-mcp.exe"
    } else {
        "loaf-mcp"
    })
}

/// Put a copy of the running program somewhere nothing else will disturb it.
///
/// WHY A COPY, when `current_exe` is right there. Claude Desktop starts this
/// program and keeps that process alive for the whole conversation, so the file
/// it was started from has to survive being run for hours. Pointing at the
/// executable in place fails exactly one way, and it is not obvious until you
/// read Claude's log:
///
/// ```text
/// 13:41:42 Server started and connected successfully
/// 13:41:43 initialize -> result      tools/list -> result
/// 13:56:02 Server transport closed unexpectedly
/// ```
///
/// Fourteen good minutes and then death — at the exact second a rebuild
/// replaced the binary underneath it. Every `cargo build` during development
/// killed Claude's server, which shows up as "Server disconnected" and looks
/// like Loaf being broken when Loaf had answered every message correctly.
///
/// The same hazard exists outside development: an application that updates
/// itself replaces its own executable, and `cargo clean` removes it entirely.
/// A copy in Loaf's own data folder is touched by nothing but this function.
///
/// Refreshed when the original is newer, so an updated Loaf does not leave an
/// old server answering for it.
pub fn keep_a_copy(data_dir: &Path) -> Result<PathBuf, String> {
    let source = std::env::current_exe().map_err(|e| format!("Could not find Loaf itself: {e}"))?;
    let target = server_binary(data_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if !newer(&source, &target) {
        return Ok(target);
    }

    match std::fs::copy(&source, &target) {
        Ok(_) => Ok(target),
        // Windows will not let a running executable be overwritten, and while
        // Claude is attached that is exactly what this is. Renaming one out of
        // the way IS allowed, so the running server keeps its file and the new
        // copy takes the name. The leftover is cleared on the next update.
        Err(_) if target.exists() => {
            let parked = target.with_extension("old");
            let _ = std::fs::remove_file(&parked);
            std::fs::rename(&target, &parked)
                .map_err(|e| format!("Could not replace the copy Claude uses: {e}"))?;
            std::fs::copy(&source, &target)
                .map(|_| ())
                .map_err(|e| format!("Could not put a copy where Claude can reach it: {e}"))?;
            Ok(target)
        }
        Err(e) => Err(format!(
            "Could not put a copy where Claude can reach it: {e}"
        )),
    }
}

/// Whether `source` is newer than `target`, treating a missing target as stale.
fn newer(source: &Path, target: &Path) -> bool {
    let Ok(target_time) = std::fs::metadata(target).and_then(|m| m.modified()) else {
        return true;
    };
    let Ok(source_time) = std::fs::metadata(source).and_then(|m| m.modified()) else {
        return false;
    };
    source_time > target_time
}

/// The command Claude should run to reach Loaf.
///
/// Points at the copy, never at `loaf-mcp`. That binary exists in the source
/// tree and is not part of the installer, so on a real machine it is simply
/// absent and the connection would fail at every launch with nothing to see.
pub fn server_command(data_dir: &Path) -> Result<(String, Vec<String>), String> {
    let exe = keep_a_copy(data_dir)?;
    Ok((
        exe.to_string_lossy().into_owned(),
        vec!["--mcp-server".to_string()],
    ))
}

/// Put Loaf into a parsed config, leaving everything else exactly as it was.
///
/// Pure, so the part that must not damage a file belonging to somebody else can
/// be tested without one. A config that is missing, empty or not an object
/// becomes a fresh object rather than an error: Claude writes no file until the
/// first server is added, so "no file" is the normal state of a working install.
pub fn with_loaf(existing: Option<&Value>, command: &str, args: &[String]) -> Value {
    let mut root = match existing {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    };
    let servers = root
        .as_object_mut()
        .expect("just built as an object")
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    // A hand-edited file can hold anything at all here. Writing into a string
    // would panic, so replacing it is the recoverable choice.
    if !servers.is_object() {
        *servers = json!({});
    }
    servers
        .as_object_mut()
        .expect("just forced to an object")
        .insert(
            ENTRY.to_string(),
            json!({ "command": command, "args": args }),
        );
    root
}

/// Take Loaf out again, leaving every other server alone.
pub fn without_loaf(existing: Option<&Value>) -> Value {
    let mut root = match existing {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    };
    if let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
        servers.remove(ENTRY);
    }
    root
}

/// Whether this config already points at Loaf.
pub fn has_loaf(existing: Option<&Value>) -> bool {
    existing
        .and_then(|v| v.get("mcpServers"))
        .and_then(|v| v.get(ENTRY))
        .is_some()
}

/// Every other server named in the config, so the panel can show what is there.
///
/// Shown because this feature edits a shared file, and a person is entitled to
/// see what Loaf is about to be added alongside.
pub fn other_servers(existing: Option<&Value>) -> Vec<String> {
    existing
        .and_then(|v| v.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|m| {
            m.keys()
                .filter(|k| k.as_str() != ENTRY)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// Read the config, or None when there is not one yet.
///
/// A file that will not parse is an ERROR rather than None, and the difference
/// matters: treating unreadable as absent would mean the next write replaced a
/// file we could not understand, which is how somebody loses their other
/// servers to a stray comma.
pub fn read(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| {
            format!(
                "The Claude configuration file could not be read ({e}). Loaf has not touched it. Fix or remove {} and try again.",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the config, keeping a copy of what was there before.
///
/// The backup is not ceremony. This edits a file Loaf does not own and cannot
/// re-create, and a one-line recovery instruction only exists if the copy does.
pub fn write(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let backup = path.with_extension("json.loaf-backup");
        std::fs::copy(path, &backup).map_err(|e| format!("Could not back it up first: {e}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// What Claude last did, read from the file the server process writes.
///
/// See `mcp_stdio::note_activity`. The tool name is empty for protocol chatter,
/// which is how "Claude is connected" is told apart from "Claude is asking
/// about your day right now".
pub fn last_activity(data_dir: &Path) -> Option<(String, u64)> {
    let text = std::fs::read_to_string(crate::mcp_stdio::activity_path(data_dir)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let tool = value.get("tool").and_then(Value::as_str).unwrap_or("");
    let at = value.get("at").and_then(Value::as_u64)?;
    Some((tool.to_string(), at))
}

/// How long after the last word from Claude to keep saying it is connected.
///
/// Claude Desktop keeps the server process alive for a whole conversation and
/// pings it, so silence for this long means the session is over. Generous,
/// because claiming a connection has dropped while it has not is worse than
/// being slow to notice.
pub const CONNECTED_FOR_MS: u64 = 120_000;

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(text: &str) -> Value {
        serde_json::from_str(text).expect("test fixture")
    }

    #[test]
    fn adds_loaf_to_an_empty_config() {
        let out = with_loaf(None, "C:/Loaf.exe", &["--mcp-server".into()]);
        assert_eq!(out["mcpServers"]["loaf"]["command"], "C:/Loaf.exe");
        assert_eq!(out["mcpServers"]["loaf"]["args"][0], "--mcp-server");
    }

    #[test]
    fn never_touches_the_other_servers() {
        // THE ONE THAT MATTERS. This edits a file Loaf does not own, and a
        // write from a template would quietly delete the other connections.
        let before = cfg(
            r#"{"mcpServers":{"filesystem":{"command":"npx","args":["-y","x"]}},
                "globalShortcut":"Ctrl+Q"}"#,
        );
        let after = with_loaf(Some(&before), "C:/Loaf.exe", &[]);
        assert_eq!(after["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(after["mcpServers"]["filesystem"]["args"][1], "x");
        assert_eq!(after["globalShortcut"], "Ctrl+Q");
        assert!(has_loaf(Some(&after)));
    }

    #[test]
    fn removing_loaf_leaves_the_rest_behind() {
        let before = cfg(
            r#"{"mcpServers":{"loaf":{"command":"old"},"other":{"command":"keep"}},
                "theme":"dark"}"#,
        );
        let after = without_loaf(Some(&before));
        assert!(!has_loaf(Some(&after)));
        assert_eq!(after["mcpServers"]["other"]["command"], "keep");
        assert_eq!(after["theme"], "dark");
    }

    #[test]
    fn connecting_twice_replaces_rather_than_duplicates() {
        let first = with_loaf(None, "C:/Old.exe", &[]);
        let second = with_loaf(Some(&first), "C:/New.exe", &["--mcp-server".into()]);
        assert_eq!(second["mcpServers"]["loaf"]["command"], "C:/New.exe");
        assert_eq!(
            second["mcpServers"].as_object().expect("object").len(),
            1,
            "loaf ended up listed more than once"
        );
    }

    #[test]
    fn an_mcpservers_key_of_the_wrong_shape_is_replaced_not_trusted() {
        let before = cfg(r#"{"mcpServers":"oops","keep":1}"#);
        let after = with_loaf(Some(&before), "C:/Loaf.exe", &[]);
        assert!(has_loaf(Some(&after)));
        assert_eq!(after["keep"], 1);
    }

    #[test]
    fn lists_the_other_servers_so_the_user_can_see_them() {
        let before = cfg(r#"{"mcpServers":{"loaf":{},"a":{},"b":{}}}"#);
        let mut names = other_servers(Some(&before));
        names.sort();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn removing_from_a_config_that_never_had_it_is_harmless() {
        let before = cfg(r#"{"mcpServers":{"other":{}}}"#);
        let after = without_loaf(Some(&before));
        assert_eq!(after["mcpServers"]["other"], json!({}));
    }

    #[test]
    fn an_unreadable_config_is_an_error_rather_than_an_empty_one() {
        let dir = std::env::temp_dir().join("loaf-claude-cfg-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("claude_desktop_config.json");
        std::fs::write(&path, "{ this is not json").expect("write");
        // Reading it as None would mean the next write silently replaced a file
        // full of servers belonging to the user.
        assert!(read(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_copy_lives_beside_the_history_not_beside_the_build() {
        // The whole point: a path nothing else writes to. Anything under a
        // build directory is replaced by the next compile, which kills the
        // server Claude is running from it.
        let dir = std::path::Path::new("C:/data");
        let p = server_binary(dir);
        assert!(p.ends_with(if cfg!(windows) {
            "LoafPlus/loaf-mcp.exe"
        } else {
            "LoafPlus/loaf-mcp"
        }));
        assert!(!p.to_string_lossy().contains("target"));
    }

    #[test]
    fn a_copy_is_made_and_then_left_alone_until_the_original_changes() {
        let dir = std::env::temp_dir().join("loaf-copy-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("LoafPlus")).expect("temp dir");
        let target = server_binary(&dir);

        // Stand in for the running program: any file will do, since the only
        // thing under test is when it is copied.
        let source = dir.join("pretend-loaf.exe");
        std::fs::write(&source, b"first").expect("write");
        assert!(newer(&source, &target), "a missing copy is always stale");

        std::fs::copy(&source, &target).expect("copy");
        assert!(
            !newer(&source, &target),
            "an up-to-date copy must not be rewritten on every launch"
        );

        // A newer original — an updated Loaf — must replace it, or an old
        // server keeps answering for a build that no longer exists.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&source, b"second").expect("rewrite");
        assert!(newer(&source, &target));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_empty_config_is_simply_absent() {
        let dir = std::env::temp_dir().join("loaf-claude-cfg-test2");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let missing = dir.join("not-there.json");
        assert_eq!(read(&missing).expect("ok"), None);
        let empty = dir.join("empty.json");
        std::fs::write(&empty, "   ").expect("write");
        assert_eq!(read(&empty).expect("ok"), None);
        let _ = std::fs::remove_file(&empty);
    }
}
