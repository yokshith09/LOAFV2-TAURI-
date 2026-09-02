/**
 * Noticing that you are in a meeting, without listening to it.
 *
 * WHAT THIS DOES NOT DO, AND WHY THAT IS THE POINT. It does not record audio,
 * transcribe anything, read participant names, or capture a window title. It
 * watches the same foreground-app signal the screen-time tracker already uses
 * and concludes "you appear to be in a meeting". Everything a person other
 * than the user might say or type is outside this file entirely.
 *
 * That matters more here than anywhere else in Loaf. Every other feature
 * watches the user's own machine and reports back to the user. A meeting
 * captures colleagues who never installed anything and never agreed to
 * anything, and their consent is not the user's to give. So version one
 * records the one fact that is unambiguously the user's own: that they were in
 * a meeting, and for how long.
 *
 * THE NOTES ARE TYPED BY THE USER. What gets written down is what the user
 * chose to write down. That is a smaller feature than transcription and a
 * completely different privacy object.
 *
 * DETECTION IS DELIBERATELY CONSERVATIVE. A meeting has to last a few minutes
 * before it counts, and has to be gone for a while before it ends, because
 * people alt-tab constantly during calls. A tracker that started a meeting
 * every time Zoom flashed past would produce a list nobody trusts, and an
 * untrusted list is worse than no list.
 */

/**
 * Applications that mean a call is happening.
 *
 * Matched on the executable or application name the tracker already reports —
 * NOT on window titles, which carry meeting names, client names and
 * occasionally the names of people. The app alone is enough to know a call is
 * happening and carries none of that.
 */
export const MEETING_APPS: readonly string[] = [
  "zoom",
  "teams",
  "ms-teams",
  "webex",
  "gotomeeting",
  "bluejeans",
  "ringcentral",
  "whereby",
  "discord",
];

/**
 * Domains that mean a call is happening in a browser.
 *
 * Loaf already reads the address bar for the privacy radar, so this needs no
 * new permission and no new kind of watching. Domain only — never the path,
 * which for most of these is the meeting id.
 */
export const MEETING_DOMAINS: readonly string[] = [
  "meet.google.com",
  "zoom.us",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "whereby.com",
  "app.gather.town",
];

/** Shortest run that counts as a meeting. Below this it was a glance. */
export const MIN_MEETING_MS = 3 * 60_000;

/**
 * How long the meeting app can be out of the foreground before it has ended.
 *
 * Generous on purpose: taking notes, checking a document and reading a message
 * are all normal things to do mid-call, and each of them moves the foreground
 * away for minutes at a time.
 */
export const AWAY_GRACE_MS = 5 * 60_000;

function tidy(raw: string): string {
  return raw.toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9.]/g, "");
}

/** Whether this foreground app is a meeting application. */
export function isMeetingApp(app: string): boolean {
  const name = tidy(app);
  if (name.length === 0) return false;
  // Both sides go through `tidy`. Without that, a pattern containing anything
  // punctuation-shaped could never match: "ms-teams" tidies to "msteams", so
  // comparing the tidied name against the raw pattern silently missed Teams on
  // every machine that reports it as ms-teams.exe.
  return MEETING_APPS.map(tidy).some((m) => name === m || name.startsWith(m));
}

/** Whether this domain is a meeting in a browser. */
export function isMeetingDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const host = domain.toLowerCase().replace(/^www\./, "");
  return MEETING_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** What the watcher is told each tick. */
export interface Sample {
  /** Foreground application name. */
  readonly app: string;
  /** Domain in the address bar, when the foreground app is a browser. */
  readonly domain?: string | null;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

/** Whether a sample looks like a call, and what to call it. */
export function meetingNameFor(sample: Sample): string | null {
  if (isMeetingDomain(sample.domain)) {
    const host = (sample.domain ?? "").toLowerCase().replace(/^www\./, "");
    return host;
  }
  if (isMeetingApp(sample.app)) return sample.app;
  return null;
}

/** One meeting, once it is over. */
export interface Meeting {
  readonly id: string;
  /** The app or domain it happened in. Never a window or meeting title. */
  readonly where: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly seconds: number;
  /** What the user chose to write down. Nothing is captured automatically. */
  readonly notes: readonly string[];
}

export interface MeetingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "meetings.log";
/** Kept so the list stays useful rather than becoming an archive. */
export const KEEP_MEETINGS = 60;

export function loadMeetings(store: MeetingStore): Meeting[] {
  const raw = store.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMeeting);
  } catch {
    // A corrupt log costs the user their meeting list, not their launch.
    return [];
  }
}

function isMeeting(v: unknown): v is Meeting {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.where === "string" &&
    typeof m.startedAt === "number" &&
    typeof m.endedAt === "number" &&
    typeof m.seconds === "number" &&
    Array.isArray(m.notes)
  );
}

export function saveMeetings(store: MeetingStore, meetings: readonly Meeting[]): void {
  store.setItem(KEY, JSON.stringify(meetings.slice(-KEEP_MEETINGS)));
}

/**
 * Watches the foreground and decides when a meeting started and ended.
 *
 * Injected clock-free: every decision is made from the `at` on the sample, so
 * the tests can run a whole day through it in a millisecond and the rules
 * about minimum length and grace periods are actually exercised rather than
 * asserted.
 */
export class MeetingWatch {
  private where: string | null = null;
  private startedAt = 0;
  /** When the meeting app was last in front. Drives the grace period. */
  private lastSeen = 0;
  private notes: string[] = [];

  constructor(
    private readonly minMs: number = MIN_MEETING_MS,
    private readonly graceMs: number = AWAY_GRACE_MS,
  ) {}

  /** Whether a meeting is running right now. */
  get active(): boolean {
    return this.where !== null;
  }

  /** Where the current meeting is, or null. */
  get current(): string | null {
    return this.where;
  }

  /** How long the current meeting has run, in seconds. */
  runningSeconds(now: number): number {
    return this.where === null ? 0 : Math.max(0, Math.round((now - this.startedAt) / 1000));
  }

  /**
   * Attach a note to the meeting in progress.
   *
   * Returns false when there is no meeting, so the caller can say so rather
   * than dropping what someone typed.
   */
  note(text: string): boolean {
    const trimmed = text.trim();
    if (this.where === null || trimmed.length === 0) return false;
    this.notes.push(trimmed);
    return true;
  }

  /** The notes so far, for showing while the meeting is still running. */
  currentNotes(): readonly string[] {
    return [...this.notes];
  }

  /**
   * One tick. Returns a meeting when one has just ended, otherwise null.
   *
   * A meeting shorter than `minMs` is discarded rather than recorded: it was a
   * glance at a calendar invite, and a list full of those is a list nobody
   * reads.
   */
  see(sample: Sample): Meeting | null {
    const name = meetingNameFor(sample);

    if (name !== null) {
      if (this.where === null) {
        this.where = name;
        this.startedAt = sample.at;
        this.notes = [];
      } else if (this.where !== name) {
        // Moved from one call to another. End the first properly rather than
        // silently relabelling it, or an hour in Zoom becomes an hour in Meet.
        const finished = this.finish(sample.at);
        this.where = name;
        this.startedAt = sample.at;
        this.notes = [];
        this.lastSeen = sample.at;
        return finished;
      }
      this.lastSeen = sample.at;
      return null;
    }

    // Not a meeting app right now. That is normal mid-call — taking notes,
    // reading a document — so nothing ends until the grace period is up.
    if (this.where !== null && sample.at - this.lastSeen >= this.graceMs) {
      return this.finish(this.lastSeen);
    }
    return null;
  }

  /** End whatever is running, e.g. when the app quits. */
  close(now: number): Meeting | null {
    if (this.where === null) return null;
    return this.finish(Math.max(now, this.lastSeen));
  }

  private finish(endedAt: number): Meeting | null {
    const where = this.where;
    const startedAt = this.startedAt;
    const notes = this.notes;
    this.where = null;
    this.notes = [];
    if (where === null) return null;

    const length = endedAt - startedAt;
    // Too short to have been a meeting. Notes typed during it go with it,
    // because a note attached to nothing is worse than no note.
    if (length < this.minMs) return null;

    return {
      id: `${startedAt}`,
      where,
      startedAt,
      endedAt,
      seconds: Math.round(length / 1000),
      notes: [...notes],
    };
  }
}

/** "43m in zoom", for a bubble or the dashboard. */
export function describeMeeting(meeting: Meeting): string {
  const minutes = Math.round(meeting.seconds / 60);
  const length = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const notes =
    meeting.notes.length === 0
      ? ""
      : ` — ${meeting.notes.length} note${meeting.notes.length === 1 ? "" : "s"}`;
  return `${length} in ${meeting.where}${notes}`;
}

/** Total time in meetings across a list, in seconds. */
export function totalMeetingSeconds(meetings: readonly Meeting[]): number {
  return meetings.reduce((sum, m) => sum + (Number.isFinite(m.seconds) ? m.seconds : 0), 0);
}

/** Meetings that started on a given local day, newest first. */
export function meetingsOn(meetings: readonly Meeting[], date: Date): Meeting[] {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return meetings
    .filter((m) => m.startedAt >= start && m.startedAt < end)
    .sort((a, b) => b.startedAt - a.startedAt);
}
