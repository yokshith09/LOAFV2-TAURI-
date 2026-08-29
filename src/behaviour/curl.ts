import type { Companion } from "../core/types";
import type { BehaviourLicence } from "./licence";
import type { BehaviourSettings, SecondsRange } from "./settings";
import { defaultBehaviourSettings } from "./settings";

/**
 * The loafing half of the ambient director. Ported from `tickLoaf` and the
 * scheduling in `BehaviourDirector`.
 *
 * Deliberately excludes the fur ball and the window walk: both need machinery
 * that does not exist yet (ball physics, and the Tauri window-position API), so
 * they get their own slice rather than being half-built here.
 *
 * Time and randomness are INJECTED rather than read from the ambient clock.
 * A behaviour whose whole job is "wait 70 to 210 seconds, then curl up for 16
 * to 48" is untestable if it reads Date.now() and Math.random() internally, and
 * untestable ambient behaviour is how a pet ends up curling during a tantrum.
 */

/** Whether curling up makes any sense for this character. */
export function canCurl(c: Companion): boolean {
  // Nothing to curl *on*. `castsShadow` is already the contract's word for
  // "this one never touches the floor" — the fairy, the droid and the plane all
  // opt out of the ground shadow, and all three would be curling in mid-air.
  if (!c.castsShadow) return false;
  // A tin robot has no spine. Folding a box of rivets into a bread shape reads
  // as damage rather than contentment, so the machines keep their normal idle.
  if (c.group === "machines") return false;
  return true;
}

/** Seconds to go from standing to fully curled, and back. */
export const CURL_IN_SECONDS = 1.15;
export const CURL_OUT_SECONDS = 0.55;

export interface CurlState {
  /** 0 standing … 1 fully curled. What the view draws the loaf off. */
  readonly curl: number;
  /**
   * True while a loaf's eyes are open. A loaf that never opens its eyes is
   * asleep, and asleep is a different mood with its own z's.
   */
  readonly peeking: boolean;
}

/** A source of randomness, injected so schedules are reproducible in tests. */
export type Random = () => number;

function pick(range: SecondsRange, rng: Random): number {
  return range.min + (range.max - range.min) * rng();
}

/**
 * The curl state machine.
 *
 * One instance per companion view. `tick` is called once per frame with the
 * elapsed time, the current licence, and the animation phase.
 */
export class CurlDirector {
  settings: BehaviourSettings = defaultBehaviourSettings();

  /** Whether the current companion can curl — refreshed when the closet swaps. */
  canLoaf = true;

  private curlValue = 0;
  private peekingValue = false;
  private curlTarget = 0;
  /** Timestamps in milliseconds, matching the clock passed to `tick`. */
  private loafUntil = Number.NEGATIVE_INFINITY;
  private nextLoaf: number | null = null;

  private readonly rng: Random;

  constructor(rng: Random = Math.random) {
    this.rng = rng;
  }

  get state(): CurlState {
    return { curl: this.curlValue, peeking: this.peekingValue };
  }

  /** Exposed for the view; identical to `state.curl`. */
  get curl(): number {
    return this.curlValue;
  }

  /**
   * Seed the first schedule. Called lazily on the first tick so the countdown
   * starts when the companion appears rather than when the object was built.
   */
  private seedSchedule(nowMs: number): void {
    if (this.nextLoaf === null) {
      this.nextLoaf = nowMs + pick(this.settings.loafEvery, this.rng) * 1000;
    }
  }

  /**
   * One tick.
   *
   * @param dt seconds since the previous tick
   * @param licence what the ambient layer is allowed to do right now
   * @param phase the animation clock, in seconds
   * @param nowMs wall clock in milliseconds
   * @param busy true when something else ambient is running (the ball, a walk);
   *        a curled animal cannot reach a ball, so only one runs at a time
   */
  tick(
    dt: number,
    licence: BehaviourLicence,
    phase: number,
    nowMs: number,
    busy = false,
  ): void {
    this.seedSchedule(nowMs);

    if (!licence.mayCurl || !this.settings.loafing) {
      // Interrupted. He gets up, and the next loaf is rescheduled from now
      // rather than pouncing on the first idle frame after the interruption
      // clears.
      if (this.curlTarget > 0) {
        this.curlTarget = 0;
        this.reschedule(nowMs);
      }
    } else if (this.curlTarget > 0 && nowMs >= this.loafUntil) {
      this.curlTarget = 0;
      this.reschedule(nowMs);
    } else if (
      this.curlTarget === 0 &&
      this.curlValue === 0 &&
      licence.mayBegin &&
      this.canLoaf &&
      !busy &&
      this.nextLoaf !== null &&
      nowMs >= this.nextLoaf
    ) {
      this.curlTarget = 1;
      this.loafUntil = nowMs + pick(this.settings.loafFor, this.rng) * 1000;
    }

    const rate = this.curlTarget > this.curlValue ? CURL_IN_SECONDS : CURL_OUT_SECONDS;
    const step = dt / rate;
    this.curlValue =
      this.curlTarget > this.curlValue
        ? Math.min(this.curlTarget, this.curlValue + step)
        : Math.max(this.curlTarget, this.curlValue - step);

    // 2.4 seconds of eyes-open in every 11. Derived from `phase` rather than
    // stored, so it cannot drift out of step with the animation clock.
    this.peekingValue = this.curlValue > 0.55 && phase % 11 > 8.6;
  }

  private reschedule(nowMs: number): void {
    this.nextLoaf = nowMs + pick(this.settings.loafEvery, this.rng) * 1000;
  }

  /** Test and preview seam: jump straight to a curl without waiting. */
  forceCurl(nowMs: number, seconds: number): void {
    this.curlTarget = 1;
    this.loafUntil = nowMs + seconds * 1000;
  }
}
