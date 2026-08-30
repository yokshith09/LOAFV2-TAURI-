import { escapeHTML } from "../dashboard/html";
import { grouped, GROUP_NOTES } from "../companions/registry";
import { OUTFITS, SEASONAL_ID, seasonalLabel } from "../outfits/registry";
import { displayName, NO_OUTFIT, MAX_NAME_LENGTH, type ClosetState } from "./settings";
import { habitsFor, HABIT_LABELS } from "../behaviour/habits";
import { findCompanion } from "../companions/registry";

/**
 * The closet's markup. Ported from `ClosetWindow.html`.
 *
 * Markup only, and no thumbnails: the cards carry an empty `<canvas>` that
 * `page.ts` draws each companion into afterwards. The reference has to render
 * every thumbnail offscreen with AppKit and paste it in as a base64 PNG,
 * because its drawing code cannot reach inside a WKWebView. Here the renderer
 * and the page are the same runtime, so the canvas *is* the thumbnail — no
 * encode, no megabyte of data: URIs in the document, and the card is drawn by
 * literally the same `renderScene` the desktop uses.
 */

/** Card thumbnail size in CSS pixels. The design space is 170x190. */
export const THUMB = { width: 98, height: 110 } as const;

export const CLOSET_CSS = `
  :root {
    --paper:#FFF9F2; --edge:#E8D8C4; --ink:#33261D; --ink-soft:#6B564A;
    --card:#FFFDF9; --site:#8A5080; --site-dark:#4A3670;
  }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--paper); color:var(--ink);
    font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;
    -webkit-user-select:none; user-select:none; }
  .wrap { padding:18px 24px 20px; }
  h1 { font-size:22px; margin:0 0 7px; }
  .lede { font-size:13.5px; line-height:1.55; margin:0 0 18px; }
  h2 { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em;
       color:var(--ink-soft); margin:0 0 10px; }

  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:0 0 21px; }
  .card { display:block; text-align:left; font-family:inherit; color:var(--ink);
          background:var(--card); border:2px solid var(--edge); border-radius:14px;
          padding:10px 12px 11px; cursor:pointer; }
  .card:hover { border-color:#D9C4A9; }
  .card.on { border-color:var(--site); background:rgba(138,80,128,.055); }
  .thumb { display:flex; align-items:flex-end; justify-content:center;
           height:${THUMB.height}px; border-radius:10px; margin-bottom:9px;
           background:linear-gradient(180deg,#FBEFE0,#F2E1CC); }
  .card.on .thumb { background:linear-gradient(180deg,#F7E9F3,#E9D5E5); }
  /* Height-only so the art can never be squashed by a rounding error. */
  .thumb canvas { height:${THUMB.height}px; width:${THUMB.width}px; display:block; }
  .name { display:block; font-size:14px; font-weight:700; }
  .tag { font-size:8.5px; font-weight:700; text-transform:uppercase; letter-spacing:.07em;
         color:#fff; background:var(--site); border-radius:999px;
         padding:2px 7px 3px; margin-left:6px; vertical-align:1.5px; }
  .species { display:block; font-size:9.5px; text-transform:uppercase; letter-spacing:.09em;
             color:var(--ink-soft); margin:3px 0 5px; }
  .blurb { display:block; font-size:11.5px; line-height:1.45; color:var(--ink-soft); }

  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .chip { display:inline-flex; align-items:center; gap:7px; font-family:inherit; font-size:12.5px;
          color:var(--ink); background:var(--card); border:1.5px solid var(--edge);
          border-radius:999px; padding:7px 14px 7px 12px; cursor:pointer; }
  .chip:hover { border-color:#D9C4A9; }
  .chip.on { background:var(--site); border-color:var(--site); color:#fff; }
  .chip .glyph { font-size:14px; line-height:1; }

  .habits { display:flex; flex-direction:column; gap:8px; }
  .habit { display:flex; align-items:center; gap:9px; cursor:pointer; font-size:13px;
           border:1px solid var(--edge); border-radius:11px; padding:10px 13px;
           background:var(--card); color:var(--ink-soft); }
  .habit.on { border-color:var(--site); background:rgba(138,80,128,.055); color:var(--ink); font-weight:600; }
  .habit input { accent-color:var(--site); margin:0; }

  .fine { font-size:10.5px; color:var(--ink-soft); line-height:1.5; margin:11px 0 0; }
  .foot { font-size:11px; color:var(--ink-soft); line-height:1.55;
          margin:18px 0 0; padding-top:13px; border-top:1px solid var(--edge); }

  .shelf { margin-bottom: 22px; }
  .shelf-head { display:flex; align-items:baseline; gap:8px; margin:0 0 10px; }
  .shelf-head h2 { margin:0; }
  .shelf-note { font-size:11px; color:var(--ink-soft); font-style:italic; }
  .row { display:flex; gap:14px; align-items:flex-end; margin:4px 0 6px; }
  .field { flex:1; display:flex; flex-direction:column; gap:5px; }
  .flabel { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-soft); }
  .field input {
    font-family:inherit; font-size:14px; color:var(--ink);
    background:var(--paper); border:1px solid var(--edge); border-radius:9px;
    padding:8px 11px; outline:none; -webkit-user-select:text; user-select:text;
  }
  .field input:focus { border-color:var(--site); }
  .toggle {
    display:flex; align-items:center; gap:7px; cursor:pointer; white-space:nowrap;
    font-size:12.5px; border:1px solid var(--edge); border-radius:999px; padding:9px 14px;
    background:var(--paper); color:var(--ink-soft);
  }
  .toggle.on { background:var(--site); border-color:var(--site); color:#fff; font-weight:600; }
  .toggle input { accent-color:var(--site); margin:0; }
`;

/**
 * The habit toggles.
 *
 * Drifting is only offered to characters that drift. On anything else it would
 * be a switch wired to nothing, and its default is the opposite of wandering's,
 * which would be baffling sitting right next to it on a cat.
 */
function habitRows(state: ClosetState): string {
  const companion = findCompanion(state.companionId);
  return habitsFor(companion.drifts)
    .map((habit) => {
      const on = state.habits[habit] === true;
      return (
        `<label class="habit${on ? " on" : ""}">` +
        `<input type="checkbox" data-habit="${escapeHTML(habit)}"${on ? " checked" : ""}>` +
        `<span>${escapeHTML(HABIT_LABELS[habit])}</span></label>`
      );
    })
    .join("");
}

/**
 * The mute switch, phrased as the noise rather than the absence of it.
 *
 * A checkbox labelled "Mute" is on when the app is quiet, which reads backwards
 * next to four habits that are on when something happens.
 */
function soundRow(state: ClosetState): string {
  const on = !state.muted;
  return (
    `<label class="habit${on ? " on" : ""}">` +
    `<input type="checkbox" data-sound="muted"${on ? " checked" : ""}>` +
    `<span>Make a noise now and then</span></label>`
  );
}

function chip(id: string, glyph: string, label: string, selected: boolean): string {
  return (
    `<button class="chip${selected ? " on" : ""}" data-outfit="${escapeHTML(id)}">` +
    `<span class="glyph">${escapeHTML(glyph)}</span>${escapeHTML(label)}</button>`
  );
}

export function closetBody(state: ClosetState): string {
  const shelves = grouped()
    .map(({ group, members }) => {
      const cards = members
        .map((c) => {
          const onDuty = c.id === state.companionId;
          const name = displayName(state, c.id, c.defaultName);
          return (
            `<button class="card${onDuty ? " on" : ""}" data-companion="${escapeHTML(c.id)}">` +
            `<span class="thumb"><canvas data-thumb="${escapeHTML(c.id)}"></canvas></span>` +
            `<span class="name">${escapeHTML(name)}` +
            `${onDuty ? '<span class="tag">on duty</span>' : ""}</span>` +
            `<span class="species">${escapeHTML(c.species)}</span>` +
            `<span class="blurb">${escapeHTML(c.blurb)}</span>` +
            `</button>`
          );
        })
        .join("");
      return (
        `<div class="shelf"><div class="shelf-head">` +
        `<h2>${escapeHTML(group)}</h2>` +
        `<span class="shelf-note">${escapeHTML(GROUP_NOTES[group])}</span></div>` +
        `<div class="grid">${cards}</div></div>`
      );
    })
    .join("");

  const chips =
    chip(NO_OUTFIT, "—", "None", state.outfitId === NO_OUTFIT) +
    OUTFITS.map((o) => chip(o.id, o.glyph, o.name, state.outfitId === o.id)).join("") +
    chip(SEASONAL_ID, "📅", seasonalLabel(), state.outfitId === SEASONAL_ID);

  const onDuty = grouped()
    .flatMap((g) => g.members)
    .find((c) => c.id === state.companionId);
  const defaultName = onDuty?.defaultName ?? "";
  // The field shows empty while the name is still the shipped one, so the
  // placeholder does the explaining and clearing it is the obvious reset.
  const custom = state.names[state.companionId] ?? "";

  return `<div class="wrap" id="wrap">
  <h1>Closet</h1>
  <p class="lede">Same job, different animal. They all count the same hours —
  they just have different opinions about them.</p>

  <div class="row">
    <label class="field">
      <span class="flabel">Call them something else</span>
      <input id="petname" type="text" maxlength="${MAX_NAME_LENGTH}"
             placeholder="${escapeHTML(defaultName)}" value="${escapeHTML(custom)}">
    </label>
    <label class="toggle${state.pixelated ? " on" : ""}">
      <input id="pixel" type="checkbox"${state.pixelated ? " checked" : ""}>
      <span>Pixel art</span>
    </label>
  </div>
  <p class="fine">Leave the name empty to go back to ${escapeHTML(defaultName)}.
  Names are kept per character, so renaming this one won't rename the rest.</p>

  ${shelves}

  <h2>Habits <span class="shelf-note">what they get up to on their own</span></h2>
  <div class="habits">${habitRows(state)}${soundRow(state)}</div>
  <p class="fine">Wandering is off until you say otherwise — you put the window
  where it is, and a pet that starts crossing a screen you're working on, unasked,
  is a bug report.</p>

  <h2>What they wear</h2>
  <div class="chips">${chips}</div>
  <p class="fine">Seasonal picks for itself and changes with the month, so you can
  set it once and never think about it again.</p>

  <p class="foot">Clicks apply immediately — look at the corner of your screen.
  The choice sticks between restarts, costs nothing, and stays on this computer
  like everything else here.</p>
</div>`;
}
