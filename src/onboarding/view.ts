import { escapeHTML } from "../dashboard/html";
import type { BrowserStatus } from "../radar/radar";

/**
 * The privacy radar's consent screen. Ported from `OnboardingWindow.swift`.
 *
 * This is the one screen in the app whose job is to be *read*, so the shape is
 * the deal itself: what he reads on the left, what he never reads on the right,
 * and the two buttons underneath. It is shown once, before the radar has ever
 * looked at anything, and "Not now" is a real answer rather than a delay.
 */

export type OnboardingStep =
  | { readonly step: "intro" }
  | { readonly step: "asking" }
  | { readonly step: "done"; readonly statuses: readonly BrowserStatus[] };

export type OnboardingPlatform = "macos" | "windows" | "other";

export const ONBOARDING_CSS = `
  :root {
    --paper:#FFF9F2; --edge:#E8D8C4; --ink:#33261D; --ink-soft:#6B564A;
    --card:#FFFDF9; --site:#8A5080; --site-dark:#4A3670; --green:#5C9E62;
  }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--paper); color:var(--ink);
    font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;
    -webkit-user-select:none; user-select:none; }
  .wrap { padding:22px 26px 22px; }
  h1 { font-size:24px; margin:0 0 8px; }
  h1 .plus { color:var(--site); }
  .lede { font-size:14px; line-height:1.55; margin:0 0 18px; }
  h2 { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em;
       color:var(--ink-soft); margin:0 0 8px; }
  .body { font-size:12.5px; line-height:1.6; color:var(--ink-soft); margin:0 0 14px; }
  code { font-family:ui-monospace,"JetBrains Mono",Consolas,monospace; font-size:11.5px;
         background:rgba(138,80,128,.08); border-radius:4px; padding:1px 5px; }

  /* Side by side, deliberately: the two lists are a comparison, and stacking
     them lets someone read the first and stop. */
  .deal { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:0 0 16px; }
  .deal > div { border:1px solid var(--edge); border-radius:12px; padding:13px 15px;
                background:var(--card); }
  .deal .yes { border-color:rgba(92,158,98,.45); }
  .deal ul { margin:0; padding-left:17px; }
  .deal li { font-size:12px; line-height:1.55; color:var(--ink-soft); margin-bottom:6px; }
  .deal li:last-child { margin-bottom:0; }

  .actions { display:flex; gap:10px; align-items:center; margin:18px 0 0; }
  button { font-family:inherit; cursor:pointer; }
  .cta { font-size:13px; font-weight:600; background:var(--site); color:#fff;
         border:none; border-radius:999px; padding:11px 18px; }
  .cta:hover { background:var(--site-dark); }
  .ghost { font-size:12.5px; background:none; border:1px solid var(--edge);
           color:var(--ink-soft); border-radius:999px; padding:10px 16px; }
  .ghost:hover { border-color:var(--site); color:var(--ink); }
  .linkish { font:inherit; font-size:12px; background:none; border:none; padding:0;
             color:var(--site); text-decoration:underline; }
  .fine { font-size:10.5px; color:var(--ink-soft); line-height:1.55; margin:12px 0 0; }
`;

/**
 * How the domain is obtained, in the user's terms.
 *
 * The two platforms make different promises and this screen is the one place
 * that must not blur them: on macOS the truncation happens inside the script
 * that asks, so the full URL never arrives; on Windows it arrives and is cut
 * down immediately. Someone deciding whether to switch this on deserves the
 * real sentence, not the flattering one.
 */
function howItReads(platform: OnboardingPlatform): string {
  if (platform === "macos") {
    return (
      `<p class="body">The address is cut down to its domain <em>inside the script ` +
      `that asks for it</em>, so the full URL never reaches Loaf at all. Everything ` +
      `lands in the same local file as the rest of your stats. There is still no ` +
      `network code in this app.</p>` +
      `<p class="body">macOS will ask you to approve this per browser — that's its ` +
      `Automation prompt, not ours. You can say no now and turn it on later, or turn ` +
      `it off and make him forget, any time.</p>`
    );
  }
  return (
    `<p class="body">On Windows the domain is read from your browser's address bar ` +
    `and cut down to the host straight away — the rest is discarded before it is ` +
    `stored or shown. Loaf skips the read entirely while you're typing in that bar, ` +
    `so a half-written search is never seen. Everything lands in the same local file ` +
    `as the rest of your stats. There is still no network code in this app.</p>` +
    `<p class="body">No permission prompt is involved, which cuts both ways: nothing ` +
    `stands between Loaf and the address bar except this switch. Turn it off and make ` +
    `him forget, any time.</p>`
  );
}

function intro(platform: OnboardingPlatform): string {
  return (
    `<h1>Loaf<span class="plus">+</span></h1>` +
    `<p class="lede">Loaf can tell you that Chrome ate five hours. The radar can tell ` +
    `you <em>which five hours worth of sites</em> that was.</p>` +
    `<div class="deal">` +
    `<div class="yes"><h2>What he reads</h2><ul>` +
    `<li>The <strong>domain</strong> of your active tab — <code>github.com</code></li>` +
    `<li>How many tabs you have open, in total</li>` +
    `</ul></div>` +
    `<div class="no"><h2>What he never reads</h2><ul>` +
    `<li>The rest of the address — no paths, no queries, no <code>/inbox/msg/1842</code></li>` +
    `<li>Page contents, form fields, anything you type</li>` +
    `<li>Tabs in the background, or any browser you're not looking at</li>` +
    `</ul></div></div>` +
    howItReads(platform) +
    `<div class="actions">` +
    `<button class="cta" data-onboard="yes">Turn on privacy radar</button>` +
    `<button class="ghost" data-onboard="no">Not now</button>` +
    `</div>` +
    `<p class="fine">Not now keeps everything Loaf already does — the cat, the ` +
    `dashboard, the break nudges. Only the site list and the tab counter go with it.</p>`
  );
}

function asking(platform: OnboardingPlatform): string {
  if (platform !== "macos") {
    // Nothing to wait for: there is no prompt on Windows. Showing "asking your
    // browsers…" there would be a screen describing something that never
    // happens.
    return (
      `<h1>Looking…</h1>` +
      `<p class="lede">Loaf is checking which browsers it can read. This takes a moment.</p>`
    );
  }
  return (
    `<h1>Asking your browsers…</h1>` +
    `<p class="lede">macOS is putting up its own permission prompt for each browser ` +
    `you have open. Click <strong>OK</strong> on it and Loaf can start reading ` +
    `domains.</p>` +
    `<p class="body">If you miss one, nothing breaks — he'll ask again next time ` +
    `you're in that browser.</p>`
  );
}

function done(
  statuses: readonly BrowserStatus[],
  platform: OnboardingPlatform,
): string {
  const granted = statuses.filter((s) => s.permission === "granted");
  const denied = statuses.filter((s) => s.permission === "denied");
  const names = (rows: readonly BrowserStatus[]): string =>
    rows.map((r) => escapeHTML(r.name)).join(", ");

  let lines = "";
  if (granted.length > 0) {
    lines += `<p class="body"><strong>Reading:</strong> ${names(granted)}.</p>`;
  }
  if (denied.length > 0) {
    lines +=
      `<p class="body"><strong>Declined:</strong> ${names(denied)}.` +
      (platform === "macos"
        ? ` You can change that under System Settings › Privacy &amp; Security › ` +
          `Automation. <button class="linkish" data-onboard="settings">Open it</button>`
        : ` Close and reopen the browser, or check any extension or policy that ` +
          `blocks automation.`) +
      `</p>`;
  }
  if (granted.length === 0 && denied.length === 0) {
    lines =
      `<p class="body">No browsers were open, so there was nothing to look at yet. ` +
      `Loaf will check the first time you're actually in one.</p>`;
  }

  return (
    `<h1>Radar on 🐾</h1>` +
    `<p class="lede">From here on, the dashboard splits browser time by domain.</p>` +
    lines +
    `<div class="actions"><button class="cta" data-onboard="close">Got it</button></div>`
  );
}

export function onboardingBody(
  state: OnboardingStep,
  platform: OnboardingPlatform = "other",
): string {
  const inner =
    state.step === "intro"
      ? intro(platform)
      : state.step === "asking"
        ? asking(platform)
        : done(state.statuses, platform);
  return `<div class="wrap" id="wrap">${inner}</div>`;
}
