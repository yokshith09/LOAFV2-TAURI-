/**
 * Find the bug that made the pet invisible, before it ships again.
 *
 * THE BUG. `main.ts` had these three things, in this order:
 *
 *     let memory = KnowledgeGraph.fromJSON(readGraph(browserStore()));
 *     const K_GRAPH = "memory.graph";
 *     function readGraph(store) { return store.getItem(K_GRAPH); }
 *
 * `readGraph` is a function *declaration*, so it hoists: calling it from two
 * lines above is legal and reads perfectly. But its body reads `K_GRAPH`, and a
 * `const` read before its own line has run is not `undefined` — it is a
 * `ReferenceError: Cannot access 'K_GRAPH' before initialization`. So `main.ts`
 * threw while it was still loading, every launch, on every platform. Everything
 * below that line never ran: no render loop, no cat. The companion window is
 * transparent, so the result was an app that was plainly running with nothing
 * whatsoever on the screen.
 *
 * WHY NOTHING CAUGHT IT. `tsc` catches the direct form — reading `K_GRAPH`
 * straight from the initializer is "Block-scoped variable used before its
 * declaration". It does not follow the call into a function, because in general
 * it cannot know when that function runs. Here we do know: it runs immediately,
 * during module evaluation. That is the one case worth checking, and it is the
 * case that shipped broken through four releases.
 *
 * WHAT THIS DOES. Parse each file with TypeScript's own parser (already a
 * dependency — no new tooling), then walk the top-level statements in order.
 * At each statement, anything declared further down is not yet initialized. If
 * a statement that RUNS AT LOAD TIME calls a hoisted top-level function, look
 * inside that function — and inside anything it calls — for a read of one of
 * those not-yet-initialized names.
 *
 * DELIBERATELY CONSERVATIVE. It reports only what it can see plainly: bare
 * calls to top-level function declarations. It does not chase values through
 * variables, objects or arrays. A checker that cried wolf would be turned off
 * within a week, and a checker that catches the exact shape of a bug that cost
 * four releases is worth more than one that catches everything and is ignored.
 */

import ts from "typescript";

export interface Trouble {
  /** The name that is read too early. */
  readonly name: string;
  /** The chain of calls from the top-level statement to that read. */
  readonly through: readonly string[];
  /** 1-based line of the statement that runs too early. */
  readonly line: number;
}

/**
 * The names a function body brings with it.
 *
 * A parameter called `store` has nothing to do with a top-level `const store`,
 * and reporting it would be a false alarm of exactly the kind that gets a
 * checker deleted. So every name a function declares for itself is collected
 * and subtracted from what it reads.
 */
function namesDeclaredInside(fn: ts.FunctionDeclaration): Set<string> {
  const own = new Set<string>();

  const collectBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      own.add(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBinding(el.name);
    }
  };

  for (const p of fn.parameters) collectBinding(p.name);

  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) collectBinding(node.name);
    if (ts.isFunctionDeclaration(node) && node.name) own.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) own.add(node.name.text);
    ts.forEachChild(node, walk);
  };
  if (fn.body) walk(fn.body);

  return own;
}

function unwrap(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isClassDeclaration(n) ||
    ts.isClassExpression(n)
  );
}

/**
 * A callback body does not run now, and pretending it does is a false alarm.
 *
 * This mattered immediately. The first version of this checker descended into
 * everything and duly announced that `focus.onFinish = (planned) => { ... }`
 * reads a `const` declared further down. It does — a quarter of an hour later,
 * when a focus session ends and every one of those names has existed for ages.
 * Nineteen such complaints came back on the first run, none of them a bug.
 *
 * So both walks below stop at a function boundary. The exception is a function
 * that is called on the spot — `(() => { ... })()` — which really does run now.
 *
 * The cost is a blind spot: a read inside `items.forEach(() => ...)` also runs
 * now, and is not seen. That is the right trade. This exists to catch one shape
 * exactly, and a checker with false alarms gets switched off, at which point it
 * catches nothing at all.
 */
function immediatelyCalledBody(n: ts.CallExpression): ts.Node | null {
  const callee = unwrap(n.expression);
  if (!isFunctionLike(callee)) return null;
  return (callee as ts.FunctionExpression | ts.ArrowFunction).body ?? null;
}

/** Every identifier a node reads as it runs, ignoring the property half of `a.b`. */
function identifiersRead(node: ts.Node): Set<string> {
  const found = new Set<string>();
  const walk = (n: ts.Node): void => {
    // Reached as an argument rather than as a child: `f(() => ...)`. It still
    // runs later, so it is still not our business.
    if (isFunctionLike(n)) return;
    // In `a.b`, only `a` is a variable read. `b` is a property name and has
    // nothing to do with any binding in this file.
    if (ts.isPropertyAccessExpression(n)) {
      walk(n.expression);
      return;
    }
    // Same for `{ b: 1 }` — `b` is a key, not a read.
    if (ts.isPropertyAssignment(n) && !ts.isComputedPropertyName(n.name)) {
      walk(n.initializer);
      return;
    }
    if (ts.isCallExpression(n)) {
      const body = immediatelyCalledBody(n);
      if (body) walk(body);
      else walk(n.expression);
      n.arguments.forEach(walk);
      return;
    }
    if (ts.isIdentifier(n)) {
      found.add(n.text);
      return;
    }
    ts.forEachChild(n, (c) => {
      if (!isFunctionLike(c)) walk(c);
    });
  };
  walk(node);
  return found;
}

/** Every bare `name(...)` call a node makes as it runs. */
function functionsCalled(node: ts.Node): Set<string> {
  const called = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (isFunctionLike(n)) return;
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) called.add(n.expression.text);
      const body = immediatelyCalledBody(n);
      if (body) walk(body);
      else walk(n.expression);
      n.arguments.forEach(walk);
      return;
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) called.add(n.expression.text);
    ts.forEachChild(n, (c) => {
      if (!isFunctionLike(c)) walk(c);
    });
  };
  walk(node);
  return called;
}

/**
 * Does this top-level statement run while the module is loading?
 *
 * A `function` or `class` declaration does not — its body runs later, by which
 * time everything is initialized, which is precisely why the bug hid so well.
 * A variable initializer and a bare call do run, immediately, in order.
 */
function runsAtLoadTime(stmt: ts.Statement): boolean {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.some((d) => d.initializer !== undefined);
  }
  return ts.isExpressionStatement(stmt) || ts.isIfStatement(stmt);
}

export function findEarlyReads(source: string, fileName = "input.ts"): Trouble[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);

  // Where each top-level `const`/`let`/`class` binding becomes usable. `var`
  // and `function` are hoisted and initialized, so they are never too early.
  const declaredAt = new Map<string, number>();
  // Top-level function declarations, by name, so a call can be followed.
  const functions = new Map<string, ts.FunctionDeclaration>();

  file.statements.forEach((stmt, index) => {
    if (ts.isVariableStatement(stmt)) {
      const blockScoped = (stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      if (!blockScoped) return;
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) declaredAt.set(d.name.text, index);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      declaredAt.set(stmt.name.text, index);
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      functions.set(stmt.name.text, stmt);
    }
  });

  const trouble: Trouble[] = [];
  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  file.statements.forEach((stmt, index) => {
    if (!runsAtLoadTime(stmt)) return;

    // Follow calls breadth-first, remembering the route so the report can say
    // how the read is reached rather than only that it happens.
    const seen = new Set<string>();
    const queue: { fn: string; path: string[] }[] = [...functionsCalled(stmt)].map((fn) => ({
      fn,
      path: [fn],
    }));

    while (queue.length > 0) {
      const { fn, path } = queue.shift()!;
      if (seen.has(fn)) continue;
      seen.add(fn);

      const decl = functions.get(fn);
      if (!decl || !decl.body) continue;

      const own = namesDeclaredInside(decl);
      for (const name of identifiersRead(decl.body)) {
        if (own.has(name)) continue;
        const at = declaredAt.get(name);
        // `at === index` is the statement doing the reading: a `const x = f()`
        // whose `f` reads `x` is genuinely broken, and is reported.
        if (at !== undefined && at >= index) {
          trouble.push({ name, through: path, line: lineOf(stmt) });
        }
      }

      for (const next of functionsCalled(decl.body)) {
        if (!seen.has(next)) queue.push({ fn: next, path: [...path, next] });
      }
    }
  });

  return trouble;
}

export function describe(t: Trouble, fileName: string): string {
  return `${fileName}:${t.line} runs at load time and reaches '${t.name}' through ${t.through.join(
    " -> ",
  )}, which is declared further down. At runtime this is "Cannot access '${t.name}' before initialization".`;
}
