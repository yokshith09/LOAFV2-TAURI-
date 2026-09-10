//! Talking to an MCP server that is not a program on this machine.
//!
//! WHY THIS HAD TO EXIST. Loaf's client could only ever start a child process
//! and pipe to its stdin. That is one of the two transports MCP defines, and it
//! is the one that cannot be set up by an ordinary person: every server has to
//! be installed first, and its credentials have to be typed into a config file
//! as environment variables. That is the whole reason "just select Gmail" was
//! impossible — not a missing entry in a list.
//!
//! The other transport is **Streamable HTTP**: one URL, a POST per message, and
//! the server may answer either with a plain JSON body or with an SSE stream of
//! them. Nothing is installed, and authorisation is a header rather than a file.
//! That is the transport every hosted connector uses, and it is the one that
//! makes a browser sign-in possible.
//!
//! WHAT IS IN HERE IS THE PART THAT CAN BE WRONG QUIETLY. The POST itself is
//! four lines of `ureq`; the interesting work is reading the answer back:
//!
//!  - A response may be a bare JSON-RPC object, or an SSE stream where each
//!    message arrives as one or more `data:` lines. The same request can get
//!    either, depending on the server and the moment.
//!  - A stream may carry notifications and unrelated responses before the one
//!    that was asked for, so the FIRST message is not the answer — matching on
//!    the id is the only correct rule, exactly as the stdio path already does.
//!  - A session id comes back in a header on the first call and has to be sent
//!    on every call after it, or the server treats each request as a new client.
//!
//! Each of those is a pure function with tests, because getting any of them
//! subtly wrong produces "the server did not answer" for a server that answered
//! perfectly.

/// The header a server uses to hand back a session id, and to be given it.
pub const SESSION_HEADER: &str = "Mcp-Session-Id";

/// What a transport should ask for in return.
///
/// Both, deliberately. The specification allows the server to choose, so a
/// client that accepted only one would work against some servers and not
/// others — and the difference would show up as a connection that never answers
/// rather than as a refusal.
pub const ACCEPT: &str = "application/json, text/event-stream";

/// Whether a spec names a remote server or a local program.
///
/// A URL wins when both are present rather than being an error. A config with
/// both is a config somebody edited, and guessing the remote one is the
/// recoverable guess: it cannot start a process on their machine.
pub fn is_remote(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

/// Refuse a URL that is not one, before anything is sent anywhere.
///
/// `http://` is allowed rather than refused, because a local server on
/// `http://127.0.0.1` is a normal way to run one during development — but it is
/// named as plain text in the panel so nobody connects to a remote one by
/// accident over it.
pub fn check_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("There is no address to connect to.".into());
    }
    if !is_remote(trimmed) {
        return Err("A remote connection needs an address starting with https://".into());
    }
    if trimmed.len() < "https://a.b".len() {
        return Err("That address is too short to be a real one.".into());
    }
    Ok(())
}

/// Whether the body that came back is an SSE stream rather than a JSON object.
///
/// Read off the content type rather than sniffed from the body: a JSON object
/// whose first field happened to be a string starting with "data" is not an
/// event stream, and guessing from the bytes would make that a connection bug
/// nobody could reproduce.
pub fn is_event_stream(content_type: Option<&str>) -> bool {
    content_type
        .map(|t| t.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false)
}

/// Every JSON payload carried in an SSE body, in order.
///
/// SSE framing, only as much as MCP uses: events are separated by a blank line,
/// and the payload is the `data:` lines of an event joined with newlines. Other
/// fields — `event:`, `id:`, `retry:` — are skipped rather than parsed, because
/// MCP does not give them meaning here and inventing one would be guessing.
///
/// A line without a colon, or any field that is not `data`, is ignored. Comment
/// lines beginning with a colon are the keep-alive heartbeat and must be
/// ignored rather than treated as an empty message, or a quiet stream looks
/// like a stream of blanks.
pub fn payloads_in_stream(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for raw in body.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            if !current.is_empty() {
                out.push(current.join("\n"));
                current.clear();
            }
            continue;
        }
        if line.starts_with(':') {
            continue; // heartbeat
        }
        if let Some(rest) = line.strip_prefix("data:") {
            // One optional space after the colon is part of the framing, not
            // the payload. Any further whitespace is the payload's own.
            current.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if !current.is_empty() {
        out.push(current.join("\n"));
    }
    out
}

/// The JSON-RPC reply with this id, out of whatever came back.
///
/// THE ID IS THE ONLY CORRECT RULE. A stream may carry notifications, log
/// messages and replies to other requests before the one that was asked for.
/// Taking the first message would read a notification as an answer, which is
/// the same bug the stdio path was written to avoid and is much easier to hit
/// here, because a stream is where servers put their progress updates.
///
/// Returns Ok(None) when nothing in the body is the reply, so the caller can
/// tell "answered with something else" apart from "answered with an error".
pub fn reply_with_id(
    body: &str,
    content_type: Option<&str>,
    id: i64,
) -> Result<Option<serde_json::Value>, String> {
    let candidates: Vec<String> = if is_event_stream(content_type) {
        payloads_in_stream(body)
    } else {
        vec![body.to_string()]
    };

    for payload in candidates {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        // A server may batch replies into one JSON array.
        let messages: Vec<serde_json::Value> = match value {
            serde_json::Value::Array(items) => items,
            other => vec![other],
        };
        for message in messages {
            if message.get("id").and_then(serde_json::Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let text = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("the server refused");
                return Err(text.to_string());
            }
            return Ok(Some(message.get("result").cloned().unwrap_or_default()));
        }
    }
    Ok(None)
}

/// What to say when a remote server answers with an HTTP error.
///
/// 401 and 403 are named specially because they are the ones a user can do
/// something about, and because they are what an expired or missing token looks
/// like — the single most likely failure for a connection that worked
/// yesterday. Everything else gets the code, which is more use than "it failed".
pub fn http_failure(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    let tail = if trimmed.is_empty() {
        String::new()
    } else {
        let short: String = trimmed.chars().take(200).collect();
        format!(" — {short}")
    };
    match status {
        401 => format!("That server refused the sign-in (401). The token may have expired{tail}"),
        403 => format!("That server allows the sign-in but not this request (403){tail}"),
        404 => format!("There is nothing at that address (404){tail}"),
        status if status >= 500 => format!("That server had a problem ({status}){tail}"),
        status => format!("That server refused the request ({status}){tail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_means_remote_and_a_command_does_not() {
        assert!(is_remote("https://example.com/mcp"));
        assert!(is_remote("http://127.0.0.1:3000/mcp"));
        assert!(!is_remote("npx"));
        assert!(!is_remote(""));
        assert!(!is_remote("  "));
    }

    #[test]
    fn leading_space_does_not_hide_a_url() {
        assert!(is_remote("  https://example.com/mcp"));
    }

    #[test]
    fn a_url_that_is_not_one_is_refused_before_anything_is_sent() {
        assert!(check_url("").is_err());
        assert!(check_url("example.com").is_err());
        assert!(check_url("ftp://example.com").is_err());
        assert!(check_url("https://a").is_err());
        assert!(check_url("https://example.com/mcp").is_ok());
    }

    #[test]
    fn the_content_type_decides_whether_it_is_a_stream() {
        assert!(is_event_stream(Some("text/event-stream")));
        assert!(is_event_stream(Some("text/event-stream; charset=utf-8")));
        assert!(is_event_stream(Some("TEXT/EVENT-STREAM")));
        assert!(!is_event_stream(Some("application/json")));
        assert!(!is_event_stream(None));
    }

    #[test]
    fn reads_one_event_out_of_a_stream() {
        assert_eq!(payloads_in_stream("data: {\"a\":1}\n\n"), vec!["{\"a\":1}"]);
    }

    #[test]
    fn reads_several_events_in_order() {
        let body = "data: one\n\ndata: two\n\ndata: three\n\n";
        assert_eq!(payloads_in_stream(body), vec!["one", "two", "three"]);
    }

    #[test]
    fn joins_a_payload_split_over_several_data_lines() {
        let body = "data: {\ndata: \"a\": 1\ndata: }\n\n";
        assert_eq!(payloads_in_stream(body), vec!["{\n\"a\": 1\n}"]);
    }

    // A line that does not begin with `data:` is not a data field, and a
    // leading space makes it one of those. Written down because the first
    // version of the test above had exactly that typo and blamed the code.
    #[test]
    fn an_indented_line_is_not_a_data_field() {
        assert_eq!(
            payloads_in_stream("data: kept\n not-a-field\n\n"),
            vec!["kept"]
        );
    }

    #[test]
    fn ignores_the_fields_mcp_gives_no_meaning_to() {
        let body = "event: message\nid: 7\nretry: 100\ndata: {\"a\":1}\n\n";
        assert_eq!(payloads_in_stream(body), vec!["{\"a\":1}"]);
    }

    // A quiet stream sends colon-prefixed comments to stay alive. Reading one
    // as an empty message makes an idle connection look like a broken one.
    #[test]
    fn ignores_the_keep_alive_heartbeat() {
        assert_eq!(
            payloads_in_stream(": ping\n\n: ping\n\n"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn copes_with_windows_line_endings() {
        assert_eq!(
            payloads_in_stream("data: {\"a\":1}\r\n\r\n"),
            vec!["{\"a\":1}"]
        );
    }

    #[test]
    fn takes_a_last_event_with_no_trailing_blank_line() {
        assert_eq!(payloads_in_stream("data: alone"), vec!["alone"]);
    }

    #[test]
    fn an_empty_body_carries_nothing() {
        assert_eq!(payloads_in_stream(""), Vec::<String>::new());
    }

    #[test]
    fn finds_the_reply_in_a_plain_json_body() {
        let body = r#"{"jsonrpc":"2.0","id":4,"result":{"ok":true}}"#;
        let got = reply_with_id(body, Some("application/json"), 4)
            .unwrap()
            .unwrap();
        assert_eq!(got["ok"], serde_json::json!(true));
    }

    #[test]
    fn finds_the_reply_in_a_stream() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"ok\":1}}\n\n";
        let got = reply_with_id(body, Some("text/event-stream"), 9)
            .unwrap()
            .unwrap();
        assert_eq!(got["ok"], serde_json::json!(1));
    }

    // The bug this rule exists for: a progress notification arriving first.
    #[test]
    fn skips_whatever_came_before_the_answer() {
        let body = concat!(
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"wrong\":true}}\n\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"right\":true}}\n\n",
        );
        let got = reply_with_id(body, Some("text/event-stream"), 2)
            .unwrap()
            .unwrap();
        assert_eq!(got["right"], serde_json::json!(true));
        assert!(got.get("wrong").is_none());
    }

    #[test]
    fn reads_a_reply_out_of_a_batched_array() {
        let body = r#"[{"jsonrpc":"2.0","id":1,"result":{"a":1}},{"jsonrpc":"2.0","id":2,"result":{"b":2}}]"#;
        let got = reply_with_id(body, Some("application/json"), 2)
            .unwrap()
            .unwrap();
        assert_eq!(got["b"], serde_json::json!(2));
    }

    #[test]
    fn an_error_reply_becomes_an_error() {
        let body = r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"no such tool"}}"#;
        let err = reply_with_id(body, Some("application/json"), 3).unwrap_err();
        assert!(err.contains("no such tool"));
    }

    #[test]
    fn an_error_with_no_message_still_says_something() {
        let body = r#"{"jsonrpc":"2.0","id":3,"error":{"code":-1}}"#;
        assert!(reply_with_id(body, None, 3).is_err());
    }

    #[test]
    fn nothing_for_us_is_none_rather_than_an_error() {
        let body = r#"{"jsonrpc":"2.0","id":99,"result":{}}"#;
        assert_eq!(
            reply_with_id(body, Some("application/json"), 1).unwrap(),
            None
        );
    }

    #[test]
    fn unparseable_rubbish_is_not_the_answer() {
        assert_eq!(reply_with_id("<html>no</html>", None, 1).unwrap(), None);
    }

    #[test]
    fn a_result_that_is_missing_is_an_empty_one_rather_than_a_failure() {
        let body = r#"{"jsonrpc":"2.0","id":5}"#;
        assert_eq!(
            reply_with_id(body, None, 5).unwrap(),
            Some(serde_json::Value::Null)
        );
    }

    #[test]
    fn a_sign_in_failure_says_so_in_words() {
        assert!(http_failure(401, "").contains("sign-in"));
        assert!(http_failure(403, "").contains("not this request"));
        assert!(http_failure(404, "").contains("nothing at that address"));
        assert!(http_failure(500, "").contains("had a problem"));
        assert!(http_failure(418, "").contains("418"));
    }

    #[test]
    fn the_servers_own_words_are_included_but_bounded() {
        let long = "x".repeat(1_000);
        let said = http_failure(400, &long);
        assert!(said.chars().count() < 300);
    }

    #[test]
    fn an_empty_body_adds_no_dash() {
        assert!(!http_failure(400, "   ").contains('—'));
    }
}
