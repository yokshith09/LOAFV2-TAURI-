import { describe, it, expect } from "vitest";
import {
  WorkingWatch,
  WORKING_THRESHOLD,
  WORKING_ENTER_SECONDS,
  WORKING_LEAVE_SECONDS,
  WORTH_MENTIONING_SECONDS,
} from "../src/behaviour/working";

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
