/**
 * The Search tab: finding a thing you said weeks ago.
 *
 * THE FEATURE LOAF HAS NEVER HAD. Until the store landed, a phrase from a
 * meeting six weeks ago could only be found by scrolling a list. This is the
 * screen that changes that, and it is also where deleting and exporting live —
 * on purpose. Search, delete and export are the same promise seen from three
 * sides: **you can find what Loaf kept, you can take it away with you, and you
 * can make it stop existing.** Splitting them across three screens would let one
 * of them quietly not get built.
 *
 * Pure rendering, like the rest of the dashboard's panels. The interesting cases
 * are all rendering decisions — a search that has not been run yet versus one
 * that found nothing, a line that belongs to no meeting, a delete that needs
 * confirming — and rendering decisions that live in an event handler are
 * decisions nobody tests.
 */

import { escapeHTML } from "../dashboard/html";

/** One line of transcript or one note, as the store returns it. */
export interface Hit {
  readonly id: number;
  /** The meeting it was said in, or null for a standalone note. */
  readonly meeting: string | null;
  /** Where that meeting was — "Zoom". Empty for a note. */
  readonly place: string;
  /** Seconds since the epoch. */
  readonly at: number;
  readonly text: string;
}

/** What a delete would remove, or did. */
export interface Removal {
  readonly meetings: number;
  readonly lines: number;
  readonly days: number;
}

export interface SearchState {
  /** What is in the box. */
  readonly phrase: string;
  /**
   * The results, or null when no search has been run.
   *
   * Null and empty are different and the screen says so: "type something to
   * look" and "nothing matched" are answers to different questions, and showing
   * the second before anyone has searched reads as "Loaf has forgotten
   * everything".
   */
  readonly hits: readonly Hit[] | null;
  readonly searching: boolean;
  /** What went wrong, if anything. */
  readonly error: string;
  /** A delete waiting to be confirmed. */
  readonly pending: PendingDelete | null;
  /** What the last finished action did, for the line under the buttons. */
  readonly lastAction: string;
  /**
   * What the pending delete would actually remove, once Rust has counted it.
   *
   * M3 asked for "a delete screen that says exactly what will go, and asks
   * once". It asked once and said nothing: the count only appeared AFTERWARDS,
   * in the past tense, which is the wrong order for the one action in this app
   * that cannot be undone. `store_preview_range` had been written to answer
   * this and had no caller.
   *
   * Null while counting, or when the kind of delete cannot be counted cheaply.
   */
  readonly preview: Removal | null;
  /** The range boxes. Kept in state so a re-render does not clear them. */
  readonly from: string;
  readonly to: string;
}


export type PendingDelete =
  | { readonly kind: "everything" }
  | { readonly kind: "matching"; readonly phrase: string }
  | { readonly kind: "range"; readonly from: string; readonly to: string };

export const EMPTY_SEARCH: SearchState = {
  phrase: "",
  hits: null,
  searching: false,
  error: "",
  pending: null,
  lastAction: "",
  preview: null,
  from: "",
  to: "",
};

export function isHit(v: unknown): v is Hit {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === "number" &&
    (h.meeting === null || typeof h.meeting === "string") &&
    typeof h.place === "string" &&
    typeof h.at === "number" &&
    Number.isFinite(h.at) &&
    typeof h.text === "string"
  );
}

export function isRemoval(v: unknown): v is Removal {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.meetings === "number" &&
    typeof r.lines === "number" &&
    typeof r.days === "number"
  );
}

/** When something was said, in words a person reads rather than a timestamp. */
export function whenSaid(at: number, now: number): string {
  const days = Math.floor((Math.floor(now / 1000) - at) / 86_400);
  if (days < 0) return "just now";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/**
 * Mark the searched words inside a result.
 *
 * Escapes FIRST and then inserts markup, never the other way round — the text
 * is a transcript of whatever was said near a microphone, and it is the least
 * trustworthy string on the page.
 */
export function highlight(text: string, phrase: string): string {
  const safe = escapeHTML(text);
  const words = phrase
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((w) => w.length > 1)
    .map((w) => escapeHTML(w));
  if (words.length === 0) return safe;
  // Longest first, so "billing migration" does not get half-marked by "billing".
  words.sort((a, b) => b.length - a.length);
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return safe.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

/** A plain sentence for what a delete did or would do. */
export function describeRemoval(r: Removal): string {
  const bits: string[] = [];
  if (r.meetings > 0) bits.push(`${r.meetings} meeting${r.meetings === 1 ? "" : "s"}`);
  if (r.lines > 0) bits.push(`${r.lines} line${r.lines === 1 ? "" : "s"}`);
  if (r.days > 0) bits.push(`${r.days} day${r.days === 1 ? "" : "s"} of screen time`);
  if (bits.length === 0) return "nothing";
  if (bits.length === 1) return bits[0]!;
  return `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}`;
}

function resultsBlock(state: SearchState, now: number): string {
  if (state.error) {
    return `<p class="sr-error">${escapeHTML(state.error)}</p>`;
  }
  if (state.searching) {
    return `<p class="sr-empty">Looking…</p>`;
  }
  if (state.hits === null) {
    return (
      `<p class="sr-empty">Type something above to look through everything Loaf has ` +
      `kept — your meeting transcripts and your notes.</p>`
    );
  }
  if (state.hits.length === 0) {
    return (
      `<p class="sr-empty">Nothing matched <b>${escapeHTML(state.phrase)}</b>. ` +
      `Loaf only searches what it recorded, so a meeting you did not record is not in here.</p>`
    );
  }

  const rows = state.hits
    .map((h) => {
      const where = h.meeting
        ? `${escapeHTML(h.place || "a meeting")}`
        : "a note";
      return (
        `<div class="sr-hit">` +
        `<p class="sr-text">${highlight(h.text, state.phrase)}</p>` +
        `<p class="sr-where">${where} · ${escapeHTML(whenSaid(h.at, now))}` +
        (h.meeting
          ? ` · <button class="sr-link" data-search-forget-meeting="${escapeHTML(h.meeting)}">forget this meeting</button>`
          : "") +
        `</p></div>`
      );
    })
    .join("");

  const count = state.hits.length;
  return (
    `<p class="sr-count">${count} result${count === 1 ? "" : "s"}</p>` +
    `<div class="sr-hits">${rows}</div>`
  );
}

function confirmBlock(pending: PendingDelete | null, preview: Removal | null): string {
  if (!pending) return "";
  let what: string;
  if (pending.kind === "everything") {
    what = "<b>everything</b> — every transcript, every note and all of your screen time";
  } else if (pending.kind === "matching") {
    what = `every line mentioning <b>${escapeHTML(pending.phrase)}</b>`;
  } else {
    what = `everything between <b>${escapeHTML(pending.from)}</b> and <b>${escapeHTML(pending.to)}</b>`;
  }

  // THE COUNT, BEFORE rather than after. A range typed a month wrong looks
  // exactly like a range typed right until something says how much is in it.
  let counted = "";
  if (pending.kind === "range") {
    if (preview === null) {
      counted = `<p class="sr-count">Counting what is in that range…</p>`;
    } else {
      const empty = preview.meetings === 0 && preview.lines === 0 && preview.days === 0;
      counted = empty
        ? `<p class="sr-count"><b>There is nothing in that range.</b> Nothing would be deleted.</p>`
        : `<p class="sr-count">That is <b>${escapeHTML(describeRemoval(preview))}</b>.</p>`;
    }
  }

  return (
    `<div class="sr-confirm">` +
    `<p>This will delete ${what}. It cannot be undone, and Loaf keeps no copy.</p>` +
    counted +
    `<div class="sr-actions">` +
    `<button class="sr-btn danger" data-search-confirm="1">Yes, delete it</button>` +
    `<button class="sr-btn" data-search-cancel="1">Cancel</button>` +
    `</div></div>`
  );
}

/**
 * Forgetting a stretch of time.
 *
 * M3 promised deleting "one meeting, a date range, everything, or everything
 * mentioning one person". Three of those four shipped. The range existed as a
 * case in the type, a branch in the confirm handler and a Rust command that
 * deleted it — with **no way to ask for it**, which is why the command that
 * counts a range first had no caller either. A feature reachable only from the
 * type system is not a feature.
 *
 * Dates rather than a free-text range: the two inputs are the whole interface,
 * the browser validates them, and there is nothing to parse or misparse. Empty
 * boxes disable the button rather than defaulting to anything — a delete whose
 * range Loaf guessed is the worst button in the app.
 */
function rangeBlock(state: SearchState): string {
  const ready = state.from.trim() !== "" && state.to.trim() !== "";
  return (
    `<div class="sr-range">` +
    `<label for="sr-from">Forget a stretch of time</label>` +
    `<div class="sr-range-row">` +
    `<input id="sr-from" type="date" value="${escapeHTML(state.from)}" aria-label="from">` +
    `<span class="sr-to-word">to</span>` +
    `<input id="sr-to" type="date" value="${escapeHTML(state.to)}" aria-label="to">` +
    `<button class="sr-btn" data-search-forget-range="1"${ready ? "" : " disabled"}>` +
    `Forget that range</button>` +
    `</div>` +
    `<p class="sr-fine">Loaf counts what is in there and shows you before anything goes.</p>` +
    `</div>`
  );
}

export function searchPanel(state: SearchState, now: number): string {
  return (
    `<h2>Search</h2>` +
    `<div class="sr-box">` +
    `<input id="sr-input" type="search" placeholder="a phrase you remember saying" ` +
    `value="${escapeHTML(state.phrase)}" maxlength="200" autocomplete="off">` +
    `<button class="sr-btn primary" data-search-go="1">Search</button>` +
    `</div>` +
    resultsBlock(state, now) +
    `<h2>Your data</h2>` +
    `<p class="sr-fine">Everything Loaf keeps is in one file on this computer. ` +
    `You can take it with you, and you can make it stop existing.</p>` +
    (state.lastAction ? `<p class="sr-done">${escapeHTML(state.lastAction)}</p>` : "") +
    confirmBlock(state.pending, state.preview) +
    rangeBlock(state) +
    `<div class="sr-actions">` +
    `<button class="sr-btn" data-search-export="1">Export everything</button>` +
    (state.phrase.trim()
      ? `<button class="sr-btn" data-search-forget-matching="1">Forget everything about “${escapeHTML(state.phrase)}”</button>`
      : "") +
    `<button class="sr-btn danger" data-search-forget-all="1">Delete everything</button>` +
    `</div>`
  );
}

export const SEARCH_CSS = `
.sr-box{display:flex;gap:8px;margin:0 0 14px}
.sr-box input{flex:1;font:inherit;font-size:13px;padding:7px 10px;border-radius:8px;
  border:1px solid var(--line);background:transparent;color:inherit}
.sr-btn{font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;
  border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.sr-btn:hover{background:rgba(127,127,127,.12)}
.sr-btn.primary{border-color:#c9822f}
.sr-btn.danger{color:#d05353;border-color:#d05353}
.sr-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.sr-count{font-size:11px;opacity:.6;margin:0 0 8px}
.sr-hits{display:flex;flex-direction:column;gap:8px}
.sr-hit{border:1px solid var(--line);border-radius:10px;padding:9px 12px}
.sr-text{margin:0;font-size:13px;line-height:1.5}
.sr-text mark{background:rgba(201,130,47,.28);color:inherit;border-radius:3px;padding:0 2px}
.sr-where{margin:5px 0 0;font-size:11px;opacity:.65}
.sr-link{font:inherit;font-size:11px;background:none;border:0;padding:0;color:#d05353;
  cursor:pointer;text-decoration:underline}
.sr-empty{font-size:12px;opacity:.7;margin:10px 0}
.sr-error{font-size:12px;color:#d05353;margin:10px 0}
.sr-fine{font-size:11px;opacity:.65;margin:4px 0 8px}
.sr-done{font-size:12px;margin:6px 0;opacity:.85}
.sr-confirm{border:1px solid #d05353;border-radius:10px;padding:12px 14px;margin:10px 0}
.sr-confirm p{margin:0 0 8px;font-size:12px;line-height:1.5}
`;
