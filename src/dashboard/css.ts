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
  .wbar.sample {
    background-color: rgba(232,216,196,0.4);
    background-image: repeating-linear-gradient(135deg, var(--edge), var(--edge) 3px, transparent 3px, transparent 6px);
    border:1px solid var(--edge);
  }
  .wbar.sample.today {
    background-color: rgba(255,178,94,0.22);
    background-image: repeating-linear-gradient(135deg, var(--accent), var(--accent) 3px, transparent 3px, transparent 6px);
    border:1px solid var(--accent);
  }
  .wlabel { font-size:10px; color:var(--ink-soft); height:12px; }
  .note { font-size:10.5px; color:var(--ink-soft); margin:0 0 18px; font-style:italic; }
  .note-inline { font-weight:400; font-style:italic; color:var(--ink-soft); font-size:12px; }
  .peak-callout { font-size:13px; margin:0 0 12px; }
  .hours { display:flex; justify-content:space-between; align-items:flex-end; height:54px; margin-bottom:4px; }
  .hbar-track { flex:1; display:flex; align-items:flex-end; justify-content:center; }
  .hbar { width:8px; background:var(--edge); border-radius:2px 2px 0 0; }
  .hbar.sample {
    background-color: rgba(232,216,196,0.4);
    background-image: repeating-linear-gradient(135deg, var(--edge), var(--edge) 2px, transparent 2px, transparent 4px);
  }
  .hbar.peak { background:var(--accent) !important; background-image:none !important; }
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
