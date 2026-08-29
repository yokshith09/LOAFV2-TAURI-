import { describe, it, expect } from "vitest";
import { PlayDirector } from "../src/behaviour/play";
import { resolveLicence, licenceInputs } from "../src/behaviour/licence";
import { defaultBehaviourSettings } from "../src/behaviour/settings";
import { FurBall } from "../src/behaviour/furBall";
import { DESIGN_WIDTH } from "../src/core/types";

const idle = resolveLicence(licenceInputs());
const cross = resolveLicence(licenceInputs({ mood: "tantrum" }));

/** Deterministic: always the midpoint of any range. */
const midpoint = (): number => 0.5;

function run(
  d: PlayDirector,
  seconds: number,
  licence = idle,
  startMs = 0,
  busy = false,
): number {
  const dt = 1 / 60;
  let t = startMs;
  for (let i = 0; i < seconds * 60; i++) {
    t += dt * 1000;
    d.tick(dt, licence, t, busy);
  }
  return t;
}

describe("starting a game", () => {
  it("waits for the schedule before rolling a ball in", () => {
    const d = new PlayDirector(midpoint);
    // Midpoint of 170..430 is 300 seconds.
    run(d, 200);
    expect(d.ball).toBeNull();
  });

  it("rolls a ball in once due", () => {
    const d = new PlayDirector(midpoint);
    run(d, 305);
    expect(d.ball).not.toBeNull();
  });

  it("brings the ball in from off-screen with the walls down", () => {
    // A box with no door has no way for the game to start.
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    expect(d.ball!.walls).toBe(false);
    const x = d.ball!.x;
    expect(x < 0 || x > DESIGN_WIDTH).toBe(true);
  });

  it("raises the walls once the ball is inside", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    run(d, 3);
    if (d.ball) expect(d.ball.walls).toBe(true);
  });

  it("never starts while something else ambient holds the floor", () => {
    // A curled-up animal cannot reach a ball.
    const d = new PlayDirector(midpoint);
    run(d, 400, idle, 0, true);
    expect(d.ball).toBeNull();
  });

  it("never starts when playing is switched off", () => {
    const d = new PlayDirector(midpoint);
    d.settings = { ...defaultBehaviourSettings(), playing: false };
    run(d, 400);
    expect(d.ball).toBeNull();
  });

  it("never starts without a licence", () => {
    const d = new PlayDirector(midpoint);
    run(d, 400, cross);
    expect(d.ball).toBeNull();
  });
});

describe("interrupting a game", () => {
  it("rolls the ball off rather than blinking it out of existence", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    run(d, 3);
    expect(d.ball).not.toBeNull();

    // Tantrum: the ball must leave, not vanish.
    d.tick(1 / 60, cross, 10_000);
    expect(d.ball).not.toBeNull();
    expect(d.ball!.walls).toBe(false);
    expect(Math.abs(d.ball!.vx)).toBeGreaterThan(100);
  });

  it("eventually clears the ball once it has left", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    let t = run(d, 3);
    t = run(d, 20, cross, t);
    expect(d.ball).toBeNull();
  });

  it("gives up on a game that has dragged on too long", () => {
    // 45 seconds is the cap.
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    const t = run(d, 50);
    run(d, 20, idle, t);
    expect(d.ball).toBeNull();
  });
});

describe("batting", () => {
  /**
   * Get to a clean "ball at rest, no swipe in flight" state.
   *
   * Parking the ball without first letting any in-flight swipe finish reads the
   * PREVIOUS swipe's state, which is what made the first draft of these two
   * tests fail for the wrong reason.
   */
  const parkBallAt = (d: PlayDirector, x: number, startMs: number): number => {
    let t = startMs;
    for (let i = 0; i < 240 && d.swipe !== null; i++) {
      t += (1 / 60) * 1000;
      d.tick(1 / 60, idle, t);
    }
    const b = d.ball!;
    b.x = x;
    b.y = FurBall.floor + FurBall.radius;
    b.vx = 0;
    b.vy = 0;
    return t;
  };

  it("waits a beat before poking a resting ball", () => {
    // Instant reactions read as a machine.
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    let t = run(d, 3);
    t = parkBallAt(d, 60, t);

    t += (1 / 60) * 1000;
    d.tick(1 / 60, idle, t);
    expect(d.swipe, "poked immediately").toBeNull();

    run(d, 0.7, idle, t);
    expect(d.swipe, "never poked at all").not.toBeNull();
  });

  it("swipes from the side the ball is on", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    let t = run(d, 3);
    t = parkBallAt(d, 30, t);
    run(d, 0.7, idle, t);
    expect(d.swipeSide).toBe(-1);
  });

  it("ends the game after a handful of bats", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    // Long enough for the ball to arrive, be batted its few times, and leave.
    const t = run(d, 44);
    run(d, 20, idle, t);
    expect(d.ball).toBeNull();
  });

  it("drops the walls for the exit shot", () => {
    // The last bat is the exit shot; without dropping the walls the ball would
    // bounce back in forever.
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    let sawWallsDownAfterArrival = false;
    let armed = false;
    const dt = 1 / 60;
    let t = 0;
    for (let i = 0; i < 44 * 60; i++) {
      t += dt * 1000;
      d.tick(dt, idle, t);
      if (d.ball?.walls) armed = true;
      if (armed && d.ball && !d.ball.walls) {
        sawWallsDownAfterArrival = true;
        break;
      }
    }
    expect(sawWallsDownAfterArrival).toBe(true);
  });
});

describe("the head follows the ball", () => {
  it("leans toward the ball, but only a little", () => {
    // A head turn, not a lunge.
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    run(d, 3);
    if (d.ball) {
      d.ball.x = 20;
      d.ball.vx = 0;
    }
    run(d, 1, idle, 10_000);
    expect(d.headLean).toBeLessThan(0);
    expect(Math.abs(d.headLean)).toBeLessThanOrEqual(6.001);
  });

  it("returns to centre when the game ends", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    let t = run(d, 3);
    t = run(d, 20, cross, t);
    run(d, 2, idle, t);
    expect(Math.abs(d.headLean)).toBeLessThan(0.01);
  });

  it("stays at centre when no game is running", () => {
    const d = new PlayDirector(midpoint);
    run(d, 5);
    expect(d.headLean).toBe(0);
  });
});

describe("robustness", () => {
  it("never emits NaN through a whole game at any frame rate", () => {
    for (const dt of [1 / 240, 1 / 60, 0.2, 1]) {
      const d = new PlayDirector(midpoint);
      d.forcePlay();
      let t = 0;
      for (let i = 0; i < 300; i++) {
        t += dt * 1000;
        d.tick(dt, idle, t);
        if (d.ball) {
          expect(Number.isFinite(d.ball.x), `dt ${dt}`).toBe(true);
          expect(Number.isFinite(d.ball.y), `dt ${dt}`).toBe(true);
        }
        expect(Number.isFinite(d.headLean), `dt ${dt}`).toBe(true);
      }
    }
  });

  it("keeps swipe within 0..1 or null", () => {
    const d = new PlayDirector(midpoint);
    d.forcePlay();
    let t = 0;
    for (let i = 0; i < 44 * 60; i++) {
      t += (1 / 60) * 1000;
      d.tick(1 / 60, idle, t);
      if (d.swipe !== null) {
        expect(d.swipe).toBeGreaterThanOrEqual(0);
        expect(d.swipe).toBeLessThan(1);
      }
    }
  });
});
