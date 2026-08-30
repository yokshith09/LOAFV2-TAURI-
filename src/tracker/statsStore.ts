import { invoke } from "@tauri-apps/api/core";

/**
 * Whether we are running inside the app rather than a plain browser preview.
 *
 * Checked up front rather than by catching a failed call, because the two
 * failures must not be treated alike: "there is no backend here" is a normal
 * development state, and "the backend refused to read the file" is a reason to
 * stop and not overwrite anything.
 */
export function hasTauriHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The tracker's persistence seam.
 *
 * The Tracker itself is pure — a string in, a string out — so this is the only
 * place that knows the history is a file at all. It is also the only place that
 * has to cope with the asynchrony: `save()` is called from a synchronous tick
 * and cannot wait for a disk write.
 */
export interface StatsStore {
  load(): Promise<string | null>;
  save(json: string): void;
}

/** For tests and for running without a backend. */
export class MemoryStatsStore implements StatsStore {
  constructor(private json: string | null = null) {}
  saves = 0;
  async load(): Promise<string | null> {
    return this.json;
  }
  save(json: string): void {
    this.json = json;
    this.saves++;
  }
  get current(): string | null {
    return this.json;
  }
}

/**
 * The real store, backed by the `read_stats` / `write_stats` commands.
 *
 * Writes are coalesced: the tracker ticks every five seconds and would
 * otherwise rewrite the entire history file twelve times a minute for the sake
 * of five seconds' change. Only the most recent payload is kept, so a burst
 * collapses to one write rather than a queue of stale ones.
 *
 * A failed write is swallowed after being logged. Losing a save is survivable —
 * the next one carries the same cumulative totals — and there is nothing useful
 * a companion pet can say to the user about a transient disk error.
 */
export class TauriStatsStore implements StatsStore {
  private pending: string | null = null;
  private writing = false;

  async load(): Promise<string | null> {
    // Deliberately not caught. A read that fails is NOT an empty history, and
    // the caller must not start a fresh file over the top of one it could not
    // open.
    return await invoke<string | null>("read_stats");
  }

  save(json: string): void {
    this.pending = json;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending !== null) {
        const payload = this.pending;
        this.pending = null;
        try {
          await invoke("write_stats", { json: payload });
        } catch (err) {
          console.error("could not save screen time", err);
        }
      }
    } finally {
      this.writing = false;
    }
  }
}
