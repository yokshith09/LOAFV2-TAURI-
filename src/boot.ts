/**
 * The first thing that runs, so an invisible pet becomes an impossible outcome.
 *
 * WHY THIS FILE EXISTS. The companion window is transparent and undecorated:
 * nothing paints except the canvas. `main.ts` is three thousand lines whose
 * final statement is `requestAnimationFrame(frame)`. **A single throw anywhere
 * above that line means the loop never starts and the window renders nothing at
 * all** — and a transparent window rendering nothing is indistinguishable from
 * an app that never launched. That is exactly what a tester reported twice: the
 * app is plainly running, and there is no cat anywhere on the screen.
 *
 * Diagnosing it from here is not possible. The development machine is a PC, the
 * failure is on a Mac, and a release build has no web inspector. So this file
 * does the two things that turn an unreproducible report into one run that
 * answers the question:
 *
 *  1. **Paint something immediately**, before any of Loaf's own code has had a
 *     chance to fail. If the mark is on screen and the cat is not, the window is
 *     alive and correctly placed and the fault is in the drawing. If neither is
 *     on screen, the window itself is the problem. Those are different bugs and
 *     this is the cheapest way to tell them apart.
 *
 *  2. **Send every error to the terminal.** `error` and `unhandledrejection` are
 *     forwarded to Rust, which prints them to stderr, so someone running the app
 *     from a terminal sees the real exception rather than a blank rectangle.
 *
 * It is imported FIRST by `main.ts`, before every other import, because ES
 * modules evaluate their imports in order — so this runs even if one of the
 * other modules throws while being evaluated.
 *
 * EVERYTHING TAKES ITS DEPENDENCIES AS ARGUMENTS, and the auto-run at the bottom
 * is guarded. That is not ceremony: this project has one runtime dependency and
 * no DOM in its test environment, so the only way to actually test the thing
 * that stands between a thrown error and a blank window is to hand it a fake
 * window. Testing it matters more than usual here, because the failure it exists
 * to catch is the one failure that leaves no evidence behind.
 *
 * NOT a general error-reporting system. Nothing is uploaded, nothing is stored,
 * and it prints to a terminal nobody is usually watching. It exists for the ten
 * minutes somebody spends finding out why the screen is empty.
 */

/** How long to wait for a real frame before saying the loop never started. */
export const FRAME_DEADLINE_MS = 4000;

type Invoke = (cmd: string, args: unknown) => unknown;

export interface BootHost {
  readonly getElementById: (id: string) => unknown;
  readonly devicePixelRatio?: number;
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly invoke?: Invoke;
  readonly addEventListener: (type: string, fn: (e: unknown) => void) => void;
  readonly setTimeout: (fn: () => void, ms: number) => void;
  readonly drewFlag: () => boolean;
  readonly log: (message: string) => void;
}

/**
 * Send one message to the terminal.
 *
 * The console line is unconditional and comes first: if the bridge is itself
 * what is broken, the message still exists somewhere. Everything is wrapped,
 * because this runs inside an error handler and a reporter that can throw turns
 * one broken thing into two and loses the original.
 */
export function report(host: BootHost, what: string, detail: string): void {
  host.log(`[loaf] ${what}: ${detail}`);
  if (!host.invoke) return;
  try {
    const r = host.invoke("report_error", { what, detail: detail.slice(0, 4000) });
    void (r as { catch?: (f: () => void) => unknown })?.catch?.(() => {});
  } catch {
    // Reporting an error must never be able to raise one.
  }
}

/**
 * Draw a plain shape so the window is provably visible.
 *
 * Deliberately not a nice drawing. It is a diagnostic: a tester who sees THIS
 * rather than a cat can say "there is an orange box that says loading", which is
 * the single most useful sentence they could send back. A working build paints
 * over it within about sixteen milliseconds.
 */
export function paintProofOfLife(host: BootHost): void {
  const canvas = host.getElementById("stage") as {
    width: number;
    height: number;
    style: { width: string; height: string };
    getContext: (kind: string) => CanvasRenderingContext2D | null;
  } | null;

  if (!canvas) {
    report(host, "boot", "there is no #stage canvas in the document");
    return;
  }

  const dpr = host.devicePixelRatio || 1;
  const w = host.innerWidth || 134;
  const h = host.innerHeight || 150;

  // Sized here as well as in main.ts. A canvas left at its default 300x150 with
  // a CSS size of 100% is one of the ways a drawing ends up invisible, and this
  // file has to survive main.ts not running at all.
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    report(host, "boot", "canvas.getContext('2d') returned null");
    return;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#c9822f";
  const x = w / 2 - 22;
  const y = h / 2 - 16;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, 44, 32, 14);
  else ctx.rect(x, y, 44, 32);
  ctx.fill();
  ctx.fillStyle = "#23201b";
  ctx.font = "9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("loading", w / 2, h / 2 + 4);
  ctx.restore();
}

/** Complain to the terminal if the real render loop never produced a frame. */
export function watchForTheFirstFrame(host: BootHost): void {
  host.setTimeout(() => {
    if (!host.drewFlag()) {
      report(
        host,
        "boot",
        "the render loop never produced a frame — main.ts stopped before requestAnimationFrame",
      );
    }
  }, FRAME_DEADLINE_MS);
}

export function installBootGuards(host: BootHost): void {
  host.addEventListener("error", (e) => {
    const ev = e as { error?: Error; message?: string; filename?: string; lineno?: number };
    report(
      host,
      "uncaught",
      ev.error?.stack ?? `${ev.message} (${ev.filename}:${ev.lineno})`,
    );
  });

  host.addEventListener("unhandledrejection", (e) => {
    const ev = e as { reason?: { stack?: string } };
    report(host, "unhandled rejection", ev.reason?.stack ?? String(ev.reason));
  });

  paintProofOfLife(host);
  watchForTheFirstFrame(host);
}

/** The real browser, wrapped up as a host. */
export function browserHost(): BootHost {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: Invoke };
    __loafDrew?: boolean;
  };
  return {
    getElementById: (id) => document.getElementById(id),
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    invoke: w.__TAURI_INTERNALS__?.invoke,
    addEventListener: (type, fn) => window.addEventListener(type, fn as EventListener),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    drewFlag: () => w.__loafDrew === true,
    log: (m) => console.error(m),
  };
}

// Guarded so importing this module in a test does not need a DOM.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  installBootGuards(browserHost());
}
