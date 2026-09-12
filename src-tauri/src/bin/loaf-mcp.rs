//! The standalone `loaf-mcp` server.
//!
//! Kept as its own binary for anyone who wants to point an assistant straight
//! at it. The implementation is `mcp_stdio` in the library, shared with the
//! main application's `--mcp-server` flag so there is only one server to keep
//! correct.

fn main() {
    loaf_lib::mcp_stdio::serve()
}
