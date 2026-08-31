/**
 * The notetaker: what you have told Loaf you mean to do.
 *
 * A list, a priority, and optionally a timer. Deliberately not a project
 * manager — Loaf's job here is to hold three things in view while you forget
 * them, which is the whole complaint the feature answers. There are no
 * projects, no tags, no subtasks and no due dates, because each of those turns
 * a companion into an app you have to maintain.
 *
 * LOCAL, like everything else. One JSON file beside `stats.json`, no account,
 * no sync, no network. Same storage contract, same tolerance for a file that
 * has been hand-edited or written by an older version.
 *
 * The timer here is NOT the focus timer. The focus timer is a session you sit
 * inside; this is a reminder attached to one task, and the two are allowed to
 * run at once because "spend 25 minutes focused" and "the bread comes out at
 * half past" are different promises.
 */

/** Highest first — the order the pet shows them in. */
export const PRIORITIES = ["now", "soon", "whenever"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  now: "Now",
  soon: "Soon",
  whenever: "Whenever",
};

/** The most tasks the pet will ever show at once. See `visible`. */
export const MAX_VISIBLE = 3;

/** Longer than this and it is a document, not a task. */
export const MAX_TITLE_LENGTH = 80;

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  /** Wall-clock ms when the timer is due, or null for no timer. */
  readonly dueAt: number | null;
  readonly done: boolean;
  /** Wall-clock ms it was created, so the order is stable. */
  readonly createdAt: number;
}

export interface TaskStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TASKS_KEY = "loaf.tasks";

/**
 * Trim a title to something that fits on a companion.
 *
 * Empty after trimming means there is no task, which the caller must treat as
 * a refusal rather than storing a blank row.
 */
export function normaliseTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

export function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}

/**
 * Read one task out of whatever was in the file.
 *
 * Tolerant in the same way the stats file is: a row missing a field gets a
 * default, and a row that cannot be understood at all is dropped rather than
 * half-restored. A list is worth less than the trust that it is accurate.
 */
function readTask(v: unknown, fallbackNow: number): Task | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;

  const title = typeof r.title === "string" ? normaliseTitle(r.title) : "";
  if (title.length === 0) return null;

  const id = typeof r.id === "string" && r.id.length > 0 ? r.id : `t${fallbackNow}`;
  const dueAt =
    typeof r.dueAt === "number" && Number.isFinite(r.dueAt) ? r.dueAt : null;
  const createdAt =
    typeof r.createdAt === "number" && Number.isFinite(r.createdAt)
      ? r.createdAt
      : fallbackNow;

  return {
    id,
    title,
    priority: isPriority(r.priority) ? r.priority : "soon",
    dueAt,
    done: r.done === true,
    createdAt,
  };
}

/**
 * The list, and the few things you can do to it.
 *
 * An injected clock and store, like every other stateful thing here, so the
 * timers are testable without waiting for them.
 */
export class TaskList {
  private tasks: Task[] = [];
  private readonly now: () => number;
  private nextId = 0;

  constructor(
    private readonly store: TaskStore,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    let raw: string | null;
    try {
      raw = this.store.getItem(TASKS_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const now = this.now();
      this.tasks = parsed
        .map((t) => readTask(t, now))
        .filter((t): t is Task => t !== null);
    } catch {
      // A corrupt file costs the user their list, not their launch. It is not
      // overwritten until they change something, so a bad parse is recoverable
      // by hand rather than destroyed on sight.
    }
  }

  private save(): void {
    try {
      this.store.setItem(TASKS_KEY, JSON.stringify(this.tasks));
    } catch {
      // The list lasts for this session.
    }
  }

  get all(): readonly Task[] {
    return this.tasks;
  }

  get outstanding(): readonly Task[] {
    return this.ordered().filter((t) => !t.done);
  }

  /**
   * Priority first, then oldest first.
   *
   * Oldest rather than newest within a band on purpose: a task you wrote down
   * three days ago and keep not doing should rise past the one you added this
   * morning, not sink under it.
   */
  ordered(): Task[] {
    const rank = (p: Priority): number => PRIORITIES.indexOf(p);
    return [...this.tasks].sort(
      (a, b) => rank(a.priority) - rank(b.priority) || a.createdAt - b.createdAt,
    );
  }

  /** What the pet shows. Never more than a glance's worth. */
  visible(): Task[] {
    return this.outstanding.slice(0, MAX_VISIBLE);
  }

  add(rawTitle: string, priority: Priority = "soon", minutes?: number): Task | null {
    const title = normaliseTitle(rawTitle);
    if (title.length === 0) return null;

    const createdAt = this.now();
    const task: Task = {
      // Time plus a counter: two tasks added in the same millisecond are rare
      // and a duplicate id would silently merge them.
      id: `t${createdAt}-${this.nextId++}`,
      title,
      priority,
      dueAt:
        typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
          ? createdAt + minutes * 60_000
          : null,
      done: false,
      createdAt,
    };
    this.tasks.push(task);
    this.save();
    return task;
  }

  private replace(id: string, change: (t: Task) => Task): boolean {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.tasks[i] = change(this.tasks[i]!);
    this.save();
    return true;
  }

  complete(id: string): boolean {
    return this.replace(id, (t) => ({ ...t, done: true }));
  }

  reopen(id: string): boolean {
    return this.replace(id, (t) => ({ ...t, done: false }));
  }

  setPriority(id: string, priority: Priority): boolean {
    return this.replace(id, (t) => ({ ...t, priority }));
  }

  /** Set or clear the timer. `minutes` of 0 or less removes it. */
  setTimer(id: string, minutes: number): boolean {
    const dueAt =
      Number.isFinite(minutes) && minutes > 0 ? this.now() + minutes * 60_000 : null;
    return this.replace(id, (t) => ({ ...t, dueAt }));
  }

  remove(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return false;
    this.save();
    return true;
  }

  /** Clear finished tasks. The only bulk delete, and it is never automatic. */
  clearDone(): number {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => !t.done);
    const removed = before - this.tasks.length;
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * Tasks whose timer has come up, and clearing them so each fires once.
   *
   * The timer is cleared rather than the task completed: the bread being ready
   * is not the same as you having taken it out, and marking it done for you
   * would be Loaf deciding something it cannot know.
   */
  due(): Task[] {
    const now = this.now();
    const ready = this.tasks.filter(
      (t) => !t.done && t.dueAt !== null && t.dueAt <= now,
    );
    if (ready.length === 0) return [];
    for (const task of ready) {
      this.replace(task.id, (t) => ({ ...t, dueAt: null }));
    }
    return ready;
  }
}
