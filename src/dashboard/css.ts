/**
 * The dashboard stylesheet. Ported from `DashboardHTML.swift`.
 *
 * Kept as a string rather than a `.css` file because the dashboard is generated
 * fresh on every open and served as one self-contained document — the same
 * property the reference relies on, and the reason there is nothing here to
 * fetch: no network requests, no external fonts, nothing that could phone home
 * from a window whose entire pitch is that it does not.
 */

/** Base: the free tier's charts and layout. */
export const BASE_CSS = `
  :root {
    --paper:#FFF9F2; --edge:#E8D8C4; --ink:#33261D; --ink-soft:#6B564A;
    --accent:#FFB25E; --accent-dark:#DD9A4E; --accent-ink:#2B1D0E;
    --site:#8A5080; --site-dark:#4A3670;
  }
  * { box-sizing: border-box; }
  html, body {
    margin:0; padding:0; background:var(--paper); color:var(--ink);
    /*
     * The reference names -apple-system and "SF Pro Text" only. That resolves to
     * Times on Windows, which is the wrong century for this design, so the stack
     * continues into Segoe UI before the generic fallback.
     */
    font-family:-apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-user-select:none; user-select:none;
  }
  .wrap { padding: 22px 26px 20px; }
  h1 { font-size:16px; font-weight:700; margin:0 0 2px; }
  .date { font-size:12px; color:var(--ink-soft); margin-bottom:18px; }
  .total-label { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-soft); }
  .total { font-size:36px; font-weight:700; margin:2px 0 22px; font-variant-numeric:tabular-nums; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-soft); margin:0 0 12px; }
  .row { margin-bottom:12px; }
  .row-top { display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px; }
  .app { font-weight:600; }
  .time { color:var(--ink-soft); font-variant-numeric:tabular-nums; }
  .bar-track { background:var(--edge); border-radius:5px; height:8px; overflow:hidden; }
  .bar-fill { background:linear-gradient(90deg, var(--accent-dark), var(--accent)); height:100%; border-radius:5px; }
  .empty { font-size:13px; color:var(--ink-soft); margin:0; }
  .section-row { display:flex; align-items:center; justify-content:space-between; margin:22px 0 10px; }
  .section-row h2 { margin:0; }
  .tabs { display:flex; gap:6px; }
  .tab { font-size:11px; border:1px solid var(--edge); background:none; color:var(--ink-soft);
         border-radius:999px; padding:4px 10px; cursor:pointer; font-family:inherit; }
  .tab.active { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:600; }
  .strip-panel { display:flex; justify-content:space-between; align-items:flex-end; height:96px; margin-bottom:6px; padding:0 4px; }
  .strip-panel.month { overflow-x:auto; justify-content:flex-start; gap:5px; }
  .wday { display:flex; flex-direction:column; align-items:center; gap:6px; width:28px; flex-shrink:0; }
  .wday.thin { width:11px; gap:4px; }
  .wbar-track { height:64px; display:flex; align-items:flex-end; }
  .wbar { width:14px; background:var(--edge); border-radius:4px; }
  .wday.thin .wbar { width:6px; border-radius:2px; }
  .wbar.today { background:var(--accent); }
  /* A day Loaf was installed for but recorded nothing. Faint, so the eye reads
     the gap, and never hatched — the reference used hatching for INVENTED bars
     and reusing the treatment here would resurrect exactly the confusion the
     invented bars caused. */
  .wbar.nodata { background:var(--edge); opacity:.35; }
  .wlabel { font-size:10px; color:var(--ink-soft); height:12px; }
  .note { font-size:10.5px; color:var(--ink-soft); margin:0 0 18px; font-style:italic; }
  .note-inline { font-weight:400; font-style:italic; color:var(--ink-soft); font-size:12px; }
  .peak-callout { font-size:13px; margin:0 0 12px; }
  .hours { display:flex; justify-content:space-between; align-items:flex-end; height:54px; margin-bottom:4px; }
  .hbar-track { flex:1; display:flex; align-items:flex-end; justify-content:center; }
  .hbar { width:8px; background:var(--edge); border-radius:2px 2px 0 0; }
  .hbar.peak { background:var(--accent); }
  .hours-axis { display:flex; justify-content:space-between; font-size:9.5px; color:var(--ink-soft); margin-bottom:20px; }
  .footer { border-top:1px solid var(--edge); padding-top:14px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .footer p { font-size:11px; color:var(--ink-soft); margin:0; line-height:1.5; }
  .reset { font-size:11px; color:var(--ink-soft); background:none; border:1px solid var(--edge); font-family:inherit;
           border-radius:999px; padding:6px 12px; cursor:pointer; white-space:nowrap; }
  .reset:hover { border-color:var(--accent-dark); color:var(--ink); }
`;

/** Everything the paid tier adds: nested site rows, the radar block, permissions. */
export const PLUS_CSS = `
  h1 .plus {
    color:var(--site); font-weight:700; margin-left:1px;
  }
  h2.sub { margin-top:18px; }
  .bar-fill.site { background:linear-gradient(90deg, var(--site-dark), var(--site)); }
  /* Hatched against the ink, not the edge colour — an edge-on-edge hatch is
     the same cream as the track behind it and reads as an empty bar. */
  .bar-fill.unknown {
    background-color: rgba(107,86,74,0.10);
    background-image: repeating-linear-gradient(135deg,
      rgba(107,86,74,0.42) 0 3px, transparent 3px 6px);
  }
  .bar-track.thin { height:5px; }
  .subrow { margin:7px 0 0 14px; padding-left:10px; border-left:2px solid var(--edge); }
  .subrow .row-top { font-size:11.5px; margin-bottom:3px; }
  .site-name { color:var(--ink-soft); font-weight:500; }
  .subrow.more { font-size:11px; color:var(--ink-soft); font-style:italic; }
  .muted { color:var(--ink-soft); font-weight:500; }
  .fine { font-size:10.5px; color:var(--ink-soft); margin:5px 0 0; line-height:1.5; }
  .radar-off {
    border:1px solid var(--edge); border-radius:12px; padding:14px 16px; margin-bottom:6px;
    background:rgba(138,80,128,0.05);
  }
  .radar-off p { font-size:12.5px; margin:0 0 8px; line-height:1.55; }
  .cta {
    font-size:12px; font-weight:600; font-family:inherit; cursor:pointer;
    background:var(--site); color:#fff; border:none; border-radius:999px; padding:8px 14px; margin-top:4px;
  }
  .cta:hover { background:var(--site-dark); }
  .linkish {
    font:inherit; font-size:10.5px; background:none; border:none; padding:0;
    color:var(--site); text-decoration:underline; cursor:pointer;
  }

  /* The rest of the app, reachable from the window people actually find.
     A grid rather than a row: four labels of different lengths in a flex row
     give four different button widths, which reads as four different KINDS of
     thing rather than one shelf of places to go. */
  .shelf {
    display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:2px 0 4px;
  }
  .shelf-btn {
    font:inherit; font-size:12px; font-weight:600; cursor:pointer;
    background:var(--paper); color:var(--ink);
    border:1px solid var(--edge); border-radius:10px; padding:11px 12px;
    text-align:left; transition:border-color .12s, background .12s;
  }
  .shelf-btn:hover { border-color:var(--accent-dark); background:var(--accent); }

  /* Not yet built, and saying so. Dashed rather than solid, and not clickable:
     the border alone tells you this one is different before you read it. */
  .shelf-soon { margin-top:2px; }
  .soon {
    display:flex; flex-direction:column; gap:4px;
    border:1px dashed var(--edge); border-radius:10px; padding:10px 12px;
    background:none;
  }
  .soon-top { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--ink-soft); }
  .soon-tag {
    font-size:9px; font-weight:700; letter-spacing:.04em; text-transform:uppercase;
    color:var(--accent-ink); background:var(--accent);
    border-radius:999px; padding:2px 6px;
  }
  .soon-blurb { font-size:10.5px; line-height:1.45; color:var(--ink-soft); }

  /* The gestures. Nothing here is discoverable by looking at a cat, and until
     now the only place any of it was written down was a source comment. */
  /* What Loaf noticed. Sits directly under the total, because a sentence about
     the number is more use than the number, and reads as the character
     speaking rather than as another panel of statistics. */
  /* The task list, as it appears on the hover card. Priority is a dot rather
     than a word: three words down the left of a 190px card is a form, and the
     colour carries the same information in a quarter of the space. */
  /* The command box. The same parser a microphone would feed one day, given a
     surface that works today and can be tested by typing. */
  .ask { display:flex; gap:6px; margin:2px 0 6px; }
  .ask-input {
    font:inherit; font-size:13px; flex:1;
    border:1px solid var(--edge); border-radius:8px; padding:9px 11px;
    background:var(--paper); color:var(--ink);
  }
  .ask-input:focus { outline:2px solid var(--accent-dark); outline-offset:1px; }
  .ask-go {
    font:inherit; font-size:13px; font-weight:600; cursor:pointer;
    background:var(--accent-dark); color:var(--paper);
    border:none; border-radius:8px; padding:9px 18px;
  }
  .ask-go:hover { filter:brightness(1.08); }
  .ask-hint { font-size:11px; color:var(--ink-soft); margin:0 0 4px; line-height:1.5; }
  .ask-hint em { font-style:normal; color:var(--ink); }

  /* The notetaker panel on the dashboard. Form controls sized to be usable
     without being the loudest thing on a page that is mostly about time. */
  .tp { margin:2px 0 6px; }
  .tp-row {
    display:flex; align-items:center; gap:8px; font-size:13px;
    padding:7px 0; border-bottom:1px solid var(--edge);
  }
  .tp-row:last-of-type { border-bottom:none; }
  .tp-tick, .tp-x {
    font:inherit; cursor:pointer; background:none; border:1px solid var(--edge);
    border-radius:6px; width:22px; height:22px; line-height:1; padding:0;
    color:var(--ink-soft); flex-shrink:0;
  }
  .tp-tick:hover { border-color:var(--ok, #2C7355); color:#2C7355; }
  .tp-x:hover { border-color:#C2402C; color:#C2402C; }
  .tp-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tp-timer { color:var(--ink-soft); font-size:11.5px; flex-shrink:0; }
  .tp-add { display:flex; gap:6px; margin-top:9px; flex-wrap:wrap; }
  .tp-input {
    font:inherit; font-size:12.5px; flex:1; min-width:140px;
    border:1px solid var(--edge); border-radius:8px; padding:7px 9px;
    background:var(--paper); color:var(--ink);
  }
  .tp-input:focus, .tp-select:focus, .tp-mins:focus {
    outline:2px solid var(--accent-dark); outline-offset:1px;
  }
  .tp-select, .tp-mins {
    font:inherit; font-size:12.5px; border:1px solid var(--edge);
    border-radius:8px; padding:7px 8px; background:var(--paper); color:var(--ink);
  }
  .tp-mins { width:62px; }
  .tp-save {
    font:inherit; font-size:12.5px; font-weight:600; cursor:pointer;
    background:var(--accent-dark); color:var(--paper);
    border:none; border-radius:8px; padding:7px 14px;
  }
  .tp-save:hover { filter:brightness(1.08); }

  .tasks { margin-top:11px; padding-top:9px; border-top:1px solid var(--edge); }
  .task-row { display:flex; align-items:center; gap:7px; font-size:11.5px; margin-bottom:5px; }
  .task-row:last-child { margin-bottom:0; }
  .task-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
  .task-dot.p-now { background:#C2402C; }
  .task-dot.p-soon { background:var(--accent-dark); }
  .task-dot.p-whenever { background:var(--edge); border:1px solid var(--ink-soft); }
  .task-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .task-timer { margin-left:auto; color:var(--ink-soft); font-size:10.5px; flex-shrink:0; }

  .noticed { margin:2px 0 6px; }
  .noticed-line {
    font-size:13px; line-height:1.5; color:var(--ink); margin:0 0 3px;
    padding-left:13px; position:relative;
  }
  .noticed-line::before {
    content:""; position:absolute; left:0; top:8px;
    width:5px; height:5px; border-radius:50%; background:var(--accent-dark);
  }
  .noticed-line:last-child { margin-bottom:0; }

  .howto { list-style:none; margin:0 0 4px; padding:0; }
  .howto li {
    font-size:11.5px; line-height:1.5; color:var(--ink-soft);
    padding:6px 0 6px 14px; border-bottom:1px solid var(--edge); position:relative;
  }
  .howto li:last-child { border-bottom:none; }
  .howto li::before { content:"·"; position:absolute; left:4px; color:var(--accent-dark); font-weight:700; }
  .howto b { color:var(--ink); font-weight:600; }

  /* An invitation, sitting quietly. It is not a modal, it does not return, and
     nothing is withheld from someone who never clicks it. */
  .support {
    margin:4px 0 2px; padding:13px 14px;
    border:1px solid var(--edge); border-radius:12px; background:rgba(138,80,128,0.04);
  }
  .support-line { font-size:12px; color:var(--ink); margin:0 0 9px; font-weight:600; }
  .support-actions { display:flex; flex-wrap:wrap; gap:7px; }
  .support-btn {
    font:inherit; font-size:11.5px; font-weight:600; cursor:pointer;
    background:var(--paper); color:var(--ink);
    border:1px solid var(--edge); border-radius:999px; padding:7px 13px;
    transition:border-color .12s, background .12s;
  }
  .support-btn:hover { border-color:var(--site); color:var(--site); }
  .support-btn.star:hover { background:var(--site); color:#fff; border-color:var(--site); }
  .support-fine { font-size:10px; line-height:1.45; color:var(--ink-soft); margin:9px 0 0; }

  /* Quiet, but present. The point is that someone reporting a bug can read it
     back to you without being asked where to look. */
  .version {
    font-size:10px; color:var(--ink-soft); margin:6px 0 0;
    font-variant-numeric:tabular-nums; letter-spacing:.02em;
  }

  /* Reset and Forget are the only two controls here that destroy something.
     They were a whisper of grey underline while every harmless control was
     louder, which is the wrong way round — a button that deletes your history
     should at least be legible before you press it. Outlined in the warning
     colour, filled only on hover, so they are clear without being inviting. */
  .footer-actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
  .danger {
    font:inherit; font-size:11.5px; font-weight:600; cursor:pointer;
    background:none; color:#C2402C; border:1px solid rgba(194,64,44,0.45);
    border-radius:999px; padding:7px 14px; transition:background .12s, color .12s;
  }
  .danger:hover { background:#C2402C; color:#fff; border-color:#C2402C; }
  .perms { display:flex; flex-direction:column; gap:7px; margin-bottom:4px; }
  .perm { display:flex; align-items:center; gap:8px; font-size:12px; }
  .pname { font-weight:600; }
  .pstate { color:var(--ink-soft); margin-left:auto; font-size:11px; }
  .pdot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .pdot.ok { background:#5C9E62; }
  .pdot.no { background:#D4553F; }
  .pdot.na { background:var(--edge); }
  .pdot.wait { background:var(--accent); }
`;

/** The hover preview: a floating card with a tail, not a full page. */
export const MINI_CSS = `
  body.mini {
    background:transparent; margin:0; height:100vh;
    display:flex; align-items:flex-end; justify-content:center;
  }
  body.mini .wrap {
    background: var(--paper);
    border: 1px solid var(--edge);
    border-radius: 16px;
    padding: 16px 18px 14px;
    box-shadow: 0 10px 30px rgba(20,14,40,0.35);
    position: relative;
    margin-bottom: 12px;
    width: 190px;
    animation: loafPop .16s ease-out;
    transform-origin: bottom center;
  }
  @keyframes loafPop {
    from { opacity: 0; transform: scale(.92) translateY(4px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  body.mini .wrap::after {
    content: "";
    position: absolute;
    left: 50%; bottom: -9px; transform: translateX(-50%);
    border-left: 9px solid transparent;
    border-right: 9px solid transparent;
    border-top: 9px solid var(--paper);
  }
  .mini-total { font-size:26px; margin-bottom:16px; }
  body.mini .row { margin-bottom:10px; }
  body.mini .row:last-of-type { margin-bottom:0; }
  body.mini .row-top { font-size:12px; }
  .hint { font-size:10.5px; color:var(--ink-soft); margin:12px 0 0; font-style:italic; }
  .mini-site {
    display:flex; align-items:center; gap:6px; font-size:11.5px;
    margin-top:11px; padding-top:9px; border-top:1px solid var(--edge); color:var(--ink);
  }
  .mini-site .dot { width:6px; height:6px; border-radius:50%; background:var(--site); flex-shrink:0; }
  .mini-site .time { margin-left:auto; }
  .mini-tabs { font-size:11px; color:var(--ink-soft); margin-top:7px; }
  .mini-tabs.hot { color:#C2402C; font-weight:600; }

  /* Reduced motion is honoured here too: the pop is decorative, and someone who
     asked the OS to stop animations did not exempt the pet. */
  @media (prefers-reduced-motion: reduce) {
    body.mini .wrap { animation: none; }
  }
`;
