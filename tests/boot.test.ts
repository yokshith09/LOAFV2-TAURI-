import { describe, it, expect } from "vitest";
import {
  report,
  paintProofOfLife,
  installBootGuards,
  watchForTheFirstFrame,
  FRAME_DEADLINE_MS,
  type BootHost,
} from "../src/boot";

/**
 * The boot guard stands between "one line of main.ts threw" and "the window is
 * alive, completely blank, and nobody can tell why". It is worth testing
 * carefully, because the failure it exists to catch is the one failure that
 * leaves no evidence at all.
 */

interface Recorded {
  sent: { cmd: string; args: unknown }[];
  logged: string[];
  timers: (() => void)[];
  listeners: Record<string, ((e: unknown) => void)[]>;
  canvas: FakeCanvas | null;
  ops: string[];
}

interface FakeCanvas {
  width: number;
  height: number;
  style: { width: string; height: string };
  getContext: (kind: string) => unknown;
}

function fakeCanvas(rec: Recorded, withContext = true): FakeCanvas {
  const ctx = {
    save: () => rec.ops.push("save"),
    restore: () => rec.ops.push("restore"),
    scale: (x: number) => rec.ops.push(`scale:${x}`),
    beginPath: () => rec.ops.push("beginPath"),
    roundRect: () => rec.ops.push("roundRect"),
    rect: () => rec.ops.push("rect"),
    fill: () => rec.ops.push("fill"),
    fillText: (t: string) => rec.ops.push(`text:${t}`),
    fillStyle: "",
    font: "",
    textAlign: "",
  };
  return {
    width: 300,
    height: 150,
    style: { width: "", height: "" },
    getContext: () => (withContext ? ctx : null),
  };
}

function host(over: Partial<BootHost> = {}, rec?: Recorded): BootHost & { rec: Recorded } {
  const r: Recorded = rec ?? {
    sent: [],
    logged: [],
    timers: [],
    listeners: {},
    canvas: null,
    ops: [],
  };
  r.canvas = r.canvas ?? fakeCanvas(r);
  const h: BootHost = {
    getElementById: (id) => (id === "stage" ? r.canvas : null),
    devicePixelRatio: 2,
    innerWidth: 134,
    innerHeight: 150,
    invoke: (cmd, args) => {
      r.sent.push({ cmd, args });
      return Promise.resolve();
    },
    addEventListener: (type, fn) => {
      (r.listeners[type] ??= []).push(fn);
    },
    setTimeout: (fn) => {
      r.timers.push(fn);
    },
    drewFlag: () => false,
    log: (m) => r.logged.push(m),
    ...over,
  };
  return Object.assign(h, { rec: r });
}

describe("proof of life", () => {
  it("sizes the canvas rather than leaving it at the default 300x150", () => {
    const h = host();
    paintProofOfLife(h);
    // 134 x 150 at a device pixel ratio of 2.
    expect(h.rec.canvas!.width).toBe(268);
    expect(h.rec.canvas!.height).toBe(300);
    expect(h.rec.canvas!.style.width).toBe("134px");
  });

  it("actually paints something", () => {
    const h = host();
    paintProofOfLife(h);
    expect(h.rec.ops).toContain("fill");
    expect(h.rec.ops.join(",")).toContain("text:loading");
  });

  it("falls back to rect where roundRect does not exist", () => {
    const rec: Recorded = { sent: [], logged: [], timers: [], listeners: {}, canvas: null, ops: [] };
    const ctx: Record<string, unknown> = {
      save: () => rec.ops.push("save"),
      restore: () => {},
      scale: () => {},
      beginPath: () => {},
      rect: () => rec.ops.push("rect"),
      fill: () => {},
      fillText: () => {},
    };
    rec.canvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
      getContext: () => ctx,
    };
    paintProofOfLife(host({}, rec));
    expect(rec.ops).toContain("rect");
  });

  it("uses sensible sizes when the window reports none", () => {
    const h = host({ innerWidth: 0, innerHeight: 0, devicePixelRatio: 0 });
    paintProofOfLife(h);
    expect(h.rec.canvas!.width).toBe(134);
    expect(h.rec.canvas!.height).toBe(150);
  });

  it("says so if there is no canvas at all", () => {
    const h = host({ getElementById: () => null });
    paintProofOfLife(h);
    expect(JSON.stringify(h.rec.sent)).toContain("#stage");
  });

  it("says so if the 2d context is unavailable", () => {
    const rec: Recorded = { sent: [], logged: [], timers: [], listeners: {}, canvas: null, ops: [] };
    rec.canvas = fakeCanvas(rec, false);
    const h = host({}, rec);
    paintProofOfLife(h);
    expect(JSON.stringify(h.rec.sent)).toContain("getContext");
  });
});

describe("reporting", () => {
  it("forwards an uncaught error to the terminal", () => {
    const h = host();
    installBootGuards(h);
    h.rec.listeners.error![0]!({ error: new Error("kaboom") });
    expect(JSON.stringify(h.rec.sent)).toContain("kaboom");
  });

  it("uses message and location when there is no Error object", () => {
    const h = host();
    installBootGuards(h);
    h.rec.listeners.error![0]!({ message: "oops", filename: "main.ts", lineno: 42 });
    const said = JSON.stringify(h.rec.sent);
    expect(said).toContain("oops");
    expect(said).toContain("main.ts");
    expect(said).toContain("42");
  });

  it("forwards an unhandled promise rejection", () => {
    const h = host();
    installBootGuards(h);
    h.rec.listeners.unhandledrejection![0]!({ reason: new Error("nope") });
    expect(JSON.stringify(h.rec.sent)).toContain("nope");
  });

  it("survives a rejection reason that is not an Error", () => {
    const h = host();
    installBootGuards(h);
    expect(() => h.rec.listeners.unhandledrejection![0]!({ reason: "just a string" })).not.toThrow();
    expect(JSON.stringify(h.rec.sent)).toContain("just a string");
  });

  // This runs inside an error handler. A reporter that can throw turns one
  // broken thing into two and loses the original message.
  it("cannot throw when there is no bridge", () => {
    const h = host({ invoke: undefined });
    expect(() => report(h, "x", "y")).not.toThrow();
  });

  it("cannot throw when the bridge throws", () => {
    const h = host({
      invoke: () => {
        throw new Error("bridge is broken");
      },
    });
    expect(() => report(h, "x", "y")).not.toThrow();
  });

  it("cannot throw when the bridge returns something that is not a promise", () => {
    const h = host({ invoke: () => 42 });
    expect(() => report(h, "x", "y")).not.toThrow();
  });

  it("always logs, even with no bridge at all", () => {
    const h = host({ invoke: undefined });
    report(h, "boot", "something");
    expect(h.rec.logged.join()).toContain("something");
  });

  it("truncates a huge detail rather than filling a terminal", () => {
    const h = host();
    report(h, "big", "x".repeat(10_000));
    const sent = h.rec.sent[0]!.args as { detail: string };
    expect(sent.detail.length).toBe(4000);
  });
});

describe("the render loop never starting", () => {
  it("complains when no frame ever arrived", () => {
    const h = host({ drewFlag: () => false });
    watchForTheFirstFrame(h);
    h.rec.timers[0]!();
    expect(JSON.stringify(h.rec.sent)).toContain("render loop");
  });

  it("stays quiet when a frame did arrive", () => {
    const h = host({ drewFlag: () => true });
    watchForTheFirstFrame(h);
    h.rec.timers[0]!();
    expect(JSON.stringify(h.rec.sent)).not.toContain("render loop");
  });

  it("waits long enough for a slow first frame", () => {
    expect(FRAME_DEADLINE_MS).toBeGreaterThanOrEqual(2000);
  });
});

/**
 * The mark on screen is the fourth reporting channel, and the only one that
 * assumes nothing. stderr assumed a terminal, the notification assumed macOS
 * permission, the file assumed somebody goes looking. A tester sends a
 * screenshot — so the thing they photograph has to carry the answer.
 */
describe("the mark names which failure it was", () => {
  it("says no host when the bridge is missing", () => {
    const h = host({ invoke: undefined, drewFlag: () => false });
    installBootGuards(h);
    h.rec.ops.length = 0;
    h.rec.timers[0]!();
    expect(h.rec.ops.join(",")).toContain("text:no host");
  });

  it("says error when something threw", () => {
    const h = host({ drewFlag: () => false });
    installBootGuards(h);
    h.rec.listeners.error![0]!({ error: new Error("kaboom") });
    h.rec.ops.length = 0;
    h.rec.timers[0]!();
    expect(h.rec.ops.join(",")).toContain("text:error");
  });

  it("says stalled when the bridge is fine and nothing threw", () => {
    const h = host({ drewFlag: () => false });
    installBootGuards(h);
    h.rec.ops.length = 0;
    h.rec.timers[0]!();
    expect(h.rec.ops.join(",")).toContain("text:stalled");
  });

  // A working build must never repaint over the cat.
  it("repaints nothing at all once a frame has drawn", () => {
    const h = host({ drewFlag: () => true });
    installBootGuards(h);
    h.rec.ops.length = 0;
    h.rec.timers[0]!();
    expect(h.rec.ops).toEqual([]);
  });
});

describe("installBootGuards", () => {
  it("listens for both kinds of failure and paints, in one call", () => {
    const h = host();
    installBootGuards(h);
    expect(Object.keys(h.rec.listeners).sort()).toEqual(["error", "unhandledrejection"]);
    expect(h.rec.ops).toContain("fill");
    expect(h.rec.timers.length).toBe(1);
  });
});
