//! Signing in to a remote MCP server with a browser, instead of pasting a token.
//!
//! WHY THIS IS THE MILESTONE IT IS. `remote.rs` gave Loaf the transport that
//! hosted connectors use, and then the only way to authorise one was to obtain a
//! bearer token out of band and paste it into a box. That is exactly the
//! developer-shaped setup the whole remote transport existed to avoid. This is
//! the other half: press a button, a browser opens, you sign in to the service
//! you already have an account with, and Loaf never sees your password.
//!
//! THE SHAPE OF THE FLOW, because the pieces only make sense together:
//!
//!  1. Ask the server. An unauthorised MCP server answers 401 with a
//!     `WWW-Authenticate` header naming where to find its metadata.
//!  2. Read that metadata to learn which authorisation server to talk to, then
//!     read THAT server's metadata to learn its endpoints.
//!  3. Register. Loaf is not pre-registered anywhere and never can be — there is
//!     no central Loaf identity at every provider — so it registers itself on the
//!     spot (RFC 7591) and gets a client id back.
//!  4. Open a browser at the authorisation endpoint, with a PKCE challenge and a
//!     random `state`, and listen on a loopback port for the answer.
//!  5. Swap the code for tokens, and store them.
//!
//! TWO THINGS HERE ARE SECURITY-CRITICAL AND NEITHER IS OBVIOUS.
//!
//! `state` is the entire defence against another page completing a sign-in on
//! the user's behalf: the callback is a plain HTTP request to localhost that
//! anything on the machine could make, and the only reason a forged one is
//! rejected is that it cannot guess this value. It comes from the OS random
//! source and is compared in full.
//!
//! PKCE is what stops an authorisation code being useful to anyone who
//! intercepts it. The specification requires the S256 method rather than
//! `plain`, so the challenge is a real SHA-256 — the one place in this project
//! where writing our own would be silly, and the reason `sha2` is a dependency.
//!
//! EVERYTHING PURE IS SEPARATE AND TESTED. Discovery documents, callback
//! parsing, URL building and token responses are all functions of strings, for
//! the same reason `remote.rs` splits them out: each of them fails as "the
//! sign-in did not work" with nothing to look at, and each of them is exactly
//! the kind of thing that is subtly wrong for months.

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The endpoints an authorisation server publishes about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuthServer {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    /// Empty when the server does not allow clients to register themselves.
    #[serde(default)]
    pub registration_endpoint: String,
    /// What the server says it supports, so we can ask for something it has.
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

/// What came back from the token endpoint.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Seconds since the epoch. 0 means the server did not say.
    #[serde(default)]
    pub expires_at: u64,
}

/// Everything Loaf remembers about one signed-in server.
///
/// Stored in the same config Rust owns as the bearer token is, and never handed
/// to a window — the panel is told a sign-in EXISTS, never what it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Session {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub server: AuthServer,
    /// The MCP server this sign-in is FOR, as an RFC 8707 resource indicator.
    ///
    /// Sent with both the authorisation request and the token request so the
    /// tokens that come back are only good for this server. A token minted
    /// without one can be replayed against any other service that trusts the
    /// same authorisation server.
    #[serde(default)]
    pub resource: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub tokens: Tokens,
}

impl Session {
    /// Whether there is a usable access token right now.
    pub fn signed_in(&self) -> bool {
        !self.tokens.access_token.trim().is_empty()
    }
}

/// Seconds of headroom before an access token is treated as expired.
///
/// A token that expires during the request it was attached to fails as a bare
/// 401, which is indistinguishable from being signed out. Renewing slightly
/// early costs one extra round trip and removes that whole class of confusion.
pub const REFRESH_MARGIN_SECS: u64 = 60;

/// Whether this token should be renewed before being used again.
pub fn needs_refresh(tokens: &Tokens, now_secs: u64) -> bool {
    if tokens.access_token.trim().is_empty() {
        return false;
    }
    // A server that never said when it expires is taken at its word rather than
    // renewed on a guess: refreshing a perfectly good token on every call would
    // be worse than occasionally meeting a 401.
    if tokens.expires_at == 0 {
        return false;
    }
    now_secs + REFRESH_MARGIN_SECS >= tokens.expires_at
}

/// Pull the metadata URL out of a `WWW-Authenticate` header.
///
/// The header looks like
/// `Bearer realm="x", resource_metadata="https://host/.well-known/..."`,
/// and the quoted value is the only part worth having. Returns None when the
/// header is absent or says nothing useful, which is common — plenty of servers
/// answer 401 with nothing at all, and the caller falls back to guessing the
/// well-known path from the server URL.
pub fn resource_metadata_url(header: &str) -> Option<String> {
    let key = "resource_metadata";
    let start = header.find(key)?;
    let rest = &header[start + key.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let value = if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        rest.split([',', ' ']).next()?
    };
    let value = value.trim();
    if value.starts_with("https://") || value.starts_with("http://") {
        Some(value.to_string())
    } else {
        None
    }
}

/// The origin of a URL — scheme and host, no path.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split('/').next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// The canonical identifier for the MCP server being signed in to.
///
/// RFC 8707 calls this the resource indicator. Trailing slashes and any query
/// or fragment are dropped, because it has to be spelled the same way every
/// time or the authorisation server treats two requests as being about two
/// different things.
pub fn canonical_resource(url: &str) -> String {
    let url = url.trim();
    let url = url.split(['?', '#']).next().unwrap_or(url);
    url.trim_end_matches('/').to_string()
}

/// Where to look for a protected resource's metadata, best guess first.
///
/// The spec puts the well-known segment after the scheme and host and BEFORE the
/// path, which reads backwards and is the detail most implementations get wrong.
/// Both spellings are tried because plenty of deployed servers use the simpler
/// one.
pub fn protected_resource_urls(server_url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let trimmed = server_url.trim().trim_end_matches('/');
    let Some(origin) = origin_of(trimmed) else {
        return out;
    };
    let path = trimmed.strip_prefix(&origin).unwrap_or("");
    if !path.is_empty() {
        out.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    out.push(format!("{origin}/.well-known/oauth-protected-resource"));
    out
}

/// Where to look for an authorisation server's own metadata.
///
/// OpenID Connect discovery is included because a great many providers publish
/// only that document, and it carries the same three endpoints under the same
/// names.
pub fn auth_server_urls(issuer: &str) -> Vec<String> {
    let mut out = Vec::new();
    let trimmed = issuer.trim().trim_end_matches('/');
    let Some(origin) = origin_of(trimmed) else {
        return out;
    };
    let path = trimmed.strip_prefix(&origin).unwrap_or("");
    if !path.is_empty() {
        out.push(format!(
            "{origin}/.well-known/oauth-authorization-server{path}"
        ));
        out.push(format!("{origin}/.well-known/openid-configuration{path}"));
    }
    out.push(format!("{origin}/.well-known/oauth-authorization-server"));
    out.push(format!("{origin}/.well-known/openid-configuration"));
    out
}

/// The first authorisation server a protected-resource document points at.
pub fn authorization_server_of(json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(json).ok()?;
    let list = value.get("authorization_servers")?.as_array()?;
    list.iter()
        .find_map(|v| v.as_str())
        .map(|s| s.trim().to_string())
}

/// Read an authorisation server metadata document.
///
/// Refuses one without the two endpoints that matter, rather than returning a
/// half-filled struct that fails later with a blank URL.
pub fn parse_auth_server(json: &str) -> Result<AuthServer, String> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| format!("That sign-in service returned something unreadable: {e}"))?;
    let text = |key: &str| -> String {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let server = AuthServer {
        authorization_endpoint: text("authorization_endpoint"),
        token_endpoint: text("token_endpoint"),
        registration_endpoint: text("registration_endpoint"),
        scopes_supported: value
            .get("scopes_supported")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    };
    if server.authorization_endpoint.is_empty() || server.token_endpoint.is_empty() {
        return Err("That sign-in service did not say where to send you.".into());
    }
    Ok(server)
}

/// Random bytes from the operating system, as base64url without padding.
///
/// The OS source rather than a seeded generator, because `state` is the only
/// thing stopping a forged callback and a predictable one is a real hole.
fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if getrandom::getrandom(&mut buf).is_err() {
        // Refusing is the correct failure. Carrying on with a predictable value
        // would produce a sign-in that LOOKS fine and is not protected.
        return String::new();
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf)
}

/// A PKCE verifier and the challenge derived from it.
///
/// The challenge is `base64url(sha256(verifier))` with no padding, which is what
/// the `S256` method means. Returns empty strings if the system random source
/// fails, and the caller must treat that as a refusal rather than proceed.
pub fn pkce_pair() -> (String, String) {
    let verifier = random_urlsafe(48);
    if verifier.is_empty() {
        return (String::new(), String::new());
    }
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

/// A random value for the `state` parameter.
pub fn new_state() -> String {
    random_urlsafe(24)
}

/// Everything RFC 3986 calls unreserved, which is what must NOT be escaped.
///
/// Escaping more than this is legal and was the first thing tried, and it is
/// also how `code_challenge_method` became `code%5Fchallenge%5Fmethod`. Plenty
/// of servers match parameter names literally, so an over-escaped name is a
/// parameter they never see.
const UNRESERVED: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Percent-encode one query-string value.
fn encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, UNRESERVED).to_string()
}

/// Build a form body or query string from pairs.
///
/// The NAME is written literally and only the VALUE is escaped. Every name here
/// is a fixed token from the specification, made of characters that need no
/// escaping; escaping them anyway produced parameters the server did not
/// recognise, which fails as a sign-in that is refused for no stated reason.
pub fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Where to send the user's browser.
pub fn authorize_url(
    server: &AuthServer,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    scope: &str,
    resource: &str,
) -> String {
    let query = form(&[
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("scope", scope),
        ("resource", resource),
    ]);
    let joiner = if server.authorization_endpoint.contains('?') {
        "&"
    } else {
        "?"
    };
    format!("{}{joiner}{query}", server.authorization_endpoint)
}

/// What the browser came back with.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code {
        code: String,
        state: String,
    },
    /// The user said no, or the server refused.
    Refused(String),
}

/// Read the authorisation code out of the browser's request line.
///
/// The line looks like `GET /callback?code=...&state=... HTTP/1.1`. An `error`
/// parameter is reported as a refusal rather than as a missing code, because
/// "you declined" and "something is broken" need different words on screen.
pub fn parse_callback(request_line: &str) -> Result<Callback, String> {
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("The browser sent something that was not a request.")?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = String::new();
    let mut state = String::new();
    let mut error = String::new();
    let mut description = String::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = percent_encoding::percent_decode_str(value)
            .decode_utf8_lossy()
            .replace('+', " ");
        match key {
            "code" => code = value,
            "state" => state = value,
            "error" => error = value,
            "error_description" => description = value,
            _ => {}
        }
    }
    if !error.is_empty() {
        let detail = if description.is_empty() {
            error
        } else {
            format!("{error}: {description}")
        };
        return Ok(Callback::Refused(detail));
    }
    if code.is_empty() {
        return Err("The sign-in came back without a code.".into());
    }
    Ok(Callback::Code { code, state })
}

/// Read a token response.
///
/// `expires_in` is turned into an absolute time immediately, because a duration
/// is only meaningful at the moment it was received and this is going to be
/// written to a file and read back tomorrow.
pub fn parse_tokens(json: &str, now_secs: u64) -> Result<Tokens, String> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| format!("The sign-in service returned something unreadable: {e}"))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        let detail = value
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(if detail.is_empty() {
            format!("The sign-in was refused ({error}).")
        } else {
            format!("The sign-in was refused ({error}): {detail}")
        });
    }
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if access.is_empty() {
        return Err("The sign-in finished without giving Loaf a token.".into());
    }
    let expires_at = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .map(|secs| now_secs + secs)
        .unwrap_or(0);
    Ok(Tokens {
        access_token: access,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        expires_at,
    })
}

/// The body sent to register Loaf as a client, per RFC 7591.
///
/// `none` for the authentication method because Loaf is a public client: it runs
/// on the user's computer and cannot keep a secret, and claiming otherwise would
/// mean shipping one inside the application where anybody can read it.
pub fn registration_body(redirect_uri: &str) -> Value {
    serde_json::json!({
        "client_name": "Loaf",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
}

/// Read the client id out of a registration response.
pub fn parse_registration(json: &str) -> Result<(String, String), String> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| format!("That service returned something unreadable: {e}"))?;
    let id = value
        .get("client_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err("That service would not let Loaf register.".into());
    }
    let secret = value
        .get("client_secret")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok((id, secret))
}

/// The little page the browser lands on when the sign-in is done.
///
/// Plain, self-contained, and it tells the person to go back to Loaf — a blank
/// tab reads as a failure even when everything worked.
pub fn done_page(message: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>Loaf</title>\
<style>body{{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;\
background:#faf7f2;color:#2b2b2b}}div{{text-align:center;max-width:24rem;padding:2rem}}\
p{{opacity:.7;font-size:14px}}</style>\
<div><h1>{message}</h1><p>You can close this tab and go back to Loaf.</p></div>"
    )
}

// --- The parts that touch the world ------------------------------------------

/// A one-shot HTTP listener on loopback, waiting for the browser to come back.
///
/// WRITTEN OUT RATHER THAN PULLED IN, because what it has to do is small and
/// exact: accept one connection, read one request line, write one page. A web
/// server dependency for that would be a lot of surface for a socket that is
/// open for about twenty seconds.
///
/// 127.0.0.1 SPECIFICALLY, not 0.0.0.0, and the difference matters: binding to
/// every interface would put a port that completes sign-ins on the local
/// network. Port 0 lets the operating system pick a free one, so nothing has to
/// be reserved and two sign-ins cannot collide.
pub struct Loopback {
    listener: std::net::TcpListener,
    port: u16,
}

impl Loopback {
    pub fn bind() -> Result<Self, String> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("Loaf could not open a port to finish the sign-in: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        Ok(Self { listener, port })
    }

    /// The address the authorisation server will send the browser back to.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Wait for the browser, check the `state`, and return the code.
    ///
    /// Loops rather than taking the first connection, because a browser asks for
    /// `/favicon.ico` and anything else it fancies; taking the first request
    /// would read a favicon fetch as a failed sign-in.
    ///
    /// A MISMATCHED `state` IS REFUSED AND THE WAIT CONTINUES. That is the
    /// entire defence here: this port accepts connections from anything running
    /// on the machine, and a forged callback is only stopped by not knowing the
    /// value.
    pub fn wait(&self, state: &str, timeout: std::time::Duration) -> Result<String, String> {
        use std::io::{BufRead, BufReader, Write};
        let deadline = std::time::Instant::now() + timeout;
        self.listener
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;

        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err("The sign-in was not finished in time.".into());
            }
            // A read timeout on the accepted socket rather than on accept, which
            // has none: a browser that connects and says nothing must not hold
            // the whole sign-in open.
            let (stream, _) = self
                .listener
                .accept()
                .map_err(|e| format!("The sign-in could not be received: {e}"))?;
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));

            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                continue;
            }
            if !line.contains("/callback") {
                let _ = respond(&stream, &done_page("Nothing to do here"));
                continue;
            }

            let outcome = parse_callback(&line);
            let mut stream = stream;
            match outcome {
                Ok(Callback::Code { code, state: got }) => {
                    // Compared in full. A prefix comparison here would be the
                    // whole protection reduced to a guessing game.
                    if got != state {
                        let _ = respond(
                            &mut stream,
                            &done_page("That sign-in was not the one Loaf started"),
                        );
                        return Err(
                            "That sign-in did not match the one Loaf started, so it was refused."
                                .into(),
                        );
                    }
                    let _ = respond(&mut stream, &done_page("Signed in"));
                    return Ok(code);
                }
                Ok(Callback::Refused(why)) => {
                    let _ = respond(&mut stream, &done_page("Sign-in cancelled"));
                    return Err(format!("The sign-in was refused: {why}"));
                }
                Err(why) => {
                    let _ = respond(&mut stream, &done_page("Something went wrong"));
                    return Err(why);
                }
            }
        }

        #[allow(clippy::items_after_statements)]
        fn respond(mut stream: impl Write, body: &str) -> std::io::Result<()> {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )?;
            stream.flush()
        }
    }
}

/// GET a document, returning its body.
fn fetch(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    match agent.get(url).call() {
        Ok(response) => response
            .into_string()
            .map_err(|e| format!("Could not read {url}: {e}")),
        Err(ureq::Error::Status(code, _)) => Err(format!("{url} answered {code}")),
        Err(e) => Err(format!("Could not reach {url}: {e}")),
    }
}

/// Work out which authorisation server guards this MCP server, and how to use it.
///
/// Tries the address the 401 named, then the well-known paths. Several
/// candidates are attempted because deployed servers genuinely differ about
/// where they put this, and the alternative is refusing to sign in to a server
/// that works perfectly with other clients.
pub fn discover(
    agent: &ureq::Agent,
    server_url: &str,
    www_authenticate: Option<&str>,
) -> Result<AuthServer, String> {
    let mut resource_docs: Vec<String> = Vec::new();
    if let Some(named) = www_authenticate.and_then(resource_metadata_url) {
        resource_docs.push(named);
    }
    resource_docs.extend(protected_resource_urls(server_url));

    // The protected-resource document points at the authorisation server. When
    // there is none, the MCP server may be its own — which several are.
    let mut issuers: Vec<String> = Vec::new();
    for url in &resource_docs {
        if let Ok(body) = fetch(agent, url) {
            if let Some(issuer) = authorization_server_of(&body) {
                issuers.push(issuer);
                break;
            }
        }
    }
    if issuers.is_empty() {
        issuers.push(server_url.to_string());
    }

    let mut last = String::from("that server does not say how to sign in");
    for issuer in &issuers {
        for url in auth_server_urls(issuer) {
            match fetch(agent, &url) {
                Ok(body) => match parse_auth_server(&body) {
                    Ok(server) => return Ok(server),
                    Err(why) => last = why,
                },
                Err(why) => last = why,
            }
        }
    }
    Err(format!("Loaf could not work out how to sign in: {last}"))
}

/// Register Loaf with an authorisation server that has never heard of it.
pub fn register(
    agent: &ureq::Agent,
    endpoint: &str,
    redirect_uri: &str,
) -> Result<(String, String), String> {
    let body = registration_body(redirect_uri).to_string();
    match agent
        .post(endpoint)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body)
    {
        Ok(response) => {
            let text = response.into_string().map_err(|e| e.to_string())?;
            parse_registration(&text)
        }
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(format!(
                "That service would not let Loaf register ({code}). {}",
                text.chars().take(200).collect::<String>()
            ))
        }
        Err(e) => Err(format!("Could not reach the sign-in service: {e}")),
    }
}

/// Post a form to the token endpoint and read what comes back.
fn post_token(agent: &ureq::Agent, endpoint: &str, body: &str) -> Result<Tokens, String> {
    let now = now_secs();
    match agent
        .post(endpoint)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "application/json")
        .send_string(body)
    {
        Ok(response) => {
            let text = response.into_string().map_err(|e| e.to_string())?;
            parse_tokens(&text, now)
        }
        // The BODY is the useful part of a refusal here — it carries the
        // `error` and `error_description` that say which of a dozen things went
        // wrong — so it is parsed rather than reduced to a status code.
        Err(ureq::Error::Status(_, response)) => {
            let text = response.into_string().unwrap_or_default();
            parse_tokens(&text, now)
        }
        Err(e) => Err(format!("Could not reach the sign-in service: {e}")),
    }
}

/// Seconds since the epoch.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Swap an authorisation code for tokens.
pub fn exchange(
    agent: &ureq::Agent,
    session: &Session,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Tokens, String> {
    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", &session.client_id),
        ("client_secret", &session.client_secret),
        ("code_verifier", verifier),
        ("resource", &session.resource),
    ]);
    post_token(agent, &session.server.token_endpoint, &body)
}

/// Renew an access token without sending the user back to a browser.
pub fn refresh(agent: &ureq::Agent, session: &Session) -> Result<Tokens, String> {
    if session.tokens.refresh_token.trim().is_empty() {
        return Err("That connection has to be signed in to again.".into());
    }
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &session.tokens.refresh_token),
        ("client_id", &session.client_id),
        ("client_secret", &session.client_secret),
        ("resource", &session.resource),
    ]);
    let mut tokens = post_token(agent, &session.server.token_endpoint, &body)?;
    // Not every server returns a new refresh token, and losing the old one
    // would turn the next renewal into a full sign-in for no reason.
    if tokens.refresh_token.trim().is_empty() {
        tokens.refresh_token = session.tokens.refresh_token.clone();
    }
    Ok(tokens)
}

/// Ask the MCP server what it wants, and keep the challenge it answers with.
///
/// A POST rather than a GET, because that is the request the transport actually
/// makes and some servers only challenge the method they serve. The BODY is a
/// real `initialize`, so a server that happens to allow anonymous access answers
/// properly instead of being confused by an empty request.
///
/// Returns None when the server does not challenge at all, which is a perfectly
/// good answer: discovery then falls back to the well-known paths.
pub fn challenge_for(agent: &ureq::Agent, url: &str) -> Option<String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "loaf", "version": env!("CARGO_PKG_VERSION") }
        }
    })
    .to_string();
    match agent
        .post(url)
        .set("Content-Type", "application/json")
        .set("Accept", crate::remote::ACCEPT)
        .send_string(&body)
    {
        Err(ureq::Error::Status(401, response)) => response
            .header("WWW-Authenticate")
            .map(str::to_string)
            .or_else(|| Some(String::new())),
        _ => None,
    }
}

/// How long to wait for somebody to finish signing in.
///
/// Long enough to find a password, approve a second factor and read a consent
/// screen without being rushed; short enough that an abandoned attempt does not
/// leave a port open all day.
pub const SIGN_IN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The whole sign-in, from a 401 to a stored token.
///
/// Blocking on purpose. It is called from an async Tauri command, which puts it
/// on the thread pool, and the alternative — driving a browser round trip
/// through a state machine — would be far more code for a thing that happens
/// once per connection.
///
/// `open_browser` is passed in rather than called directly so the orchestration
/// can be exercised without a browser appearing.
pub fn sign_in(
    agent: &ureq::Agent,
    server_url: &str,
    www_authenticate: Option<&str>,
    existing: Option<&Session>,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Session, String> {
    let loopback = Loopback::bind()?;
    let redirect_uri = loopback.redirect_uri();

    let discovered = discover(agent, server_url, www_authenticate)?;
    let resource = canonical_resource(server_url);

    // Registration is reused when we already have one. Registering again on
    // every sign-in would leave a trail of dead clients on the provider and
    // lose whatever the user approved last time.
    let (client_id, client_secret) = match existing {
        Some(s)
            if !s.client_id.is_empty() && s.server.token_endpoint == discovered.token_endpoint =>
        {
            (s.client_id.clone(), s.client_secret.clone())
        }
        _ => {
            if discovered.registration_endpoint.is_empty() {
                return Err(
                    "That service does not let programs register themselves, so Loaf cannot \
                     sign in to it automatically. A token pasted into the box below still works."
                        .into(),
                );
            }
            register(agent, &discovered.registration_endpoint, &redirect_uri)?
        }
    };

    let scope = discovered.scopes_supported.join(" ");
    let mut session = Session {
        client_id,
        client_secret,
        server: discovered,
        resource,
        scope,
        tokens: Tokens::default(),
    };

    let (verifier, challenge) = pkce_pair();
    if verifier.is_empty() {
        // Refused rather than downgraded. A sign-in without a real challenge
        // would look identical and protect nothing.
        return Err("Loaf could not generate a secure sign-in on this machine.".into());
    }
    let state = new_state();
    if state.is_empty() {
        return Err("Loaf could not generate a secure sign-in on this machine.".into());
    }

    let url = authorize_url(
        &session.server,
        &session.client_id,
        &redirect_uri,
        &challenge,
        &state,
        &session.scope,
        &session.resource,
    );
    open_browser(&url)?;

    let code = loopback.wait(&state, SIGN_IN_TIMEOUT)?;
    session.tokens = exchange(agent, &session, &code, &verifier, &redirect_uri)?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_metadata_url_in_a_challenge_header() {
        let header = r#"Bearer realm="mcp", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource""#;
        assert_eq!(
            resource_metadata_url(header).as_deref(),
            Some("https://api.example.com/.well-known/oauth-protected-resource")
        );
    }

    #[test]
    fn copes_with_a_header_that_says_nothing_useful() {
        // Very common: plenty of servers answer 401 with a bare Bearer.
        assert!(resource_metadata_url("Bearer").is_none());
        assert!(resource_metadata_url("").is_none());
        assert!(resource_metadata_url(r#"Bearer realm="x""#).is_none());
        // Not a URL at all is refused rather than passed on to be fetched.
        assert!(resource_metadata_url(r#"Bearer resource_metadata="/relative""#).is_none());
    }

    #[test]
    fn puts_the_well_known_segment_before_the_path() {
        // The detail almost everyone gets backwards. The path goes AFTER the
        // well-known segment, not before it.
        let urls = protected_resource_urls("https://api.example.com/mcp/v1");
        assert_eq!(
            urls[0],
            "https://api.example.com/.well-known/oauth-protected-resource/mcp/v1"
        );
        // And the plain spelling is still tried, because many servers use it.
        assert!(urls
            .contains(&"https://api.example.com/.well-known/oauth-protected-resource".to_string()));
    }

    #[test]
    fn also_looks_for_an_openid_document() {
        // A great many providers publish only this one.
        let urls = auth_server_urls("https://login.example.com");
        assert!(urls
            .iter()
            .any(|u| u.ends_with("/.well-known/openid-configuration")));
        assert!(urls
            .iter()
            .any(|u| u.ends_with("/.well-known/oauth-authorization-server")));
    }

    #[test]
    fn spells_the_resource_the_same_way_every_time() {
        // It has to match exactly across two requests or the authorisation
        // server treats them as being about different things.
        assert_eq!(
            canonical_resource("https://a.com/mcp/"),
            "https://a.com/mcp"
        );
        assert_eq!(
            canonical_resource("https://a.com/mcp?x=1"),
            "https://a.com/mcp"
        );
        assert_eq!(
            canonical_resource("  https://a.com/mcp#f "),
            "https://a.com/mcp"
        );
    }

    #[test]
    fn reads_the_endpoints_out_of_a_metadata_document() {
        let doc = r#"{
            "issuer":"https://login.example.com",
            "authorization_endpoint":"https://login.example.com/authorize",
            "token_endpoint":"https://login.example.com/token",
            "registration_endpoint":"https://login.example.com/register",
            "scopes_supported":["read","write"]
        }"#;
        let server = parse_auth_server(doc).expect("parses");
        assert_eq!(server.token_endpoint, "https://login.example.com/token");
        assert_eq!(server.scopes_supported, vec!["read", "write"]);
    }

    #[test]
    fn refuses_a_document_missing_the_endpoints_that_matter() {
        // Better than a struct full of empty strings that fails later as a
        // request to nowhere.
        assert!(parse_auth_server(r#"{"issuer":"https://x.com"}"#).is_err());
        assert!(parse_auth_server("not json").is_err());
    }

    #[test]
    fn the_challenge_is_a_real_sha256_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert!(!verifier.is_empty() && !challenge.is_empty());
        // Recomputed independently: the whole security property is that these
        // two agree, and `plain` is not allowed.
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
        // base64url of a 32-byte hash, unpadded.
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains('='));
        assert!(!challenge.contains('+') && !challenge.contains('/'));
    }

    #[test]
    fn two_sign_ins_never_share_a_verifier_or_a_state() {
        let (a, _) = pkce_pair();
        let (b, _) = pkce_pair();
        assert_ne!(a, b);
        assert_ne!(new_state(), new_state());
        assert!(new_state().len() >= 24);
    }

    #[test]
    fn the_authorize_url_carries_everything_the_server_needs() {
        let server = AuthServer {
            authorization_endpoint: "https://login.example.com/authorize".into(),
            token_endpoint: "https://login.example.com/token".into(),
            ..Default::default()
        };
        let url = authorize_url(
            &server,
            "client-123",
            "http://127.0.0.1:5599/callback",
            "CHALLENGE",
            "STATE",
            "read",
            "https://api.example.com/mcp",
        );
        assert!(url.starts_with("https://login.example.com/authorize?"));
        // Names are literal. Escaping the underscores here made a parameter the
        // server never saw, and the sign-in was refused with nothing to look at.
        assert!(url.contains("code_challenge_method=S256"), "{url}");
        assert!(url.contains("response_type=code"), "{url}");
        assert!(!url.contains("%5F"), "a parameter name got escaped: {url}");
        // The redirect and the resource are URLs inside a query string, so
        // under-encoding would truncate them at the first separator.
        assert!(
            url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5599%2Fcallback"),
            "{url}"
        );
        assert!(
            url.contains("resource=https%3A%2F%2Fapi.example.com%2Fmcp"),
            "{url}"
        );
        assert!(!url.contains("://api.example.com"));
    }

    #[test]
    fn keeps_a_query_string_the_endpoint_already_had() {
        let server = AuthServer {
            authorization_endpoint: "https://login.example.com/authorize?tenant=abc".into(),
            token_endpoint: "https://login.example.com/token".into(),
            ..Default::default()
        };
        let url = authorize_url(&server, "c", "http://127.0.0.1:1/cb", "ch", "st", "", "");
        assert!(url.contains("tenant=abc&"), "{url}");
    }

    #[test]
    fn reads_the_code_out_of_the_browser_request() {
        let line = "GET /callback?code=abc123&state=xyz HTTP/1.1";
        assert_eq!(
            parse_callback(line).expect("parses"),
            Callback::Code {
                code: "abc123".into(),
                state: "xyz".into()
            }
        );
    }

    #[test]
    fn decodes_a_code_that_was_percent_encoded() {
        let line = "GET /callback?code=a%2Fb%2Bc&state=s HTTP/1.1";
        match parse_callback(line).expect("parses") {
            Callback::Code { code, .. } => assert_eq!(code, "a/b c"),
            other => panic!("expected a code, got {other:?}"),
        }
    }

    #[test]
    fn tells_a_refusal_apart_from_a_breakage() {
        // "You said no" and "something is broken" need different words.
        let line = "GET /callback?error=access_denied&error_description=User%20said%20no HTTP/1.1";
        match parse_callback(line).expect("parses") {
            Callback::Refused(why) => {
                assert!(why.contains("access_denied"));
                assert!(why.contains("User said no"));
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_callback_with_no_code_at_all_is_an_error() {
        assert!(parse_callback("GET /callback HTTP/1.1").is_err());
        assert!(parse_callback("nonsense").is_err());
    }

    #[test]
    fn turns_a_lifetime_into_a_moment_straight_away() {
        // A duration only means something when it was received, and this is
        // going into a file to be read back tomorrow.
        let json = r#"{"access_token":"tok","refresh_token":"ref","expires_in":3600}"#;
        let tokens = parse_tokens(json, 1_000_000).expect("parses");
        assert_eq!(tokens.access_token, "tok");
        assert_eq!(tokens.refresh_token, "ref");
        assert_eq!(tokens.expires_at, 1_003_600);
    }

    #[test]
    fn reports_the_reason_a_token_request_was_refused() {
        let json = r#"{"error":"invalid_grant","error_description":"code expired"}"#;
        let why = parse_tokens(json, 0).expect_err("should refuse");
        assert!(why.contains("invalid_grant"));
        assert!(why.contains("code expired"));
    }

    #[test]
    fn a_response_with_no_token_is_a_failure_not_an_empty_success() {
        assert!(parse_tokens(r#"{"token_type":"Bearer"}"#, 0).is_err());
    }

    #[test]
    fn renews_slightly_early_but_not_without_reason() {
        let tokens = Tokens {
            access_token: "t".into(),
            refresh_token: "r".into(),
            expires_at: 1000,
        };
        assert!(!needs_refresh(&tokens, 800));
        // Inside the margin: renewed before it can expire mid-request.
        assert!(needs_refresh(&tokens, 1000 - REFRESH_MARGIN_SECS));
        assert!(needs_refresh(&tokens, 2000));
        // A server that never said when it expires is taken at its word.
        let forever = Tokens {
            access_token: "t".into(),
            expires_at: 0,
            ..Default::default()
        };
        assert!(!needs_refresh(&forever, 999_999));
        // Nothing to refresh.
        assert!(!needs_refresh(&Tokens::default(), 999_999));
    }

    #[test]
    fn registers_as_a_public_client() {
        // Loaf runs on the user's computer and cannot keep a secret. Claiming
        // otherwise would mean shipping one where anyone can read it.
        let body = registration_body("http://127.0.0.1:5599/callback");
        assert_eq!(body["token_endpoint_auth_method"], "none");
        assert_eq!(body["redirect_uris"][0], "http://127.0.0.1:5599/callback");
        assert!(body["grant_types"]
            .as_array()
            .expect("array")
            .iter()
            .any(|g| g == "refresh_token"));
    }

    #[test]
    fn reads_a_client_id_back() {
        let (id, secret) =
            parse_registration(r#"{"client_id":"abc","client_secret":"shh"}"#).expect("parses");
        assert_eq!(id, "abc");
        assert_eq!(secret, "shh");
        // A public client usually gets no secret, which is normal, not a failure.
        let (id2, secret2) = parse_registration(r#"{"client_id":"abc"}"#).expect("parses");
        assert_eq!(id2, "abc");
        assert!(secret2.is_empty());
        assert!(parse_registration(r#"{"error":"no"}"#).is_err());
    }

    #[test]
    fn finds_the_authorization_server_a_resource_points_at() {
        let doc = r#"{"resource":"https://api.example.com/mcp",
                      "authorization_servers":["https://login.example.com"]}"#;
        assert_eq!(
            authorization_server_of(doc).as_deref(),
            Some("https://login.example.com")
        );
        assert!(authorization_server_of(r#"{"resource":"x"}"#).is_none());
    }

    #[test]
    fn the_form_encoder_drops_empties_and_escapes_the_rest() {
        assert_eq!(form(&[("a", "1"), ("b", ""), ("c", "x y")]), "a=1&c=x%20y");
        // Unreserved characters stay as they are; everything else is escaped.
        assert_eq!(
            form(&[("code_verifier", "a-b_c.d~e")]),
            "code_verifier=a-b_c.d~e"
        );
        assert_eq!(form(&[("u", "a/b&c=d")]), "u=a%2Fb%26c%3Dd");
    }

    /// The discovery half, against a provider that really requires a sign-in.
    ///
    ///     cargo test -- --ignored --nocapture discovers_a_real_provider
    ///
    /// Ignored because it needs a network. It signs in to NOTHING and needs no
    /// account: every document it reads is public, and it stops at the point
    /// where a browser would open. That is deliberate — the rest of the flow
    /// cannot be tested without somebody's real credentials, and this covers
    /// everything up to it.
    ///
    /// Notion is used because it is a hosted MCP server that actually
    /// challenges, and because it spells the well-known path the awkward way
    /// round — `/.well-known/oauth-protected-resource/mcp` — which is precisely
    /// the detail `protected_resource_urls` exists to get right.
    #[test]
    #[ignore]
    fn discovers_a_real_provider() {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(20))
            .build();

        // EVERY ENTRY THE CATALOG OFFERS WITH A SIGN-IN BUTTON. A button implies
        // somebody checked, and this is the check: if a provider stops
        // publishing discovery, or starts requiring a client id we cannot get,
        // this fails here rather than for a user who pressed it.
        let providers = [
            ("Notion", "https://mcp.notion.com/mcp"),
            ("Linear", "https://mcp.linear.app/mcp"),
            ("Sentry", "https://mcp.sentry.dev/mcp"),
            ("Asana", "https://mcp.asana.com/sse"),
        ];

        let mut failures = Vec::new();
        for (name, url) in providers {
            let Some(header) = challenge_for(&agent, url) else {
                failures.push(format!("{name}: did not challenge at all"));
                continue;
            };
            match discover(&agent, url, Some(&header)) {
                Ok(server) => {
                    println!("{name}");
                    println!("   authorize: {}", server.authorization_endpoint);
                    println!("   token:     {}", server.token_endpoint);
                    println!("   register:  {}", server.registration_endpoint);
                    if server.authorization_endpoint.is_empty() || server.token_endpoint.is_empty()
                    {
                        failures.push(format!("{name}: missing an endpoint"));
                    }
                    // Without this, Loaf cannot sign in to a provider it has
                    // never met, which is the whole reason registration is part
                    // of the flow.
                    if server.registration_endpoint.is_empty() {
                        failures.push(format!("{name}: will not let programs register themselves"));
                    }
                }
                Err(why) => failures.push(format!("{name}: {why}")),
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn the_landing_page_says_to_go_back_to_loaf() {
        // A blank tab reads as a failure even when everything worked.
        let page = done_page("Signed in");
        assert!(page.contains("Signed in"));
        assert!(page.contains("go back to Loaf"));
    }
}
