import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { ONBOARDING_CSS, onboardingBody } from "./view";
import type { OnboardingStep, OnboardingPlatform } from "./view";
import {
  ONBOARD_DECISION_EVENT,
  ONBOARD_STATE_EVENT,
  ONBOARD_HELLO_EVENT,
  isDecision,
} from "./events";

/**
 * The consent screen.
 *
 * Owns nothing, like every other window here: it shows the deal, reports which
 * button was pressed, and re-renders when the companion says the step changed.
 */

const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = ONBOARDING_CSS;
document.head.appendChild(style);

let platform: OnboardingPlatform = "other";
let step: OnboardingStep = { step: "intro" };

function render(): void {
  root.innerHTML = onboardingBody(step, platform);
  void fit();
}

async function fit(): Promise<void> {
  const wrap = root.querySelector("#wrap");
  if (!wrap) return;
  await invoke("fit_onboarding", {
    height: Math.ceil(wrap.getBoundingClientRect().height) + 8,
  }).catch(() => {});
}

root.addEventListener("click", (ev) => {
  const target = ev.target;
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>("[data-onboard]");
  if (!el) return;
  const decision = el.dataset.onboard;
  if (isDecision(decision)) void emit(ONBOARD_DECISION_EVENT, decision);
});

void listen(ONBOARD_STATE_EVENT, (e) => {
  const payload = e.payload as { step?: OnboardingStep; platform?: OnboardingPlatform };
  if (payload?.platform) platform = payload.platform;
  if (payload?.step) step = payload.step;
  render();
});

render();
void emit(ONBOARD_HELLO_EVENT).catch(() => {
  // No companion listening; the intro above stands, which is the right screen
  // to be showing anyway.
});
