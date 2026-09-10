import { describe, it, expect } from "vitest";
import {
  searchPanel,
  highlight,
  whenSaid,
  describeRemoval,
  isHit,
  isRemoval,
  EMPTY_SEARCH,
  type SearchState,
  type Hit,
} from "../src/search/search";

const NOW = 1_700_000_000_000;
const SECS = Math.floor(NOW / 1000);

const hit = (over: Partial<Hit> = {}): Hit => ({
  id: 1,
  meeting: "m1",
  place: "Google Meet",
  at: SECS - 3600,
  text: "Priya is blocked on the billing migration",
  ...over,
});

const state = (over: Partial<SearchState> = {}): SearchState => ({
  ...EMPTY_SEARCH,
  ...over,
});

describe("before anything has been searched", () => {
  // "Type something to look" and "nothing matched" answer different questions.
  // Showing the second before anyone has searched reads as "Loaf has forgotten
  // everything", which is the opposite of the truth.
  it("invites a search rather than claiming nothing was found", () => {
    const html = searchPanel(EMPTY_SEARCH, NOW);
    expect(html).toContain("Type something above");
    expect(html).not.toContain("Nothing matched");
  });

  it("offers export and delete even with an empty box", () => {
    const html = searchPanel(EMPTY_SEARCH, NOW);
    expect(html).toContain("data-search-export");
    expect(html).toContain("data-search-forget-all");
  });

  it("does not offer to forget a phrase when there is no phrase", () => {
    expect(searchPanel(EMPTY_SEARCH, NOW)).not.toContain("data-search-forget-matching");
  });
});

describe("results", () => {
  it("shows the line, where it was said, and when", () => {
    const html = searchPanel(state({ phrase: "billing", hits: [hit()] }), NOW);
    // The searched word is wrapped in <mark>, so the phrase is not contiguous
    // in the output — which is the point of the feature.
    expect(html).toContain("<mark>billing</mark> migration");
    expect(html).toContain("Priya is blocked");
    expect(html).toContain("Google Meet");
    expect(html).toContain("today");
  });

  it("counts them", () => {
    const html = searchPanel(
      state({ phrase: "x", hits: [hit(), hit({ id: 2 })] }),
      NOW,
    );
    expect(html).toContain("2 results");
  });

  it("says one result in the singular", () => {
    expect(searchPanel(state({ phrase: "x", hits: [hit()] }), NOW)).toContain("1 result<");
  });

  it("calls a standalone note a note, not a meeting", () => {
    const html = searchPanel(
      state({ phrase: "invoice", hits: [hit({ meeting: null, place: "" })] }),
      NOW,
    );
    expect(html).toContain("a note");
    expect(html).not.toContain("data-search-forget-meeting");
  });

  it("offers to forget the meeting a result came from", () => {
    const html = searchPanel(state({ phrase: "x", hits: [hit()] }), NOW);
    expect(html).toContain('data-search-forget-meeting="m1"');
  });

  // Loaf only searches what it recorded, and saying so is the difference between
  // "you never said that" and "you did not record that meeting".
  it("explains an empty result rather than just showing nothing", () => {
    const html = searchPanel(state({ phrase: "unicorn", hits: [] }), NOW);
    expect(html).toContain("Nothing matched");
    expect(html).toContain("did not record");
  });

  it("says it is looking while it looks", () => {
    expect(searchPanel(state({ searching: true }), NOW)).toContain("Looking");
  });

  it("shows an error instead of pretending there were no results", () => {
    const html = searchPanel(state({ phrase: "x", hits: [], error: "the store is locked" }), NOW);
    expect(html).toContain("the store is locked");
    expect(html).not.toContain("Nothing matched");
  });
});

describe("highlighting", () => {
  it("marks the searched word", () => {
    expect(highlight("the billing migration", "billing")).toContain("<mark>billing</mark>");
  });

  it("is case insensitive", () => {
    expect(highlight("Billing matters", "billing")).toContain("<mark>Billing</mark>");
  });

  it("marks the longest phrase rather than half of it", () => {
    const out = highlight("the billing migration", "billing migration");
    expect(out).toContain("<mark>billing</mark>");
    expect(out).toContain("<mark>migration</mark>");
  });

  // A transcript is whatever was said near a microphone. It is the least
  // trustworthy string on the page, so it is escaped BEFORE any markup is put in.
  it("escapes the text before inserting any markup", () => {
    const out = highlight('<script>alert(1)</script> billing', "billing");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<mark>billing</mark>");
  });

  it("escapes the phrase too, so a search cannot inject", () => {
    const out = highlight("hello world", "<img src=x>");
    expect(out).not.toContain("<img");
  });

  it("cannot be broken by regex characters in the phrase", () => {
    expect(() => highlight("a (b) c", "(b)")).not.toThrow();
    expect(() => highlight("price is $5", "$5")).not.toThrow();
    expect(() => highlight("what?", "what?")).not.toThrow();
  });

  it("ignores single letters, which would mark everything", () => {
    const out = highlight("a cat sat", "a");
    expect(out).not.toContain("<mark>");
  });
});

describe("whenSaid", () => {
  it("reads in days, then weeks, then months", () => {
    expect(whenSaid(SECS, NOW)).toBe("today");
    expect(whenSaid(SECS - 86_400, NOW)).toBe("yesterday");
    expect(whenSaid(SECS - 3 * 86_400, NOW)).toBe("3 days ago");
    expect(whenSaid(SECS - 8 * 86_400, NOW)).toBe("last week");
    expect(whenSaid(SECS - 21 * 86_400, NOW)).toBe("3 weeks ago");
    expect(whenSaid(SECS - 120 * 86_400, NOW)).toBe("4 months ago");
  });

  // Clocks go backwards. "in -3 days" is worse than "just now".
  it("does not go negative on a timestamp from the future", () => {
    expect(whenSaid(SECS + 90_000, NOW)).toBe("just now");
  });
});

describe("describing a delete", () => {
  it("counts each kind, in plain words", () => {
    expect(describeRemoval({ meetings: 1, lines: 4, days: 0 })).toBe("1 meeting and 4 lines");
    expect(describeRemoval({ meetings: 0, lines: 1, days: 0 })).toBe("1 line");
    expect(describeRemoval({ meetings: 2, lines: 3, days: 5 })).toBe(
      "2 meetings, 3 lines and 5 days of screen time",
    );
  });

  it("says nothing rather than an empty string", () => {
    expect(describeRemoval({ meetings: 0, lines: 0, days: 0 })).toBe("nothing");
  });
});

describe("confirming a delete", () => {
  // Deleting somebody's recorded life should take two deliberate actions, and
  // the second one has to say what is about to go.
  it("names exactly what will go, for everything", () => {
    const html = searchPanel(state({ pending: { kind: "everything" } }), NOW);
    expect(html).toContain("every transcript");
    expect(html).toContain("cannot be undone");
    expect(html).toContain("data-search-confirm");
    expect(html).toContain("data-search-cancel");
  });

  it("names the phrase, for a phrase delete", () => {
    const html = searchPanel(
      state({ pending: { kind: "matching", phrase: "acquisition" } }),
      NOW,
    );
    expect(html).toContain("acquisition");
  });

  it("names both dates, for a range", () => {
    const html = searchPanel(
      state({ pending: { kind: "range", from: "2026-03-01", to: "2026-03-31" } }),
      NOW,
    );
    expect(html).toContain("2026-03-01");
    expect(html).toContain("2026-03-31");
  });

  it("escapes a phrase in the confirmation", () => {
    const html = searchPanel(
      state({ pending: { kind: "matching", phrase: "<img src=x>" } }),
      NOW,
    );
    expect(html).not.toContain("<img");
  });

  it("shows no confirmation when nothing is pending", () => {
    expect(searchPanel(EMPTY_SEARCH, NOW)).not.toContain("data-search-confirm");
  });
});

describe("guards", () => {
  it("accepts a well-formed hit", () => {
    expect(isHit(hit())).toBe(true);
    expect(isHit(hit({ meeting: null }))).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isHit(null)).toBe(false);
    expect(isHit({})).toBe(false);
    expect(isHit({ ...hit(), at: NaN })).toBe(false);
    expect(isHit({ ...hit(), id: "1" })).toBe(false);
  });
  it("accepts a well-formed removal", () => {
    expect(isRemoval({ meetings: 0, lines: 0, days: 0 })).toBe(true);
    expect(isRemoval({ meetings: 0 })).toBe(false);
  });
});

describe("escaping the panel itself", () => {
  it("escapes the phrase in the input value", () => {
    const html = searchPanel(state({ phrase: '"><img src=x>' }), NOW);
    expect(html).not.toContain('"><img');
  });
});

/**
 * Forgetting a stretch of time — the quarter of M3's delete promise that
 * shipped as a type and nothing else.
 *
 * `store_delete_range` deleted it, `store_preview_range` counted it, the state
 * had a `range` case and the confirm handler had a branch for it. Nothing could
 * ask for one. These tests cover the entry point and, more importantly, the
 * count appearing BEFORE the delete rather than after.
 */
describe("forgetting a date range", () => {
  it("offers the two boxes and the button", () => {
    const html = searchPanel(EMPTY_SEARCH, NOW);
    expect(html).toContain('id="sr-from"');
    expect(html).toContain('id="sr-to"');
    expect(html).toContain("data-search-forget-range");
  });

  // A delete whose range Loaf guessed is the worst button in the app.
  it("will not offer to delete until both dates are given", () => {
    expect(searchPanel(EMPTY_SEARCH, NOW)).toContain("disabled");
    const half = { ...EMPTY_SEARCH, from: "2026-09-01" };
    expect(searchPanel(half, NOW)).toContain("disabled");
    const both = { ...EMPTY_SEARCH, from: "2026-09-01", to: "2026-09-08" };
    expect(searchPanel(both, NOW)).not.toContain("disabled");
  });

  it("keeps the dates through a re-render", () => {
    const html = searchPanel({ ...EMPTY_SEARCH, from: "2026-09-01", to: "2026-09-08" }, NOW);
    expect(html).toContain("2026-09-01");
    expect(html).toContain("2026-09-08");
  });

  it("says it is counting while it counts", () => {
    const html = searchPanel(
      { ...EMPTY_SEARCH, pending: { kind: "range", from: "2026-09-01", to: "2026-09-08" } },
      NOW,
    );
    expect(html.toLowerCase()).toContain("counting");
  });

  // The whole point: the damage is named before it is done.
  it("names what will go once it has counted", () => {
    const html = searchPanel(
      {
        ...EMPTY_SEARCH,
        pending: { kind: "range", from: "2026-09-01", to: "2026-09-08" },
        preview: { meetings: 3, lines: 214, days: 7 },
      },
      NOW,
    );
    expect(html).toContain("3 meetings");
    expect(html).toContain("214 lines");
    expect(html).toContain("7 days");
  });

  it("says an empty range is empty rather than counting zeros", () => {
    const html = searchPanel(
      {
        ...EMPTY_SEARCH,
        pending: { kind: "range", from: "2020-01-01", to: "2020-01-02" },
        preview: { meetings: 0, lines: 0, days: 0 },
      },
      NOW,
    );
    expect(html.toLowerCase()).toContain("nothing in that range");
    expect(html).not.toContain("0 meetings");
  });

  it("counts only for a range — the other two deletes have nothing cheap to count", () => {
    const everything = searchPanel({ ...EMPTY_SEARCH, pending: { kind: "everything" } }, NOW);
    expect(everything.toLowerCase()).not.toContain("counting");
    const matching = searchPanel(
      { ...EMPTY_SEARCH, pending: { kind: "matching", phrase: "priya" } },
      NOW,
    );
    expect(matching.toLowerCase()).not.toContain("counting");
  });

  it("still says it cannot be undone", () => {
    const html = searchPanel(
      {
        ...EMPTY_SEARCH,
        pending: { kind: "range", from: "2026-09-01", to: "2026-09-08" },
        preview: { meetings: 1, lines: 2, days: 0 },
      },
      NOW,
    );
    expect(html).toContain("cannot be undone");
  });
});
