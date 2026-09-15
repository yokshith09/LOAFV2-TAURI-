import { describe, it, expect } from "vitest";
import {
  WorkingWatch,
  WORKING_THRESHOLD,
  WORKING_ENTER_SECONDS,
  WORKING_LEAVE_SECONDS,
  WORTH_MENTIONING_SECONDS,
} from "../src/behaviour/working";
import {
  claudeAskedLine,
  claudeDoneLine,
  claudeStatusLine,
  isTerminalStatus,
  statusReadsAsGoodNews,
} from "../src/bubble/prompts";

/**
 * Feed a constant reading for a number of seconds, one tick per 0.5s.
 *
 * `justFinished` is set on exactly ONE tick, which is rarely the last one, so
 * the helper carries it out rather than letting it be missed.
 */
function run(w: WorkingWatch, cpu: number | null, seconds: number) {
  let last = w.tick(cpu, 0.5);
  let finished = last.justFinished;
  for (let t = 0.5; t < seconds; t += 0.5) {
    last = w.tick(cpu, 0.5);
    if (last.justFinished !== null) finished = last.justFinished;
  }
  return { ...last, justFinished: finished };
}

describe("WorkingWatch", () => {
  it("starts idle", () => {
    expect(new WorkingWatch().busy).toBe(false);
  });

  it("does not react to a brief spike", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS - 1);
    expect(w.busy).toBe(false);
  });

  it("settles into working once the load is sustained", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS + 1);
    expect(w.busy).toBe(true);
  });

  it("ignores an editor idling noisily", () => {
    const w = new WorkingWatch();
    run(w, WORKING_THRESHOLD - 15, 30);
    expect(w.busy).toBe(false);
  });

  // A compiler that drops to 20% between stages has not finished.
  it("rides out a dip in the middle of real work", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS + 1);
    run(w, 10, WORKING_LEAVE_SECONDS - 1);
    expect(w.busy).toBe(true);
    run(w, 95, 2);
    expect(w.busy).toBe(true);
  });

  it("stops once the load is really gone", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS + 1);
    run(w, 5, WORKING_LEAVE_SECONDS + 2);
    expect(w.busy).toBe(false);
  });

  it("reports how long the stretch ran, once, when it ends", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS + 60);
    const ending = run(w, 0, WORKING_LEAVE_SECONDS + 1);
    expect(ending.justFinished).not.toBeNull();
    expect(ending.justFinished!).toBeGreaterThan(50);
    // Exactly one tick carries it.
    expect(w.tick(0, 0.5).justFinished).toBeNull();
  });

  it("counts how long it has been busy", () => {
    const w = new WorkingWatch();
    const s = run(w, 95, WORKING_ENTER_SECONDS + 20);
    expect(s.forSeconds).toBeGreaterThan(15);
    expect(s.busy).toBe(true);
  });

  // "No idea" must not be read as "not busy", but it cannot hold a pose for
  // ever either — it decays out at the ordinary leaving rate.
  it("leaves the pose when the OS stops answering", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS + 5);
    expect(w.busy).toBe(true);
    run(w, null, WORKING_LEAVE_SECONDS + 1);
    expect(w.busy).toBe(false);
  });

  it("never enters the pose on an unanswered probe alone", () => {
    const w = new WorkingWatch();
    run(w, null, 60);
    expect(w.busy).toBe(false);
  });

  it("stands still when no time has passed", () => {
    const w = new WorkingWatch();
    expect(w.tick(100, 0).busy).toBe(false);
  });

  it("can be reset", () => {
    const w = new WorkingWatch();
    run(w, 95, WORKING_ENTER_SECONDS + 5);
    w.reset();
    expect(w.busy).toBe(false);
  });

  it("is harder to enter than to leave is to trigger", () => {
    // Leaving takes longer than entering: work is bursty, flicker is worse.
    expect(WORKING_LEAVE_SECONDS).toBeGreaterThan(WORKING_ENTER_SECONDS);
  });

  it("has a floor below which a job is not worth remarking on", () => {
    expect(WORTH_MENTIONING_SECONDS).toBeGreaterThan(10);
  });
});

describe("what Loaf says when Claude asks it something", () => {
  it("names the question rather than saying something happened", () => {
    // Which question was asked is the disclosure. "Something happened" is not.
    expect(claudeAskedLine("screen_time_today")).toContain("today");
    expect(claudeAskedLine("top_apps")).toContain("been in");
    expect(claudeAskedLine("meetings")).toContain("meetings");
  });

  it("still says something for a tool it has never heard of", () => {
    // A newer server talking to an older companion. Silence would read as Loaf
    // not noticing at all.
    const line = claudeAskedLine("some_tool_added_later");
    expect(line).toContain("Claude");
    expect(line.length).toBeGreaterThan(0);
  });

  it("always names Claude, so it is never mistaken for Loaf itself", () => {
    for (const tool of ["screen_time_today", "top_apps", "meetings", "unknown"]) {
      expect(claudeAskedLine(tool)).toContain("Claude");
    }
  });
});

describe("what Loaf says when Claude finishes", () => {
  it("always names Claude and never repeats forever", () => {
    // This fires after every piece of work, so one fixed sentence becomes
    // wallpaper within a day.
    const lines = new Set<string>();
    for (let t = 0; t < 8000; t += 1000) lines.add(claudeDoneLine(t));
    expect(lines.size).toBeGreaterThan(1);
    for (const line of lines) expect(line).toContain("Claude");
  });

  it("is stable within the same second, so a re-render does not reword it", () => {
    expect(claudeDoneLine(5_000)).toBe(claudeDoneLine(5_400));
  });
});

// The fixed enum `report_status` accepts, in src-tauri/src/mcp_stdio.rs's
// STATUS_KINDS — kept here rather than imported, since one is Rust and one is
// TypeScript, the same way sounds.rs's OCCASIONS is kept in step with
// voice.ts by a comment rather than a shared import.
const ALL_STATUS_KINDS = [
  "thinking",
  "working",
  "build_passed",
  "build_failed",
  "checks_passed",
  "checks_failed",
  "pushed",
  "deploy_succeeded",
  "deploy_failed",
  "done",
] as const;

describe("what Loaf says for a dev-workflow status report", () => {
  it("has a real line for every status the MCP tool actually accepts", () => {
    for (const status of ALL_STATUS_KINDS) {
      const line = claudeStatusLine(status);
      expect(line.length).toBeGreaterThan(0);
      // "done" rotates through claudeDoneLine's own wording rather than
      // repeating "Claude"; every other status is its own short sentence.
      if (status !== "done") expect(line.toLowerCase()).not.toContain("does not recognise");
    }
  });

  it("still says something for a status this build has never heard of", () => {
    // An older companion talking to a newer server that added one.
    const line = claudeStatusLine("shipped_to_the_moon");
    expect(line.length).toBeGreaterThan(0);
  });

  it("sorts passing/pushing/deploying/finishing as good news, failing as bad", () => {
    for (const good of ["build_passed", "checks_passed", "pushed", "deploy_succeeded", "done"]) {
      expect(isTerminalStatus(good)).toBe(true);
      expect(statusReadsAsGoodNews(good)).toBe(true);
    }
    for (const bad of ["build_failed", "checks_failed", "deploy_failed"]) {
      expect(isTerminalStatus(bad)).toBe(true);
      expect(statusReadsAsGoodNews(bad)).toBe(false);
    }
  });

  it("treats thinking and working as ongoing, not a finished result", () => {
    // These get the same "still busy" pose "asked" already uses, not a
    // proud or worried flash — nothing has concluded yet.
    expect(isTerminalStatus("thinking")).toBe(false);
    expect(isTerminalStatus("working")).toBe(false);
  });
});
