import type { BehaviourLicence } from "./licence";
import type { BehaviourSettings, SecondsRange } from "./settings";
import { defaultBehaviourSettings } from "./settings";
import { FurBall } from "./furBall";
import { DESIGN_WIDTH } from "../core/types";
import type { Random } from "./curl";

/**
 * The game of fetch. Ported from the play half of `BehaviourDirector`.
 *
 * The ball rolls in from off-screen with the walls down, the walls come up once
 * it is inside, he bats it a few times, and the last bat is the exit shot with
 * the walls down again so it can leave. A box with no door has no way for the
 * game to start or end.
 *
 * Time and randomness are injected for the same reason they are in the curl
 * director: a schedule measured in minutes is untestable otherwise.
 */

/** The centre line, which is also where the companion stands. */
const CENTRE_X = 85;

const SWIPE_SECONDS = 0.34;

export type PlayPhase = "off" | "arriving" | "playing" | "leaving";

function pick(range: SecondsRange, rng: Random): number {
  return range.min + (range.max - range.min) * rng();
}

function between(lo: number, hi: number, rng: Random): number {
  return lo + (hi - lo) * rng();
}

export class PlayDirector {
  settings: BehaviourSettings = defaultBehaviourSettings();

  private ballValue: FurBall | null = null;
  private phase: PlayPhase = "off";
  private batsLeft = 0;
  private restFor = 0;
  private swipeValue: number | null = null;
  private swipeHit = false;
  private swipeSideValue = -1;
  private playElapsed = 0;
  private headLeanValue = 0;
  private nextPlay: number | null = null;

  private readonly rng: Random;

  constructor(rng: Random = Math.random) {
    this.rng = rng;
  }

  get ball(): FurBall | null {
    return this.ballValue;
  }
  /** 0..1 through a paw swipe, or null. */
  get swipe(): number | null {
    return this.swipeValue;
  }
  get swipeSide(): number {
    return this.swipeSideValue;
  }
  /** How far the head leans toward the ball, in design points. */
  get headLean(): number {
    return this.headLeanValue;
  }
  get isPlaying(): boolean {
    return this.phase !== "off";
  }

  private seedSchedule(nowMs: number): void {
    if (this.nextPlay === null) {
      this.nextPlay = nowMs + pick(this.settings.playEvery, this.rng) * 1000;
    }
  }

  /**
   * One tick.
   *
   * @param busy true when something else ambient holds the floor (a curl, a
   *        walk) — a curled-up animal cannot reach a ball.
   */
  tick(dt: number, licence: BehaviourLicence, nowMs: number, busy = false): void {
    this.seedSchedule(nowMs);

    if (this.ballValue === null) {
      if (
        licence.mayPlay &&
        licence.mayBegin &&
        this.settings.playing &&
        !busy &&
        this.nextPlay !== null &&
        nowMs >= this.nextPlay
      ) {
        this.beginPlay();
      }
      this.relaxHead(dt);
      return;
    }

    // Something more important came up: the ball rolls off rather than blinking
    // out of existence.
    if ((!licence.mayPlay || !this.settings.playing) && this.phase !== "leaving") {
      this.sendBallAway();
    }

    this.playElapsed += dt;
    if (this.playElapsed > 45 && this.phase !== "leaving") this.sendBallAway();
    this.ballValue.step(dt);

    switch (this.phase) {
      case "arriving":
        if (
          this.ballValue.x > FurBall.wallLeft &&
          this.ballValue.x < FurBall.wallRight
        ) {
          this.ballValue.walls = true;
          this.phase = "playing";
        }
        break;
      case "playing":
        this.tickSwipe(dt);
        break;
      case "leaving":
        if (this.ballValue.gone) this.endPlay(nowMs);
        break;
      case "off":
        break;
    }

    this.leanAtBall(dt);
  }

  private leanAtBall(dt: number): void {
    const b = this.ballValue;
    if (b && this.phase !== "off") {
      // He leans after it. Small — this is a head turn, not a lunge.
      const want = Math.max(-6, Math.min(6, (b.x - CENTRE_X) * 0.06));
      this.headLeanValue += (want - this.headLeanValue) * Math.min(1, dt * 6);
    } else {
      this.relaxHead(dt);
    }
  }

  private relaxHead(dt: number): void {
    this.headLeanValue += (0 - this.headLeanValue) * Math.min(1, dt * 6);
  }

  private tickSwipe(dt: number): void {
    if (this.swipeValue !== null) {
      const next = this.swipeValue + dt / SWIPE_SECONDS;
      if (!this.swipeHit && next >= 0.5) {
        this.hitBall();
        this.swipeHit = true;
      }
      this.swipeValue = next >= 1 ? null : next;
      return;
    }
    const b = this.ballValue;
    if (!b || !b.resting) {
      this.restFor = 0;
      return;
    }
    this.restFor += dt;
    // A beat of looking at it before poking it. Instant reactions read as a
    // machine.
    if (this.restFor <= 0.55) return;
    this.restFor = 0;
    this.swipeSideValue = b.x < CENTRE_X ? -1 : 1;
    this.swipeValue = 0;
    this.swipeHit = false;
  }

  private hitBall(): void {
    const b = this.ballValue;
    if (!b) return;
    this.batsLeft -= 1;
    // Toward the middle, so it has room to roll instead of juddering in a
    // corner.
    const inward = b.x < CENTRE_X ? 1 : -1;
    if (this.batsLeft <= 0) {
      // The last one is the exit shot, and the walls come down so it can leave.
      b.walls = false;
      b.vx = -inward * between(155, 195, this.rng);
      b.vy = 45;
      this.phase = "leaving";
    } else {
      b.vx = inward * between(55, 120, this.rng);
      b.vy = between(55, 150, this.rng);
    }
  }

  private beginPlay(): void {
    const fromLeft = this.rng() < 0.5;
    this.ballValue = new FurBall({
      x: fromLeft ? -FurBall.radius : DESIGN_WIDTH + FurBall.radius,
      vx: fromLeft ? 115 : -115,
      walls: false,
    });
    this.phase = "arriving";
    this.batsLeft = 3 + Math.floor(this.rng() * 4); // 3...6
    this.playElapsed = 0;
    this.restFor = 0;
    this.swipeValue = null;
  }

  private sendBallAway(): void {
    const b = this.ballValue;
    if (!b) return;
    b.walls = false;
    b.vx = (b.x < CENTRE_X ? -1 : 1) * 165;
    this.swipeValue = null;
    this.phase = "leaving";
  }

  private endPlay(nowMs: number): void {
    this.ballValue = null;
    this.phase = "off";
    this.swipeValue = null;
    this.headLeanValue = 0;
    this.nextPlay = nowMs + pick(this.settings.playEvery, this.rng) * 1000;
  }

  /** Test and preview seam: start a game now rather than waiting. */
  forcePlay(): void {
    this.beginPlay();
  }
}
