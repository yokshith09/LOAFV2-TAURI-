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

/**
 * The colours a card can be.
 *
 * A FIXED PALETTE, not a colour picker. Every one of these is chosen to carry
 * legible text in both light and dark mode — a free picker lets someone make a
 * note they cannot read, and then the bug report is about Loaf. `default` means
 * "no colour", which is what almost every note stays.
 */
export const NOTE_COLOURS = [
  "default",
  "butter",
  "rose",
  "sage",
  "sky",
  "lilac",
  "clay",
] as const;
export type NoteColour = (typeof NOTE_COLOURS)[number];

export function isNoteColour(v: unknown): v is NoteColour {
  return typeof v === "string" && (NOTE_COLOURS as readonly string[]).includes(v);
}

/** Longer than this and the card is a document. The editor scrolls. */
export const MAX_BODY_LENGTH = 20_000;

/** More than this and the chips stop fitting on a card. */
export const MAX_LABELS = 8;
export const MAX_LABEL_LENGTH = 24;

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  /** Wall-clock ms when the timer is due, or null for no timer. */
  readonly dueAt: number | null;
  readonly done: boolean;
  /** Wall-clock ms it was created, so the order is stable. */
  readonly createdAt: number;
  /**
   * The note itself, under the title. Empty for a plain one-line task.
   *
   * THIS IS WHAT MAKES IT A NOTEPAD RATHER THAN A REMINDER LIST. The old model
   * had a single 80-character title and nothing else, so anything that did not
   * fit in a line could not be written down at all.
   */
  readonly body: string;
  readonly colour: NoteColour;
  /** Pinned cards sort above everything else, whatever their priority. */
  readonly pinned: boolean;
  readonly labels: readonly string[];
  /** Wall-clock ms of the last edit, so the grid can show recent work first. */
  readonly updatedAt: number;
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

/**
 * The first line of a note's body, for a note that was never given a title.
 *
 * A KEEP-STYLE NOTE MAY BE JUST A BODY. `add` still refuses an empty title —
 * a blank new row is litter — so when the composer's title box was left empty
 * and there is a body, this is what stands in for the title instead of losing
 * the note.
 *
 * Falls through blank lines rather than taking the literal first line, so
 * pasting a body that happens to start with a blank line does not produce an
 * empty-looking card sitting in the middle of the wall.
 */
export function firstLineOf(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return normaliseTitle(line);
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
    // EVERY ONE OF THESE DEFAULTS, because a file written before notes had
    // bodies must still load. That is the same contract `stats.json` has: a
    // missing field is a default, never a dropped row. Anyone who had tasks
    // before this change keeps all of them, as plain uncoloured cards.
    body: typeof r.body === "string" ? r.body.slice(0, MAX_BODY_LENGTH) : "",
    colour: isNoteColour(r.colour) ? r.colour : "default",
    pinned: r.pinned === true,
    labels: readLabels(r.labels),
    updatedAt:
      typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)
        ? r.updatedAt
        : createdAt,
  };
}

/**
 * The labels on a card, cleaned up.
 *
 * Deduplicated case-insensitively but stored as typed: "Work" and "work" are
 * one label, and which capitalisation survives is whichever was written first.
 * Anything that is not a non-empty string is dropped rather than coerced — a
 * label reading "null" is worse than no label.
 */
export function readLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") continue;
    const label = normaliseLabel(item);
    if (label === "") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

export function normaliseLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * The order cards appear in: pinned first, then most recently touched.
 *
 * NOT priority order, and that is the change. The old list was three things the
 * pet held in view, so "now" came first. A wall of notes is something you scan,
 * and the thing you want is almost always the one you just wrote — which is why
 * every notes app in the world sorts this way and no task list does.
 *
 * Priority still decides what the PET shows; see `visible`.
 */
export function forTheWall(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });
}

/** Every label in use, for the filter strip. Most used first. */
export function labelsInUse(tasks: readonly Task[]): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const t of tasks) {
    for (const label of t.labels) {
      const key = label.toLowerCase();
      const seen = counts.get(key);
      if (seen) seen.n += 1;
      else counts.set(key, { label, n: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .map((c) => c.label);
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
      body: "",
      colour: "default",
      pinned: false,
      labels: [],
      updatedAt: createdAt,
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

  /**
   * Change what a note says.
   *
   * Title and body together, because the editor edits both and saving them
   * separately would write the file twice and leave a window where one had
   * landed and the other had not.
   *
   * An empty title is allowed HERE and refused by `add`, which is deliberate: a
   * note you are part way through writing often has a body and no title yet,
   * and losing it on save because the title box is empty is the worst thing a
   * notepad can do. `add` refuses because a blank new row is just litter.
   */
  edit(id: string, title: string, body: string): boolean {
    return this.replace(id, (t) => ({
      ...t,
      title: normaliseTitle(title),
      body: body.slice(0, MAX_BODY_LENGTH),
      updatedAt: this.now(),
    }));
  }

  setColour(id: string, colour: NoteColour): boolean {
    return this.replace(id, (t) => ({ ...t, colour, updatedAt: this.now() }));
  }

  /** Returns the new state, so a caller does not have to look it up again. */
  togglePin(id: string): boolean {
    return this.replace(id, (t) => ({ ...t, pinned: !t.pinned, updatedAt: this.now() }));
  }

  addLabel(id: string, raw: string): boolean {
    const label = normaliseLabel(raw);
    if (label === "") return false;
    return this.replace(id, (t) => {
      // Already there, in any capitalisation: leave the note alone rather than
      // bumping updatedAt and jumping the card to the front of the wall for no
      // visible reason.
      if (t.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return t;
      if (t.labels.length >= MAX_LABELS) return t;
      return { ...t, labels: [...t.labels, label], updatedAt: this.now() };
    });
  }

  removeLabel(id: string, label: string): boolean {
    return this.replace(id, (t) => {
      const left = t.labels.filter((l) => l.toLowerCase() !== label.toLowerCase());
      if (left.length === t.labels.length) return t;
      return { ...t, labels: left, updatedAt: this.now() };
    });
  }

  /** Every note, pinned first then most recently touched. */
  wall(): Task[] {
    return forTheWall(this.tasks);
  }

  /** Only the notes carrying this label, in wall order. */
  withLabel(label: string): Task[] {
    const key = label.toLowerCase();
    return forTheWall(this.tasks.filter((t) => t.labels.some((l) => l.toLowerCase() === key)));
  }

  labels(): string[] {
    return labelsInUse(this.tasks);
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
