import { escapeHTML } from "../dashboard/html";
import { habitsFor, HABIT_LABELS } from "../behaviour/habits";
import { findCompanion } from "../companions/registry";
import { LISTEN_MODES, LABELS, DESCRIPTIONS } from "../voice/mode";
import { MAX_WAKE_LENGTH, wakeWordsFor } from "../voice/wake";
import {
  PICKABLE_ENGINES,
  ENGINE_INFO,
  unavailableReason,
  whisperReason,
  leavesMachine,
} from "../voice/engine";
import type { ClosetState } from "../closet/settings";

/**
 * Every setting that is not about how the character looks.
 *
 * WHY THIS IS ITS OWN MODULE. These controls used to live in the closet, next
 * to eighteen animal portraits and a row of scarves — which put "does Loaf send
 * my audio to a server" in a wardrobe. Worse, the dashboard had grown its own
 * partial answer to the same questions, so there were two places that disagreed
 * about what was switched on.
 *
 * They are all in the dashboard now, and the closet keeps only what it is for:
 * which character, what it wears, and how see-through it is. This module is the
 * markup, so that the one set of controls has one definition rather than a copy
 * per window.
 *
 * IT STILL DECIDES NOTHING. Exactly as the closet's own header says: these emit
 * the same `ClosetPick` events the closet always did, and the companion window
 * remains the single owner of the state. Moving the controls did not move the
 * ownership.
 */

/** How long the cursor has to rest on Loaf before the microphone opens. */
const HOLD_CHOICES: readonly number[] = [2000, 3000, 5000, 8000, 12000];

/**
 * How much of the time Loaf may listen, and the wake word when that is
 * "always".
 *
 * The wake-word box only appears in the mode that uses one. A field wired to
 * nothing, sitting under "when I click", is worse than no field.
 */
export function listenRow(state: ClosetState): string {
  const mode = state.listenMode;
  const on = mode !== "off";

  // OFF IS A SWITCH, NOT AN ENTRY IN A LIST. It used to be the first option in
  // a four-way dropdown, which meant the only answer to "is this thing
  // listening to me" was to open a menu and read which line happened to be
  // selected. A microphone deserves a control you can read at a glance from
  // across the room.
  const master =
    `<label class="habit${on ? " on" : ""}">` +
    `<input type="checkbox" data-listen-on${on ? " checked" : ""}>` +
    `<span>Listen for my wake word</span></label>`;

  if (!on) {
    return (
      `<div class="listen">${master}` +
      `<p class="why">${escapeHTML(DESCRIPTIONS.off)}</p></div>`
    );
  }

  // "off" is deliberately absent here: the switch above is what turns it off,
  // and offering the same thing twice is how the two end up disagreeing.
  // The "always" label names the wake word, so it has to name the one that is
  // actually set — the same bug the badge had, in the other place it shows.
  const spoken = wakeWordsFor(state.wakeWord)[0] ?? "hey loaf";
  const labelFor = (m: (typeof LISTEN_MODES)[number]): string =>
    m === "always" ? `Always — listen for “${spoken}”` : LABELS[m];

  const options = LISTEN_MODES.filter((m) => m !== "off")
    .map(
      (m) =>
        `<option value="${escapeHTML(m)}"${m === mode ? " selected" : ""}>` +
        `${escapeHTML(labelFor(m))}</option>`,
    )
    .join("");

  return (
    `<div class="listen${mode === "always" ? " hot" : ""}">` +
    master +
    `<select data-listen-mode>${options}</select>` +
    `<p class="why">${escapeHTML(DESCRIPTIONS[mode])}</p>` +
    (mode === "always"
      ? `<input type="text" data-wake-word maxlength="${MAX_WAKE_LENGTH}" ` +
        `placeholder="hey loaf" value="${escapeHTML(state.wakeWord ?? "")}">` +
        `<p class="why">What Loaf answers to. Leave empty for “hey loaf”.</p>`
      : "") +
    "</div>"
  );
}

/** How long the cursor has to rest before the microphone opens. */
export function holdRow(state: ClosetState): string {
  if (state.listenMode !== "hover") return "";
  const options = HOLD_CHOICES.map(
    (ms) =>
      `<option value="${ms}"${ms === state.hoverListenMs ? " selected" : ""}>` +
      `${ms / 1000} seconds</option>`,
  ).join("");
  return (
    `<div class="listen"><select data-hold>${options}</select>` +
    `<p class="why">How long to hold the cursor on Loaf before it listens. ` +
    `The day’s card still appears straight away.</p></div>`
  );
}

/**
 * Which recogniser, and what each one costs.
 *
 * All three are always listed, including ones that cannot run yet, with the
 * reason attached. Hiding an engine leaves people wondering whether Loaf can
 * do dictation at all; showing it with "Not downloaded yet" answers that.
 */
export function engineRow(state: ClosetState): string {
  const options = PICKABLE_ENGINES.map((id) => {
    const why = unavailableReason(id, state.engineAvailability);
    const label = why === null ? ENGINE_INFO[id].label : `${ENGINE_INFO[id].label} — ${why}`;
    return (
      `<option value="${escapeHTML(id)}"${id === state.engine ? " selected" : ""}` +
      `${why === null ? "" : " disabled"}>${escapeHTML(label)}</option>`
    );
  }).join("");
  const info = ENGINE_INFO[state.engine];
  return (
    `<div class="listen${leavesMachine(state.engine) ? " hot" : ""}">` +
    `<select data-engine>${options}</select>` +
    `<p class="why">${escapeHTML(info.summary)}</p>` +
    "</div>"
  );
}

/**
 * The Whisper download: a button before it starts, a progress bar during, and
 * a confirmation once it is installed.
 *
 * The size is stated on the button itself, so nothing downloads as a surprise.
 */
export function whisperDownloadRow(state: ClosetState): string {
  if (state.whisperDownload) {
    const { downloaded, total } = state.whisperDownload;
    const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    const mb = (n: number) => (n / 1_000_000).toFixed(0);
    return (
      `<div class="whisper-dl">` +
      `<div class="whisper-bar"><div class="whisper-fill" style="width:${pct}%"></div></div>` +
      `<p class="why">Downloading Whisper… ${mb(downloaded)} / ${mb(total)} MB</p>` +
      "</div>"
    );
  }
  if (!whisperReason(state.engineAvailability)) {
    return `<p class="why whisper-ready">Whisper is ready. Meetings are transcribed on this machine.</p>`;
  }
  return (
    `<button type="button" class="whisper-dl-btn" data-whisper-download>` +
    "Download Whisper — transcribes meetings on this machine (about 190 MB)</button>"
  );
}

/**
 * Which voice speaks, when Loaf speaks.
 *
 * Only voices installed on this machine appear. The browser also offers
 * "Online (Natural)" voices which sound better and send the text to a server;
 * they are filtered out before they reach here, so there is nothing to warn
 * about in this list.
 */
export function voiceRow(state: ClosetState): string {
  if (state.voices.length === 0) {
    return '<div class="voice"><p class="why">No speech voices are installed on this machine.</p></div>';
  }
  const options = [
    `<option value=""${state.voice === null ? " selected" : ""}>Let Loaf choose</option>`,
    ...state.voices.map(
      (v) =>
        `<option value="${escapeHTML(v)}"${v === state.voice ? " selected" : ""}>` +
        `${escapeHTML(v)}</option>`,
    ),
  ].join("");
  return `<div class="voice"><select data-voice>${options}</select></div>`;
}

export function habitRows(state: ClosetState): string {
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
export function soundRow(state: ClosetState): string {
  const on = !state.muted;
  return (
    `<label class="habit${on ? " on" : ""}">` +
    `<input type="checkbox" data-sound="muted"${on ? " checked" : ""}>` +
    `<span>Make a noise now and then</span></label>`
  );
}

/**
 * One consolidated answer to "what can this thing actually do".
 *
 * Deliberately plain sentences rather than a settings grid: the granular
 * controls for each of these sit right above it, each with its own
 * description. This is the summary a person reads once to know what is true
 * right now, not another place to change anything.
 */
export function disclosurePanel(state: ClosetState): string {
  const engineInfo = ENGINE_INFO[state.engine];
  const rows: string[] = [
    `<b>Speech recognition:</b> ${escapeHTML(engineInfo.label)}. ` +
      `${leavesMachine(state.engine) ? "Audio leaves this device." : "Audio never leaves this device."}` +
      " Used for commands and dictation.",
    // "Nothing happens when I talk" has two completely different causes and
    // one symptom. Naming the device separates them, without the user having
    // to guess their way around permission screens to find out which it is.
    `<b>Microphone:</b> ${
      state.microphone === null
        ? "None found. Nothing can be heard until Windows lets Loaf see one."
        : escapeHTML(state.microphone)
    }`,
    `<b>Always listening:</b> ${
      state.listenMode === "always"
        ? `On — answers to “${escapeHTML(state.wakeWord ?? "hey loaf")}”.`
        : state.listenMode === "off"
          ? "Off."
          : `Not continuous — ${escapeHTML(LABELS[state.listenMode])}.`
    }`,
    `<b>Meeting recording:</b> ${
      whisperReason(state.engineAvailability)
        ? "Not available — Whisper is not downloaded. See the Meetings tab."
        : "Whisper, on this machine. Your microphone only, and only when you say yes."
    }`,
    `<b>Talking back:</b> ${
      state.habits.talking === true
        ? state.voices.length > 0
          ? "On, with a local voice — never a remote one."
          : "On, but no local voice is installed, so it stays silent."
        : "Off."
    }`,
    `<b>External connections (MCP):</b> None configured. This will get its own screen — not built yet.`,
  ];
  return `<ul class="disclosure">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`;
}

/**
 * Styling for the controls above.
 *
 * Carried with the markup rather than left in each window's stylesheet, so a
 * window that renders these cannot end up rendering them unstyled. Written
 * against the same `--paper`/`--edge`/`--ink`/`--site` tokens both windows
 * already define.
 */
export const SETTINGS_CSS = `
  .habits { display:flex; flex-direction:column; gap:8px; }
  .habit { display:flex; align-items:center; gap:9px; cursor:pointer; font-size:13px;
           border:1px solid var(--edge); border-radius:11px; padding:10px 13px;
           background:var(--card, #FFFDF9); color:var(--ink-soft); }
  .habit.on { border-color:var(--site); background:rgba(138,80,128,.055); color:var(--ink); font-weight:600; }
  .habit input { accent-color:var(--site); margin:0; }
  .listen { display:flex; flex-direction:column; gap:6px; }
  .listen .why { font-size:11.5px; line-height:1.45; opacity:.78; margin:2px 0 0; }
  .whisper-dl-btn { width:100%; margin-top:6px; padding:8px; border-radius:8px;
    border:1px solid var(--edge); background:var(--card, #FFFDF9); color:var(--ink);
    font:inherit; font-size:12.5px; cursor:pointer; }
  .whisper-dl-btn:hover { border-color:var(--site); }
  .whisper-ready { color:var(--site); font-weight:600; }
  .disclosure { list-style:none; margin:0; padding:0; display:flex;
    flex-direction:column; gap:7px; }
  .disclosure li { font-size:12.5px; line-height:1.5; padding:8px 10px;
    border:1px solid var(--edge); border-radius:8px; background:var(--card, #FFFDF9); }
  .whisper-bar { height:6px; border-radius:4px; background:var(--edge); overflow:hidden;
    margin-top:8px; }
  .whisper-fill { height:100%; background:var(--site); transition:width .2s; }
  .listen input { width:100%; padding:7px 8px; border-radius:8px; margin-top:2px;
    border:1px solid var(--edge); background:var(--card, #FFFDF9); color:var(--ink);
    font:inherit; font-size:12.5px; }
  .listen select, .voice select { width:100%; padding:7px 8px; border-radius:8px;
    border:1px solid var(--edge); background:var(--card, #FFFDF9); color:var(--ink);
    font:inherit; font-size:12.5px; }
  .listen.hot .why { color:var(--site); font-weight:600; opacity:1; }
  .settings-group { display:flex; flex-direction:column; gap:10px; }
  /* The aside in a heading — "what they get up to on their own". Without this
     it inherits the heading's uppercase and letter-spacing and reads as part
     of the title rather than as a note on it. */
  h2 .shelf-note { font-size:11px; color:var(--ink-soft); font-style:italic;
    text-transform:none; letter-spacing:0; font-weight:400; margin-left:6px; }
`;
