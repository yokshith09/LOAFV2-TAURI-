import { describe, it, expect } from "vitest";
import {
  MeetingWatch,
  isMeetingApp,
  isMeetingDomain,
  meetingNameFor,
  describeMeeting,
  totalMeetingSeconds,
  meetingsOn,
  loadMeetings,
  saveMeetings,
  pruneMeetings,
  readRetentionDays,
  retentionLabel,
  isRetentionDays,
  KEEP_FOREVER,
  MIN_MEETING_MS,
  AWAY_GRACE_MS,
  KEEP_MEETINGS,
  type Meeting,
} from "../src/meetings/meetings";

const MIN = 60_000;

function store() {
  const data: Record<string, string> = {};
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    raw: data,
  };
}

describe("spotting a call", () => {
  it.each(["Zoom", "zoom.exe", "Teams", "ms-teams.exe", "Webex", "Discord"])(
    "recognises %s",
    (app) => {
      expect(isMeetingApp(app)).toBe(true);
    },
  );

  it.each(["Chrome", "Code", "", "notepad", "zoolander"])("ignores %s", (app) => {
    expect(isMeetingApp(app)).toBe(false);
  });

  it.each(["meet.google.com", "www.meet.google.com", "acme.zoom.us", "teams.microsoft.com"])(
    "recognises the domain %s",
    (domain) => {
      expect(isMeetingDomain(domain)).toBe(true);
    },
  );

  it.each(["github.com", "google.com", "", null, undefined])(
    "ignores the domain %s",
    (domain) => {
      expect(isMeetingDomain(domain)).toBe(false);
    },
  );

  it("names a meeting by its app or domain, never a window title", () => {
    expect(meetingNameFor({ app: "Zoom", at: 0 })).toBe("Zoom");
    expect(meetingNameFor({ app: "Chrome", domain: "meet.google.com", at: 0 })).toBe(
      "meet.google.com",
    );
    expect(meetingNameFor({ app: "Chrome", domain: "github.com", at: 0 })).toBeNull();
  });
});

describe("MeetingWatch", () => {
  it("records a meeting that ran long enough", () => {
    const w = new MeetingWatch();
    expect(w.see({ app: "Zoom", at: 0 })).toBeNull();
    expect(w.active).toBe(true);
    w.see({ app: "Zoom", at: 30 * MIN });
    const done = w.see({ app: "Code", at: 30 * MIN + AWAY_GRACE_MS });
    expect(done).not.toBeNull();
    expect(done!.where).toBe("Zoom");
    expect(done!.seconds).toBe(30 * 60);
  });

  // A list full of twenty-second glances at a calendar invite is a list
  // nobody reads.
  it("discards anything too short to have been a meeting", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    w.see({ app: "Zoom", at: MIN_MEETING_MS - 1000 });
    const done = w.see({ app: "Code", at: MIN_MEETING_MS - 1000 + AWAY_GRACE_MS });
    expect(done).toBeNull();
  });

  // Taking notes, checking a document and reading a message are all normal
  // things to do mid-call.
  it("survives alt-tabbing away and back", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    expect(w.see({ app: "Code", at: 2 * MIN })).toBeNull();
    expect(w.active).toBe(true);
    w.see({ app: "Zoom", at: 4 * MIN });
    expect(w.active).toBe(true);
    const done = w.see({ app: "Code", at: 40 * MIN });
    expect(done).not.toBeNull();
    // It ended when the call was last in front, not when we noticed.
    expect(done!.seconds).toBe(4 * 60);
  });

  it("ends the meeting after the grace period, not before", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    w.see({ app: "Zoom", at: 20 * MIN });
    expect(w.see({ app: "Code", at: 20 * MIN + AWAY_GRACE_MS - 1 })).toBeNull();
    expect(w.see({ app: "Code", at: 20 * MIN + AWAY_GRACE_MS })).not.toBeNull();
  });

  // An hour in Zoom must not become an hour in Meet.
  it("closes one call before starting another", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    const finished = w.see({ app: "Chrome", domain: "meet.google.com", at: 30 * MIN });
    expect(finished).not.toBeNull();
    expect(finished!.where).toBe("Zoom");
    expect(w.current).toBe("meet.google.com");
  });

  it("can be closed when the app quits", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    w.see({ app: "Zoom", at: 25 * MIN });
    const done = w.close(25 * MIN);
    expect(done).not.toBeNull();
    expect(done!.seconds).toBe(25 * 60);
    expect(w.close(30 * MIN)).toBeNull();
  });

  it("reports how long the current meeting has run", () => {
    const w = new MeetingWatch();
    expect(w.runningSeconds(0)).toBe(0);
    w.see({ app: "Zoom", at: 0 });
    expect(w.runningSeconds(10 * MIN)).toBe(600);
  });
});

describe("notes on a meeting", () => {
  it("keeps what the user typed, and only that", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    expect(w.note("send the spec")).toBe(true);
    expect(w.note("  ")).toBe(false);
    expect(w.currentNotes()).toEqual(["send the spec"]);
    w.see({ app: "Zoom", at: 20 * MIN });
    const done = w.see({ app: "Code", at: 20 * MIN + AWAY_GRACE_MS })!;
    expect(done.notes).toEqual(["send the spec"]);
  });

  // A note attached to nothing is worse than no note.
  it("refuses a note when no meeting is running", () => {
    const w = new MeetingWatch();
    expect(w.note("anything")).toBe(false);
  });

  it("starts each meeting with a clean sheet", () => {
    const w = new MeetingWatch();
    w.see({ app: "Zoom", at: 0 });
    w.note("first");
    w.see({ app: "Zoom", at: 20 * MIN });
    w.see({ app: "Code", at: 20 * MIN + AWAY_GRACE_MS });
    w.see({ app: "Zoom", at: 60 * MIN });
    expect(w.currentNotes()).toEqual([]);
  });
});

describe("the log", () => {
  const one: Meeting = {
    id: "1",
    where: "Zoom",
    startedAt: Date.now(),
    endedAt: Date.now() + 60_000,
    seconds: 1800,
    notes: ["a"],
  };

  it("round-trips", () => {
    const s = store();
    saveMeetings(s, [one]);
    expect(loadMeetings(s)).toEqual([one]);
  });

  it("survives a corrupt log without losing the launch", () => {
    const s = store();
    s.setItem("meetings.log", "{not json");
    expect(loadMeetings(s)).toEqual([]);
    s.setItem("meetings.log", '{"nope":1}');
    expect(loadMeetings(s)).toEqual([]);
    s.setItem("meetings.log", '[{"where":"Zoom"}]');
    expect(loadMeetings(s)).toEqual([]);
  });

  it("stays a list rather than becoming an archive", () => {
    const s = store();
    const many = Array.from({ length: KEEP_MEETINGS + 20 }, (_, i) => ({
      ...one,
      id: String(i),
    }));
    saveMeetings(s, many);
    const back = loadMeetings(s);
    expect(back).toHaveLength(KEEP_MEETINGS);
    // The most recent survive, not the oldest.
    expect(back[back.length - 1]!.id).toBe(String(KEEP_MEETINGS + 19));
  });
});

describe("reporting", () => {
  it("describes a meeting without naming anything private", () => {
    expect(describeMeeting({ ...({} as Meeting), seconds: 1800, where: "Zoom", notes: [] })).toBe(
      "30m in Zoom",
    );
    expect(
      describeMeeting({ ...({} as Meeting), seconds: 5400, where: "Zoom", notes: ["a", "b"] }),
    ).toBe("1h 30m in Zoom — 2 notes");
    expect(
      describeMeeting({ ...({} as Meeting), seconds: 600, where: "Zoom", notes: ["a"] }),
    ).toBe("10m in Zoom — 1 note");
  });

  it("adds up time in meetings, ignoring nonsense", () => {
    expect(
      totalMeetingSeconds([
        { ...one, seconds: 600 },
        { ...one, seconds: 900 },
        { ...one, seconds: NaN },
      ]),
    ).toBe(1500);
  });

  it("finds the meetings that started today, newest first", () => {
    const now = new Date(2026, 8, 2, 14, 0, 0);
    const today = now.getTime();
    const yesterday = today - 24 * 60 * 60 * 1000;
    const list: Meeting[] = [
      { ...one, id: "old", startedAt: yesterday },
      { ...one, id: "early", startedAt: today - 60 * MIN },
      { ...one, id: "late", startedAt: today },
    ];
    expect(meetingsOn(list, now).map((m) => m.id)).toEqual(["late", "early"]);
  });

  const one: Meeting = {
    id: "1",
    where: "Zoom",
    startedAt: Date.now(),
    endedAt: Date.now() + 60_000,
    seconds: 1800,
    notes: [],
  };
});

describe("how long transcripts are kept", () => {
  const at = (iso: string) => new Date(iso).getTime();
  const meeting = (id: string, endedAt: number): Meeting => ({
    id,
    where: "Zoom",
    startedAt: endedAt - 600_000,
    endedAt,
    seconds: 600,
    notes: [],
  });

  // Deleting someone's notes on a schedule they did not ask for is the worse
  // of the two failures, so nothing is dropped until a window is chosen.
  it("keeps everything forever by default", () => {
    const old = [meeting("a", at("2020-01-01T10:00:00"))];
    expect(pruneMeetings(old, KEEP_FOREVER, at("2026-09-05T10:00:00"))).toBe(old);
  });

  it("drops what is past the window and keeps the rest", () => {
    const now = at("2026-09-05T10:00:00");
    const kept = meeting("recent", now - 3 * 24 * 3600_000);
    const gone = meeting("ancient", now - 40 * 24 * 3600_000);
    const out = pruneMeetings([gone, kept], 30, now);
    expect(out.map((m) => m.id)).toEqual(["recent"]);
  });

  // A three-hour call that began just outside the window is not older than the
  // window, and deleting it would be the surprising answer.
  it("judges on when a meeting ended, not when it started", () => {
    const now = at("2026-09-05T10:00:00");
    const long: Meeting = {
      id: "long",
      where: "Meet",
      startedAt: now - 8 * 24 * 3600_000,
      endedAt: now - 6 * 24 * 3600_000,
      seconds: 7200,
      notes: [],
    };
    expect(pruneMeetings([long], 7, now).map((m) => m.id)).toEqual(["long"]);
  });

  it("returns the same array when nothing is dropped, so nothing is rewritten", () => {
    const now = at("2026-09-05T10:00:00");
    const all = [meeting("a", now - 1000)];
    expect(pruneMeetings(all, 30, now)).toBe(all);
  });

  it("refuses a retention window nobody was offered", () => {
    const now = at("2026-09-05T10:00:00");
    const old = [meeting("a", now - 400 * 24 * 3600_000)];
    // A stray value must not delete more than anybody chose.
    expect(pruneMeetings(old, 1, now)).toBe(old);
    expect(isRetentionDays(1)).toBe(false);
    expect(isRetentionDays(30)).toBe(true);
  });

  it("falls back to forever for anything unreadable in storage", () => {
    for (const junk of [undefined, null, "banana", -5, 999, NaN]) {
      expect(readRetentionDays(junk)).toBe(KEEP_FOREVER);
    }
    expect(readRetentionDays("30")).toBe(30);
  });

  // The audio is deleted the moment it is transcribed, so a label promising to
  // delete recordings later would imply Loaf had been holding them all along.
  it("labels the choice in terms of keeping, not deleting", () => {
    expect(retentionLabel(KEEP_FOREVER)).toContain("until you delete");
    expect(retentionLabel(30)).toBe("Kept for 30 days");
  });
});
