import { describe, it, expect } from "vitest";

/**
 * Every command Rust exposes has somebody who calls it.
 *
 * THE BUG THIS EXISTS FOR. `dictate_once` was written, registered in
 * `generate_handler!`, documented at length as "the path that makes choosing
 * Whisper mean anything" — and invoked by nothing at all. Dictation went to
 * Windows' voice-typing bar the whole time, which on a Mac meant a message
 * saying dictation was not available. The comment at the one place that should
 * have called it described the fix as already made.
 *
 * WHY NOTHING NOTICED. A Tauri command is reached by name, from TypeScript, at
 * runtime. There is no reference for the Rust compiler to miss and no import
 * for the TypeScript compiler to check. It compiles, it registers, it appears
 * in the handler list, and it is dead. Nothing in either language's type system
 * connects the two halves — the string is the only link, and a string that is
 * never written is not an error anywhere.
 *
 * So the link is checked here. The names come out of `generate_handler!`, the
 * call sites out of every `.ts` file, and a name with no call site fails.
 *
 * WHAT A FAILURE MEANS is one of three things, and they need different fixes:
 * the feature was never wired up (this bug), the caller was removed and the
 * command should go too, or it is genuinely called some other way — in which
 * case add it to `CALLED_ELSEWHERE` below with the reason, so the exception is
 * a decision somebody made rather than a hole.
 */

/**
 * Commands reached some other way than `invoke("name")`.
 *
 * Empty, and it should stay that way. Anything added here needs a sentence
 * saying who calls it instead — a list of unexplained exceptions is how a
 * check like this stops meaning anything.
 */
const CALLED_ELSEWHERE: Record<string, string> = {};

/**
 * Built, registered, and not wired to anything yet.
 *
 * THIS LIST IS THE FINDING, NOT THE EXCEPTION. Writing this check turned up
 * nine dead commands where one was expected, which says the problem is a habit
 * rather than an oversight: work lands in Rust, the milestone is called done,
 * and the half that would let somebody actually use it is never written. From
 * the outside that is indistinguishable from a feature that does not work.
 *
 * Each entry says what it would take to finish it. The list is allowed to
 * shrink and nothing else — a name that appears here for the first time is a
 * new dead feature, and the test below fails on it.
 */
const NOT_WIRED_YET: Record<string, string> = {
  // M4 built a native text-to-speech path — `say` on macOS, System.Speech on
  // Windows — while `voice/speak.ts` was already speaking through the WebView's
  // own synthesiser, which is the deliberate design: no native code, no
  // permission, no platform branch. So this is a spare, not a gap. It stays
  // registered until somebody with a Mac can say whether WKWebView really does
  // offer local voices there; if it does, `speak.rs` should be deleted rather
  // than wired, and if it does not, this is the fix already written.
  speak: "duplicate of voice/speak.ts, kept until macOS voices are confirmed",
  stop_speaking: "same as speak",
  can_speak: "same as speak",

  // M3 built the SQLite store and wired the parts the dashboard reads —
  // searching, deleting, exporting. These three are the write and preview half
  // and have no caller: meetings and lines still go to browser storage, which
  // is the thing M3 existed to stop.
  store_meetings: "M3 write path — the dashboard still reads meetings from browser storage",
  store_add_line: "M3 write path — nothing puts transcript lines in the store yet",
  store_preview_range: "M3 — the delete-range screen shows its own count instead",

  // Status the frontend keeps for itself instead of asking Rust, which is fine
  // until the two disagree — and the wake session can be stopped by the OS
  // without the frontend hearing about it, which is exactly that case.
  recording_seconds: "the frontend counts its own recording time",
  wake_listening: "the frontend tracks wakeRunning itself; see the Completed handler in wake.rs",
};

const rust = import.meta.glob<string>("../src-tauri/src/lib.rs", {
  query: "?raw",
  import: "default",
  eager: true,
});

const frontend = import.meta.glob<string>("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The names inside `tauri::generate_handler![ ... ]`. */
function registeredCommands(source: string): string[] {
  const start = source.indexOf("generate_handler![");
  if (start === -1) return [];
  const end = source.indexOf("]", start);
  if (end === -1) return [];
  return source
    .slice(start + "generate_handler![".length, end)
    .split(",")
    .map((line) => line.replace(/\/\/.*$/gm, "").trim())
    // Commands can be registered through their module path.
    .map((name) => name.split("::").pop() ?? name)
    .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name));
}

describe("every Rust command is reachable from the app", () => {
  const source = Object.values(rust)[0];
  const commands = source ? registeredCommands(source) : [];
  const allFrontend = Object.values(frontend).join("\n");

  // A parse that quietly found nothing would turn this whole file into a test
  // that passes because it checked nothing, which is the failure it is about.
  it("read the handler list", () => {
    expect(commands.length).toBeGreaterThan(40);
    expect(commands).toContain("platform_name");
    expect(commands).toContain("dictate_once");
  });

  it("found the frontend to search", () => {
    expect(Object.keys(frontend).length).toBeGreaterThan(10);
  });

  it("has no NEW command that nothing calls", () => {
    const orphans = commands.filter(
      (name) =>
        !CALLED_ELSEWHERE[name] &&
        !NOT_WIRED_YET[name] &&
        !allFrontend.includes(`"${name}"`),
    );
    expect(orphans).toEqual([]);
  });

  // The list of known-dead commands must only ever shrink. Once something is
  // wired up, its entry has to go, or the next reader believes a feature is
  // still missing when it is not.
  it("has no entry in the not-wired list that is now wired", () => {
    const done = Object.keys(NOT_WIRED_YET).filter((name) => allFrontend.includes(`"${name}"`));
    expect(done).toEqual([]);
  });

  // Guards against the opposite rot: a command deleted from Rust but still
  // listed here, which would make the list read as a longer backlog than it is.
  it("has no entry in the not-wired list that no longer exists", () => {
    const gone = Object.keys(NOT_WIRED_YET).filter((name) => !commands.includes(name));
    expect(gone).toEqual([]);
  });

  // The exception list is the part that rots. If a name in it starts being
  // called normally, the note beside it is now describing something untrue.
  it("has no stale exceptions", () => {
    const unnecessary = Object.keys(CALLED_ELSEWHERE).filter((name) =>
      allFrontend.includes(`"${name}"`),
    );
    expect(unnecessary).toEqual([]);
  });
});

describe("reading the handler list", () => {
  it("takes the names between the brackets", () => {
    expect(registeredCommands("x.invoke_handler(tauri::generate_handler![a, b, c])")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("copes with one per line and a trailing comma", () => {
    expect(registeredCommands("generate_handler![\n  one,\n  two,\n]")).toEqual(["one", "two"]);
  });

  it("ignores a commented-out command", () => {
    expect(registeredCommands("generate_handler![\n  one, // two,\n  three,\n]")).toEqual([
      "one",
      "three",
    ]);
  });

  it("takes the last segment of a module path", () => {
    expect(registeredCommands("generate_handler![store::search, one]")).toEqual(["search", "one"]);
  });

  it("returns nothing rather than guessing when there is no handler list", () => {
    expect(registeredCommands("fn main() {}")).toEqual([]);
  });
});
