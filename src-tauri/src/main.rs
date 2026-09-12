// Prevents an extra console window on Windows in release. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // SERVING MCP INSTEAD OF SHOWING A PET.
    //
    // Claude Desktop starts an MCP server as a child process, so it needs a
    // program on disk to point at. The obvious candidate — the `loaf-mcp`
    // binary — is not in the installer, so on a real machine it does not exist.
    // Rather than add a second shipped artifact and the build plumbing to keep
    // it in step, the installed application answers to a flag: the config points
    // at the app the user already has.
    //
    // Checked before anything else runs. Tauri is never built, no window is
    // created, and this returns only when the assistant closes the pipe.
    //
    // The GUI subsystem does not prevent this on Windows: the flag governs
    // whether a console is ALLOCATED, while `stdin`/`stdout` here are the pipe
    // handles the parent passed in, which are inherited either way.
    if std::env::args().skip(1).any(|a| a == "--mcp-server") {
        loaf_lib::mcp_stdio::serve();
        return;
    }
    loaf_lib::run()
}
