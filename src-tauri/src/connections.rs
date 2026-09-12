//! The app-facing half of MCP: connecting Loaf to other programs.
//!
//! [`mcp_client`] knows how to speak the protocol. This file is what the window
//! is allowed to ask it to do, and the two are separate on purpose — everything
//! here is a decision about trust, and none of it belongs in a transport.
//!
//! THE ONE RULE THAT SHAPES EVERY FUNCTION BELOW: **secrets go in and never
//! come out.** A connected server usually needs an API key, so the config file
//! holds one. The dashboard is a WebView; anything it can read is one bug away
//! from being somewhere else. So the webview is told which environment
//! variables a server has, never what they are, and [`redact`] is the only way
//! a server ever reaches it.
//!
//! That creates the problem [`merge_env`] exists to solve. A UI that cannot see
//! a value must not be able to destroy it by saving the form it was never shown
//! — so an empty value on the way in means "keep the one you have", and only a
//! non-empty value replaces anything. Removing the key from the map is how you
//! delete it, which is a thing you have to do deliberately.
//!
//! NOTHING HERE STARTS A PROGRAM BY ITSELF. Adding a server writes a line to a
//! file. The first time a process is spawned is the first time somebody asks
//! for its tools, and [`disconnect`] stops it again. Loaf holds no connections
//! at rest and opens none at launch.

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::mcp_client::{self, CallRecord, Config, Connection, ServerSpec};

/// A server as the dashboard is allowed to see it.
///
/// The shape is [`ServerSpec`] with `env` replaced by its keys. That is the
/// whole difference and it is the point of the type: there is no path from the
/// config to the window that does not pass through here.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServerView {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub note: String,
    /// Which environment variables are set for this server. Names only.
    #[serde(default)]
    pub env_keys: Vec<String>,
    /// The address, for a remote server. Not a secret: it is what the user typed.
    #[serde(default)]
    pub url: String,
    /// Whether a browser sign-in has been done for this server.
    ///
    /// Separate from `has_token`, because the two offer different buttons: a
    /// pasted token can only be replaced by hand, while a sign-in can be
    /// renewed and undone from the panel.
    #[serde(default)]
    pub signed_in: bool,
    /// Whether a bearer token is stored — never the token.
    ///
    /// The same rule as `env_keys`: the window is told a credential EXISTS so it
    /// can say so, and is never handed one. There is no reveal and there will
    /// not be. A window is one bug away from being somewhere else.
    #[serde(default)]
    pub has_token: bool,
}

/// Everything the window may know about the configured servers.
pub fn redact(config: &Config) -> Vec<ServerView> {
    config
        .servers
        .iter()
        .map(|s| ServerView {
            name: s.name.clone(),
            command: s.command.clone(),
            args: s.args.clone(),
            url: s.url.clone(),
            has_token: !s.token.trim().is_empty(),
            // WHETHER, never what. The same rule the token follows: the window
            // is told a sign-in exists so it can say so and offer to undo it,
            // and there is no shape in which the token itself comes back down.
            signed_in: s
                .oauth
                .as_ref()
                .is_some_and(super::oauth::Session::signed_in),
            note: s.note.clone(),
            env_keys: s.env.keys().cloned().collect(),
        })
        .collect()
}

/// Fold a saved form back into the stored config without losing what it could
/// not see.
///
/// `incoming` is what the window sent; `existing` is what is on disk for the
/// same server. An empty incoming value means the field was rendered as "set"
/// and left alone, so the stored value survives. A non-empty one replaces it.
/// A key that is absent from `incoming` has been deleted on purpose.
///
/// The failure this prevents is quiet and total: without it, opening the
/// connections tab and pressing Save would blank every API key on the machine
/// and every server would stop working for no visible reason.
pub fn merge_env(
    incoming: &BTreeMap<String, String>,
    existing: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    incoming
        .iter()
        .map(|(key, value)| {
            if value.is_empty() {
                (key.clone(), existing.get(key).cloned().unwrap_or_default())
            } else {
                (key.clone(), value.clone())
            }
        })
        .collect()
}

/// Apply a saved list of servers to the stored config.
///
/// Kept separate from the command so it can be tested without a file or an app
/// handle, because the merge above is the part that can lose data.
pub fn apply(stored: &Config, incoming: Vec<ServerView>, secrets: &SecretsIn) -> Config {
    let previous: BTreeMap<&str, &ServerSpec> = stored
        .servers
        .iter()
        .map(|s| (s.name.as_str(), s))
        .collect();

    let servers = incoming
        .into_iter()
        .map(|view| {
            let old = previous.get(view.name.as_str());
            let existing = old.map(|s| s.env.clone()).unwrap_or_default();
            // Keys the window kept, each mapped to whatever it typed — usually
            // nothing, which means "leave it".
            let typed: BTreeMap<String, String> = view
                .env_keys
                .iter()
                .map(|k| (k.clone(), secrets.get(&view.name, k)))
                .collect();
            // The token travels through the same one-way channel as the env
            // values, under a reserved key, so there is only one path for a
            // secret into Rust and only one rule for keeping it.
            let token = keep_or_replace(
                &secrets.get(&view.name, TOKEN_KEY),
                old.map(|s| s.token.as_str()).unwrap_or_default(),
            );
            ServerSpec {
                name: view.name,
                command: view.command,
                args: view.args,
                url: view.url,
                // The same rule as the env values: the window never receives the
                // token, so it cannot send it back. An empty one here means
                // "leave what is stored", not "clear it" — otherwise every save
                // from the panel would wipe the credential it was never shown.
                token,
                // CARRIED THROUGH, like the watches below. This function
                // rebuilds every server from what the window sent, and the
                // window is never told about a sign-in — so building a fresh
                // spec here would sign the user out of every remote server the
                // next time somebody renamed one.
                oauth: old.and_then(|s| s.oauth.clone()),
                env: merge_env(&typed, &existing),
                note: view.note,
            }
        })
        .collect();

    // WATCHES ARE CARRIED THROUGH, and this line is load-bearing. This
    // function rebuilds the config from what the window sent, and the window
    // is never told about watches — so building a fresh `Config` here would
    // delete every one of them the next time somebody renamed a server.
    Config {
        servers,
        watches: stored.watches.clone(),
    }
}

/// New secret values, if the user typed any, keyed by server then variable.
///
/// Separate from [`ServerView`] so that the type the window *reads* has no
/// field a secret could ever be written into. A value can be sent up; there is
/// no shape in which one comes back down.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct SecretsIn(#[serde(default)] BTreeMap<String, BTreeMap<String, String>>);

/// Where a remote server's bearer token travels, inside `SecretsIn`.
///
/// A reserved key rather than a second field, so every secret the window sends
/// uses one channel with one rule. Two channels would be two places to get the
/// "empty means keep it" rule wrong, and getting it wrong means wiping a
/// credential the window was never allowed to see.
pub const TOKEN_KEY: &str = "__token";

/// A typed secret, or the stored one when nothing was typed.
///
/// Empty means "leave it alone", NOT "clear it". The window is never given a
/// secret, so it cannot send one back, so every save would otherwise erase the
/// credential it was not shown. Clearing is done by removing the server.
fn keep_or_replace(typed: &str, stored: &str) -> String {
    if typed.trim().is_empty() {
        stored.to_string()
    } else {
        typed.trim().to_string()
    }
}

impl SecretsIn {
    fn get(&self, server: &str, key: &str) -> String {
        self.0
            .get(server)
            .and_then(|m| m.get(key))
            .cloned()
            .unwrap_or_default()
    }
}

/// The servers Loaf currently has running, if any.
///
/// Empty at launch and empty again after [`disconnect`]. A connection appears
/// here only because something asked a server a question.
#[derive(Default)]
pub struct Pool(pub Mutex<BTreeMap<String, Connection>>);

/// Read the config off disk, tolerating its absence.
///
/// A missing file is no servers, not an error: that is the state every machine
/// starts in and the state most stay in.
pub fn load(data_dir: &std::path::Path) -> Result<Config, String> {
    let path = mcp_client::config_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => mcp_client::parse_config(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save(data_dir: &std::path::Path, config: &Config) -> Result<(), String> {
    let path = mcp_client::config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// The call log, newest last. Missing file means nothing has been sent yet.
pub fn calls(data_dir: &std::path::Path) -> Vec<CallRecord> {
    std::fs::read_to_string(mcp_client::log_path(data_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Get a connection to `name`, starting the program if it is not already up.
///
/// Takes the pool lock for the whole handshake. That serialises connecting,
/// which is the right trade: starting a server is rare and slow, and two
/// windows racing to spawn the same process is worse than one waiting.
pub fn with_connection<T>(
    pool: &Pool,
    config: &Config,
    name: &str,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let spec = config
        .servers
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("No server called {name} is connected."))?
        .clone();

    let mut open = pool.0.lock().map_err(|_| "the connection pool broke")?;
    if !open.contains_key(name) {
        open.insert(name.to_string(), Connection::open(&spec)?);
    }
    let conn = open
        .get_mut(name)
        .ok_or("the connection vanished as it was opened")?;

    // A server that fails mid-call is dropped rather than left in the pool. Its
    // pipes may be half-written and the next request would read this one's
    // answer; restarting is cheap and being subtly out of step is not.
    match f(conn) {
        Ok(value) => Ok(value),
        Err(why) => {
            open.remove(name);
            Err(why)
        }
    }
}

/// Stop a server Loaf started. Dropping the connection kills the child.
pub fn disconnect(pool: &Pool, name: &str) {
    if let Ok(mut open) = pool.0.lock() {
        open.remove(name);
    }
}

pub fn connected(pool: &Pool) -> Vec<String> {
    pool.0
        .lock()
        .map(|open| open.keys().cloned().collect())
        .unwrap_or_default()
}

/// Seconds since the epoch, for the call log.
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, env: &[(&str, &str)]) -> ServerSpec {
        ServerSpec {
            name: name.into(),
            command: "npx".into(),
            args: vec!["-y".into(), format!("{name}-mcp")],
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            note: String::new(),
            url: String::new(),
            token: String::new(),
            oauth: None,
        }
    }

    // The window never sees watches, so a rebuild from what it sent would
    // delete them. Renaming a server would have silently thrown away every
    // watch the user had made.
    #[test]
    fn editing_servers_does_not_throw_away_the_watches() {
        let stored = Config {
            servers: vec![spec("gmail", &[])],
            watches: vec![crate::watch::Watch {
                server: "gmail".into(),
                tool: "list_unread".into(),
                arguments: "{}".into(),
                every_seconds: 300,
                say: "New mail.".into(),
                enabled: true,
            }],
        };
        let incoming = vec![ServerView {
            name: "gmail".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "gmail-mcp".into()],
            note: String::new(),
            env_keys: Vec::new(),
            url: String::new(),
            has_token: false,
            signed_in: false,
        }];
        let out = apply(&stored, incoming, &SecretsIn::default());
        assert_eq!(out.watches, stored.watches);
    }

    #[test]
    fn the_window_is_told_the_keys_and_never_the_values() {
        let config = Config {
            servers: vec![spec("slack", &[("SLACK_TOKEN", "xoxb-the-actual-secret")])],
            watches: Vec::new(),
        };
        let view = redact(&config);
        assert_eq!(view[0].env_keys, vec!["SLACK_TOKEN".to_string()]);

        // The real assertion: no shape of the redacted value contains the
        // secret, whatever anyone later adds to ServerView.
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("xoxb-the-actual-secret"), "{json}");
    }

    #[test]
    fn saving_a_form_that_could_not_see_a_key_does_not_erase_it() {
        let stored = Config {
            servers: vec![spec("slack", &[("SLACK_TOKEN", "xoxb-secret")])],
            watches: Vec::new(),
        };
        // What comes back from a window that rendered the key as "set" and had
        // nothing typed into it.
        let round_trip = redact(&stored);
        let after = apply(&stored, round_trip, &SecretsIn::default());
        assert_eq!(after.servers[0].env["SLACK_TOKEN"], "xoxb-secret");
    }

    #[test]
    fn a_typed_value_replaces_the_stored_one() {
        let stored = Config {
            servers: vec![spec("slack", &[("SLACK_TOKEN", "old")])],
            watches: Vec::new(),
        };
        let mut secrets = BTreeMap::new();
        secrets.insert(
            "slack".to_string(),
            BTreeMap::from([("SLACK_TOKEN".to_string(), "new".to_string())]),
        );
        let after = apply(&stored, redact(&stored), &SecretsIn(secrets));
        assert_eq!(after.servers[0].env["SLACK_TOKEN"], "new");
    }

    #[test]
    fn dropping_a_key_from_the_list_deletes_it() {
        let stored = Config {
            servers: vec![spec("slack", &[("A", "1"), ("B", "2")])],
            watches: Vec::new(),
        };
        let mut view = redact(&stored);
        view[0].env_keys.retain(|k| k != "B");
        let after = apply(&stored, view, &SecretsIn::default());
        assert_eq!(after.servers[0].env.keys().collect::<Vec<_>>(), vec!["A"]);
    }

    #[test]
    fn a_new_server_starts_with_no_environment() {
        let stored = Config::default();
        let view = vec![ServerView {
            name: "granola".into(),
            command: "npx".into(),
            args: vec![],
            note: "meeting notes".into(),
            env_keys: vec![],
            url: String::new(),
            has_token: false,
            signed_in: false,
        }];
        let after = apply(&stored, view, &SecretsIn::default());
        assert_eq!(after.servers.len(), 1);
        assert!(after.servers[0].env.is_empty());
        assert_eq!(after.servers[0].note, "meeting notes");
    }

    #[test]
    fn renaming_a_server_does_not_carry_the_old_key_over() {
        // Deliberate: env is matched by name, so a rename is a new server. The
        // alternative is guessing which old entry a renamed one used to be, and
        // guessing wrong moves a credential to a program it was not issued for.
        let stored = Config {
            servers: vec![spec("slack", &[("SLACK_TOKEN", "secret")])],
            watches: Vec::new(),
        };
        let mut view = redact(&stored);
        view[0].name = "slack-work".into();
        let after = apply(&stored, view, &SecretsIn::default());
        assert_eq!(after.servers[0].env["SLACK_TOKEN"], "");
    }

    #[test]
    fn a_missing_config_is_no_servers_rather_than_an_error() {
        let dir = std::env::temp_dir().join("loaf-mcp-test-absent");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load(&dir).unwrap().servers.is_empty());
    }

    #[test]
    fn what_is_saved_is_what_is_read_back() {
        let dir = std::env::temp_dir().join("loaf-mcp-test-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let config = Config {
            servers: vec![spec("granola", &[("KEY", "v")])],
            watches: Vec::new(),
        };
        save(&dir, &config).unwrap();
        let back = load(&dir).unwrap();
        assert_eq!(back.servers.len(), 1);
        assert_eq!(back.servers[0].env["KEY"], "v");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_connected_until_something_asks() {
        let pool = Pool::default();
        assert!(connected(&pool).is_empty());
    }

    #[test]
    fn asking_for_a_server_that_is_not_configured_says_so() {
        let pool = Pool::default();
        let err = with_connection(&pool, &Config::default(), "nope", |_| Ok(())).unwrap_err();
        assert!(err.contains("nope"), "{err}");
        // And it did not spawn anything trying to find out.
        assert!(connected(&pool).is_empty());
    }
}
