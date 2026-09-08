import { describe as group, it, expect } from "vitest";
import { findEarlyReads, describe as explain } from "./helpers/tdz";

/**
 * The check that would have caught the invisible pet on the day it was written.
 *
 * Two halves, and both are needed. The samples prove the checker can actually
 * fail — a guard that passes on the broken code is worse than none, because it
 * says the thing is safe. The sweep over `src/` is the guard itself.
 */

group("it recognises the bug it was written for", () => {
  // This is the real shape from main.ts, reduced to five lines.
  it("catches a hoisted function reading a const declared below the caller", () => {
    const found = findEarlyReads(`
      let memory = fromJSON(readGraph());
      const K_GRAPH = "memory.graph";
      function readGraph() { return localStorage.getItem(K_GRAPH); }
    `);
    expect(found.map((t) => t.name)).toContain("K_GRAPH");
  });

  it("follows a call through a second function", () => {
    const found = findEarlyReads(`
      const value = outer();
      function outer() { return inner(); }
      function inner() { return LATER; }
      const LATER = 1;
    `);
    expect(found[0]!.through).toEqual(["outer", "inner"]);
  });

  it("catches a bare call, not only a variable initializer", () => {
    const found = findEarlyReads(`
      start();
      function start() { console.log(NAME); }
      const NAME = "loaf";
    `);
    expect(found.map((t) => t.name)).toEqual(["NAME"]);
  });

  it("catches a class used before its declaration", () => {
    const found = findEarlyReads(`
      const one = make();
      function make() { return new Thing(); }
      class Thing {}
    `);
    expect(found.map((t) => t.name)).toEqual(["Thing"]);
  });

  it("reports the line of the statement that runs too early", () => {
    const found = findEarlyReads("\n\nconst a = f();\nfunction f() { return B; }\nconst B = 1;\n");
    expect(found[0]!.line).toBe(3);
  });
});

group("it stays quiet about things that are fine", () => {
  it("is happy once the const is declared first — the actual fix", () => {
    expect(
      findEarlyReads(`
        const K_GRAPH = "memory.graph";
        let memory = fromJSON(readGraph());
        function readGraph() { return localStorage.getItem(K_GRAPH); }
      `),
    ).toEqual([]);
  });

  it("ignores a function that is only declared, never called at load time", () => {
    expect(
      findEarlyReads(`
        function later() { return LATER; }
        const LATER = 1;
      `),
    ).toEqual([]);
  });

  it("does not confuse a parameter with a top-level name", () => {
    expect(
      findEarlyReads(`
        const a = f(1);
        function f(later) { return later; }
        const later = 2;
      `),
    ).toEqual([]);
  });

  it("does not confuse a local variable with a top-level name", () => {
    expect(
      findEarlyReads(`
        const a = f();
        function f() { const later = 1; return later; }
        const later = 2;
      `),
    ).toEqual([]);
  });

  it("does not treat a property name as a read", () => {
    expect(
      findEarlyReads(`
        const a = f();
        function f() { return { later: 1 }.later; }
        const later = 2;
      `),
    ).toEqual([]);
  });

  it("does not loop forever on two functions that call each other", () => {
    expect(() =>
      findEarlyReads(`
        const a = ping();
        function ping() { return pong(); }
        function pong() { return ping(); }
      `),
    ).not.toThrow();
  });

  // The nineteen false alarms the first version of this checker produced were
  // all this: a handler assigned at load time whose body runs much later.
  it("ignores a callback body, which runs later", () => {
    expect(
      findEarlyReads(`
        focus.onFinish = () => { makeNoise(); };
        function makeNoise() { return sound; }
        const sound = 1;
      `),
    ).toEqual([]);
  });

  it("ignores an argument that is a callback", () => {
    expect(
      findEarlyReads(`
        button.addEventListener("click", () => render());
        function render() { return LATER; }
        const LATER = 1;
      `),
    ).toEqual([]);
  });

  it("but does look inside a function called on the spot", () => {
    const found = findEarlyReads(`
      const a = (() => go())();
      function go() { return LATER; }
      const LATER = 1;
    `);
    expect(found.map((t) => t.name)).toEqual(["LATER"]);
  });

  it("has no opinion about var, which is hoisted and initialized", () => {
    expect(
      findEarlyReads(`
        const a = f();
        function f() { return later; }
        var later = 2;
      `),
    ).toEqual([]);
  });
});

/**
 * The guard. Every module Loaf loads is checked, because the cost of this bug
 * is not proportional to the size of the file it lives in — one line in one
 * module took the whole window down.
 */
group("no module reads a name before it exists", () => {
  // Vite reads the files, not `node:fs`. This project has no `@types/node`, and
  // adding it to run one test would put `process` and `Buffer` in scope for
  // every browser file in `src/` — a permanent hole in the type checking of the
  // code this test exists to protect, bought for one import.
  const sources = import.meta.glob<string>("../src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const files = Object.keys(sources).sort();

  // If the sweep ever finds nothing to sweep it must fail loudly rather than
  // report success, which is how a green suite ends up meaning nothing.
  it("found the source to check", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("/main.ts"))).toBe(true);
  });

  for (const file of files) {
    const short = file.replace("../src/", "");
    it(short, () => {
      const found = findEarlyReads(sources[file]!, short);
      expect(found.map((t) => explain(t, short))).toEqual([]);
    });
  }
});
