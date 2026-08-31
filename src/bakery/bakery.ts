/**
 * Focus sessions bake bread.
 *
 * A loaf rises while a session runs, and a finished session puts it on the
 * shelf. This is the one mechanic in Loaf that exists to make you WANT to start
 * a timer, which is the actual problem with focus timers — not that they are
 * hard to run, but that nobody starts them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: count your failures.
 *
 * An abandoned session collapses its loaf and that is the whole of it. Nothing
 * is recorded, no streak breaks, and there is no number anywhere that goes up
 * when you stop early. That is not softness, it is the product's stated
 * principle — "allowed to be cross, not to nag", a care mirror rather than a
 * guilt engine — applied to the one feature most likely to violate it. A shelf
 * showing what you baked is encouraging. A shelf also counting what you burned
 * is a scoreboard you will eventually want to hide from.
 */

/** What comes out of the oven, by how long the session was. */
export const LOAF_KINDS = ["roll", "bun", "loaf", "sourdough", "cottage"] as const;
export type LoafKind = (typeof LOAF_KINDS)[number];

export interface BakedLoaf {
  readonly kind: LoafKind;
  /** Minutes the session ran. What earned it. */
  readonly minutes: number;
  /** Day key, `YYYY-MM-DD`, so the shelf can be grouped without a Date. */
  readonly day: string;
  readonly bakedAt: number;
}

export interface BakeryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SHELF_KEY = "loaf.shelf";

/**
 * How many loaves are kept.
 *
 * Generous, but not unbounded: a year of heavy use should not turn a settings
 * file into something that takes a moment to parse at launch. The oldest fall
 * off the back of the shelf, which is also what happens to real bread.
 */
export const SHELF_LIMIT = 500;

/**
 * What a session's length earns.
 *
 * Thresholds rather than a formula, so the reward for a longer session is
 * something you can SEE rather than a number that ticks up. Someone who does
 * three 25-minute sessions has a different shelf from someone who did one long
 * one, and both should be able to tell at a glance.
 */
export function loafFor(minutes: number): LoafKind {
  if (minutes >= 90) return "cottage";
  if (minutes >= 45) return "sourdough";
  if (minutes >= 25) return "loaf";
  if (minutes >= 10) return "bun";
  return "roll";
}

/**
 * How risen the dough is, 0..1, from a session's progress.
 *
 * NOT linear. Bread does most of its rising early and then just browns, and a
 * loaf that grew at a constant rate would read as a progress bar shaped like a
 * loaf. This front-loads the growth so the shape is nearly there by halfway,
 * and the rest of the session is the part where it colours — which is also the
 * part where you are most likely to give up, and a loaf that is visibly nearly
 * done is a better argument for staying than one that is half-size.
 */
export function riseFor(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  // Square root: fast at first, flattening toward the end.
  return Math.sqrt(p);
}

/**
 * How browned, 0..1. The last third of the session.
 *
 * Separate from the rise so the two read as different stages rather than one
 * thing getting bigger — a loaf that is full-size and pale is obviously not
 * finished, which is the signal that keeps someone sitting there.
 */
export function browningFor(progress: number): number {
  const start = 0.66;
  if (progress <= start) return 0;
  return Math.min(1, (progress - start) / (1 - start));
}

/** A loaf in the oven right now. */
export interface Bake {
  /** 0..1, how much dough has risen. */
  readonly rise: number;
  /** 0..1, how brown. */
  readonly browning: number;
  /** What it will be if it finishes. */
  readonly kind: LoafKind;
  /** True while it is deflating after an abandoned session. */
  readonly collapsing: boolean;
}

/**
 * How long the collapse takes to play out, in seconds.
 *
 * Long enough to be seen and understood, short enough that it is not a
 * punishment you have to sit through. It is a shrug, not a cutscene.
 */
export const COLLAPSE_SECONDS = 1.4;

/**
 * The oven and the shelf.
 *
 * Injected clock and store like everything else stateful here, so a session's
 * worth of baking can be tested without waiting for one.
 */
export class Bakery {
  private shelf: BakedLoaf[] = [];
  private readonly now: () => number;
  /** Seconds left of the collapse animation, or 0 when not collapsing. */
  private collapse = 0;
  private lastProgress = 0;

  constructor(
    private readonly store: BakeryStore,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    let raw: string | null;
    try {
      raw = this.store.getItem(SHELF_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      this.shelf = parsed
        .map((v) => readLoaf(v))
        .filter((l): l is BakedLoaf => l !== null)
        .slice(-SHELF_LIMIT);
    } catch {
      // A corrupt shelf costs the user their loaves, not their launch — and it
      // is not overwritten until the next bake, so it stays recoverable.
    }
  }

  private save(): void {
    try {
      this.store.setItem(SHELF_KEY, JSON.stringify(this.shelf));
    } catch {
      // This session's loaves only.
    }
  }

  get loaves(): readonly BakedLoaf[] {
    return this.shelf;
  }

  get total(): number {
    return this.shelf.length;
  }

  /** Loaves baked on a given day key. */
  countOn(day: string): number {
    return this.shelf.filter((l) => l.day === day).length;
  }

  /**
   * What is in the oven, given the session.
   *
   * @param progress 0..1 through the session, or null when none is running.
   * @param plannedMinutes the session's full length, for the kind.
   */
  peek(progress: number | null, plannedMinutes: number): Bake | null {
    if (this.collapse > 0) {
      // Deflating: the rise runs backwards from wherever it got to.
      const left = this.collapse / COLLAPSE_SECONDS;
      return {
        rise: riseFor(this.lastProgress) * left,
        browning: 0,
        kind: loafFor(plannedMinutes),
        collapsing: true,
      };
    }
    if (progress === null) return null;
    return {
      rise: riseFor(progress),
      browning: browningFor(progress),
      kind: loafFor(plannedMinutes),
      collapsing: false,
    };
  }

  /** Remember how far it got, so a collapse starts from the right height. */
  noteProgress(progress: number): void {
    this.lastProgress = Math.min(1, Math.max(0, progress));
  }

  /** Advance the collapse animation. */
  tick(dt: number): void {
    if (this.collapse > 0) this.collapse = Math.max(0, this.collapse - dt);
  }

  get isCollapsing(): boolean {
    return this.collapse > 0;
  }

  /**
   * The session was abandoned.
   *
   * Nothing is recorded. See the note at the top of this file: the collapse is
   * the whole consequence, and it is visual and brief.
   */
  abandon(): void {
    if (this.lastProgress <= 0) return;
    this.collapse = COLLAPSE_SECONDS;
  }

  /** The session finished. Put it on the shelf. */
  bake(minutes: number, dayKey: string): BakedLoaf {
    const loaf: BakedLoaf = {
      kind: loafFor(minutes),
      minutes: Math.round(minutes),
      day: dayKey,
      bakedAt: this.now(),
    };
    this.shelf.push(loaf);
    if (this.shelf.length > SHELF_LIMIT) {
      this.shelf = this.shelf.slice(-SHELF_LIMIT);
    }
    this.lastProgress = 0;
    this.collapse = 0;
    this.save();
    return loaf;
  }

  /** Clear the shelf. Only ever on request — nothing here expires on its own. */
  clear(): void {
    this.shelf = [];
    this.save();
  }
}

function readLoaf(v: unknown): BakedLoaf | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const minutes =
    typeof r.minutes === "number" && Number.isFinite(r.minutes) && r.minutes >= 0
      ? r.minutes
      : null;
  if (minutes === null) return null;
  const day = typeof r.day === "string" && r.day.length > 0 ? r.day : null;
  if (day === null) return null;
  const kind =
    typeof r.kind === "string" && (LOAF_KINDS as readonly string[]).includes(r.kind)
      ? (r.kind as LoafKind)
      : loafFor(minutes);
  const bakedAt =
    typeof r.bakedAt === "number" && Number.isFinite(r.bakedAt) ? r.bakedAt : 0;
  return { kind, minutes, day, bakedAt };
}
