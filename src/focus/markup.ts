import { escapeHTML } from "../dashboard/html";
import { PRESETS, RING, CIRCUMFERENCE, stepMinutes, type FocusFrame } from "./view";

/** The focus window's markup and stylesheet. Ported from `PomodoroWindow.swift`. */

export const FOCUS_CSS = `
  :root {
    --paper:#FFF9F2; --edge:#E8D8C4; --ink:#33261D; --ink-soft:#6B564A;
    --card:#FFFDF9; --plum:#8A5080; --plum-dark:#4A3670;
    --amber:#F2A65A; --green:#5C9E62;
  }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--paper); color:var(--ink);
    font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;
    -webkit-user-select:none; user-select:none; }

  /* One variable carries the state colour to the arc, the dot and the finished
     glow, so a fifth state would mean one new line here rather than five. */
  body { --accent:var(--plum); }
  body[data-state="running"]  { --accent:var(--amber); }
  body[data-state="paused"]   { --accent:var(--plum-dark); }
  body[data-state="finished"] { --accent:var(--green); }

  .wrap { padding:18px 24px 20px; }
  h1 { font-size:22px; margin:0 0 6px; }
  .lede { font-size:12.5px; line-height:1.5; color:var(--ink-soft); margin:0 0 10px; }
  h2 { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-soft);
       margin:17px 0 8px; display:flex; align-items:baseline; gap:7px; }
  .unit { text-transform:none; letter-spacing:0; font-style:italic; font-size:11px; opacity:.75; }

  .dial { position:relative; width:${RING.box}px; height:${RING.box}px; margin:0 auto; }
  /* Start the arc at twelve o'clock rather than three. */
  .ring { width:100%; height:100%; transform:rotate(-90deg); display:block; }
  .ring circle { fill:none; stroke-width:11; }
  .track { stroke:var(--edge); }
  .arc { stroke:var(--accent); stroke-linecap:round; transition:stroke-dashoffset .15s linear; }
  body[data-state="paused"] .arc { opacity:.45; }
  .dial::before { content:""; position:absolute; inset:16px; border-radius:50%; }
  /* Filled only when it is over, so "done" reads from across the room. */
  body[data-state="finished"] .dial::before { background:rgba(92,158,98,.10); }

  .face { position:absolute; inset:0; display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:3px; }
  .pill { display:inline-flex; align-items:center; gap:5px; font-size:9.5px; font-weight:700;
          text-transform:uppercase; letter-spacing:.13em; color:var(--ink-soft); }
  .dot { width:6px; height:6px; border-radius:50%; background:var(--accent); }
  /* Tabular figures: proportional ones make the whole clock twitch sideways every
     time a 1 turns into an 8. */
  .clock { font-size:48px; font-weight:600; line-height:1.06; letter-spacing:-.015em;
           font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
  .clock.long { font-size:37px; }
  body[data-state="paused"] .clock { color:var(--ink-soft); }
  .sub { font-size:10.5px; color:var(--ink-soft); }

  .state { text-align:center; margin:9px 0 0; }
  #title { display:block; font-size:15px; font-weight:700; margin-bottom:3px; }
  /* Two lines' worth of space, reserved whether the sentence needs it or not.
     A frame rewrites this copy without re-measuring the window — so if the block
     could grow, changing state mid-session would push the footer out of a window
     that was sized for the shorter sentence. */
  #note { display:flex; align-items:center; justify-content:center; min-height:36px;
          font-size:12px; line-height:1.5; color:var(--ink-soft);
          max-width:320px; margin:0 auto; }

  .presets { display:grid; grid-template-columns:repeat(${PRESETS.length},1fr); gap:7px; }
  .preset { font-family:inherit; font-size:14px; font-weight:600; color:var(--ink);
            background:var(--card); border:1.5px solid var(--edge); border-radius:11px;
            padding:9px 0; cursor:pointer; font-variant-numeric:tabular-nums; }
  .preset:hover { border-color:#D9C4A9; }
  .preset.on { background:var(--plum); border-color:var(--plum); color:#fff; }

  .steps { display:flex; gap:7px; }
  .step { flex:1; font-family:inherit; font-size:13.5px; font-weight:600; color:var(--ink-soft);
          background:var(--card); border:1.5px solid var(--edge); border-radius:11px;
          padding:9px 0; cursor:pointer; font-variant-numeric:tabular-nums; }
  .step:hover { border-color:var(--plum); color:var(--ink); }

  .actions { display:flex; gap:9px; align-items:center; margin:16px 0 0; }
  button { font-family:inherit; cursor:pointer; }
  .cta { font-size:13px; font-weight:600; background:var(--plum); color:#fff;
         border:none; border-radius:999px; padding:10px 16px; min-width:88px; }
  .cta:hover { background:var(--plum-dark); }
  .ghost { font-size:12.5px; background:none; border:1px solid var(--edge);
           color:var(--ink-soft); border-radius:999px; padding:9px 15px; }
  .ghost:hover { border-color:var(--plum); color:var(--ink); }

  .foot { font-size:10.5px; color:var(--ink-soft); line-height:1.55;
          margin:16px 0 0; padding-top:12px; border-top:1px solid var(--edge); }
`;

/**
 * Built once. Everything that changes is updated in place afterwards by
 * `applyFrame` — the reference's reason holds here too: rebuilding the page
 * while the clock is running flickers, and replacing the DOM under the cursor
 * loses whatever the user was about to click.
 */
export function focusBody(frame: FocusFrame): string {
  const presets = PRESETS.map(
    (m) =>
      `<button class="preset${frame.minutes === m ? " on" : ""}" data-min="${m}" ` +
      `data-focus-cmd="preset:${m}">${m}</button>`,
  ).join("");

  const steps = stepMinutes()
    .map((m) => {
      // A real minus sign in the label, an ASCII hyphen in the command — the
      // command is parsed as a number at the other end.
      const label = m < 0 ? `−${Math.abs(m)}` : `+${m}`;
      return `<button class="step" data-focus-cmd="adjust:${m}">${label}</button>`;
    })
    .join("");

  const mid = RING.box / 2;
  return `<div class="wrap" id="wrap">
  <h1>Focus</h1>
  <p class="lede">He can't make you concentrate. He can only sit there,
  counting, until you do.</p>

  <div class="dial">
    <svg class="ring" viewBox="0 0 ${RING.box} ${RING.box}" aria-hidden="true">
      <circle class="track" cx="${mid}" cy="${mid}" r="${RING.radius}"></circle>
      <circle class="arc" id="arc" cx="${mid}" cy="${mid}" r="${RING.radius}"
              stroke-dasharray="${CIRCUMFERENCE.toFixed(3)}"
              stroke-dashoffset="${frame.dash.toFixed(3)}"></circle>
    </svg>
    <div class="face">
      <span class="pill"><i class="dot"></i><span id="pill">${escapeHTML(frame.words.pill)}</span></span>
      <span class="clock${frame.long ? " long" : ""}" id="clock">${escapeHTML(frame.clock)}</span>
      <span class="sub" id="sub">${escapeHTML(frame.words.sub)}</span>
    </div>
  </div>

  <p class="state"><strong id="title">${escapeHTML(frame.words.title)}</strong>
  <span id="note">${escapeHTML(frame.words.note)}</span></p>

  <h2>Session length <span class="unit">minutes</span></h2>
  <div class="presets">${presets}</div>

  <h2>Nudge it <span class="unit">works mid-session too</span></h2>
  <div class="steps">${steps}</div>

  <div class="actions">
    <button class="cta" id="act" data-focus-cmd="toggle">${escapeHTML(frame.words.action)}</button>
    <button class="ghost" data-focus-cmd="reset">Reset</button>
  </div>

  <p class="foot">The countdown runs off a wall clock, not a tally, so a closed
  lid or a busy machine can't quietly shorten your session. Nudging while it runs
  moves the finish line, not the start.</p>
</div>`;
}
