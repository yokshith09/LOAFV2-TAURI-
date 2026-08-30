import { describe, it, expect } from "vitest";
import { resolveMood, type MoodInputs } from "../src/behaviour/mood";
import type { Mood } from "../src/core/types";
import {
  resolveLicence,
  licenceInputs,
  type BehaviourLicence,
} from "../src/behaviour/licence";
import { CurlDirector, canCurl, CURL_IN_SECONDS } from "../src/behaviour/curl";
import { defaultBehaviourSettings } from "../src/behaviour/settings";
import { COMPANIONS, findCompanion } from "../src/companions/registry";
import { ALL_MOODS } from "../src/core/types";

describe("behaviour settings", () => {
  it("leaves wandering OFF by default", () => {
    // The one behaviour the user must switch on themselves. A pet that starts
    // crossing a screen someone is working on, unasked, is a bug report.
    expect(defaultBehaviourSettings().wandering).toBe(false);
  });

  it("leaves drifting ON by default", () => {
    // Not a permission granted to a walker — it is what a ghost IS. Someone who
    // picks a ghost and gets a stationary one has been sold the wrong thing.
    expect(defaultBehaviourSettings().drifting).toBe(true);
  });

  it("loafs and plays by default", () => {
    const s = defaultBehaviourSettings();
    expect(s.loafing).toBe(true);
    expect(s.playing).toBe(true);
  });

  it("makes games rarer than loaves, because movement costs attention", () => {
    const s = defaultBehaviourSettings();
    expect(s.playEvery.min).toBeGreaterThan(s.loafEvery.min);
  });

  it("gives a drifting ghost a longer leash than a walker", () => {
    const s = defaultBehaviourSettings();
    expect(s.driftLeash).toBeGreaterThan(s.wanderLeash);
    // ...and moves it more slowly.
    expect(s.driftSpeed).toBeLessThan(s.wanderSpeed);
  });

  it("uses well-formed ranges", () => {
    const s = defaultBehaviourSettings();
    for (const [name, r] of Object.entries({
      loafEvery: s.loafEvery,
      loafFor: s.loafFor,
      playEvery: s.playEvery,
      wanderEvery: s.wanderEvery,
      driftEvery: s.driftEvery,
    })) {
      expect(r.min, name).toBeGreaterThan(0);
      expect(r.max, name).toBeGreaterThanOrEqual(r.min);
    }
  });
});

describe("precedence — what the ambient layer may do", () => {
  const nothing = (l: BehaviourLicence): boolean =>
    !l.mayCurl && !l.mayPlay && !l.mayWander && !l.mayBegin;

  it("stops everything during a tantrum", () => {
    // Above all: no moving the window while he is shouting at you.
    expect(nothing(resolveLicence(licenceInputs({ mood: "tantrum" })))).toBe(true);
  });

  it("outranks everything else with a tantrum", () => {
    // Even combined with states that would otherwise permit a curl.
    for (const over of [{ hovering: true }, { dragging: true }, { held: false }]) {
      expect(
        nothing(resolveLicence(licenceInputs({ mood: "tantrum", ...over }))),
        JSON.stringify(over),
      ).toBe(true);
    }
  });

  it("lets a curl survive a drag but starts nothing new", () => {
    // A drag is the user placing the window; never animate it out from under
    // them, and never start anything mid-gesture.
    const l = resolveLicence(licenceInputs({ dragging: true }));
    expect(l.mayCurl).toBe(true);
    expect(l.mayWander).toBe(false);
    expect(l.mayBegin).toBe(false);
  });

  it("gets up and listens when the app is talking", () => {
    for (const over of [
      { held: true },
      { mood: "worried" as const },
      { mood: "proud" as const },
    ]) {
      expect(nothing(resolveLicence(licenceInputs(over))), JSON.stringify(over)).toBe(
        true,
      );
    }
  });

  it("stops everything while scrolling", () => {
    // He is holding the scroll in both paws; the loaf would draw through it.
    expect(nothing(resolveLicence(licenceInputs({ mood: "scrolling" })))).toBe(true);
  });

  it("gives the last half-minute of a focus session to the session", () => {
    const l = resolveLicence(
      licenceInputs({ focus: { remaining: 12, paused: false } }),
    );
    expect(l.mayCurl).toBe(true);
    expect(l.mayPlay).toBe(false);
    expect(l.mayBegin).toBe(false);
  });

  it("does not hand the endgame rule to a PAUSED session", () => {
    // A paused clock is not about to land.
    const l = resolveLicence(
      licenceInputs({ focus: { remaining: 12, paused: true } }),
    );
    expect(l.mayBegin).toBe(true);
  });

  it("lets a sleeping companion stay curled but not start a game", () => {
    // Starting a game of fetch for an empty chair is silly.
    const l = resolveLicence(licenceInputs({ mood: "sleeping" }));
    expect(l.mayCurl).toBe(true);
    expect(l.mayPlay).toBe(false);
  });

  it("allows a curl and a game while hovered, but no new starts", () => {
    const l = resolveLicence(licenceInputs({ hovering: true }));
    expect(l.mayCurl).toBe(true);
    expect(l.mayPlay).toBe(true);
    expect(l.mayWander).toBe(false);
    expect(l.mayBegin).toBe(false);
  });

  it("allows everything when idle and unbothered", () => {
    const l = resolveLicence(licenceInputs());
    expect(l).toEqual({
      mayCurl: true,
      mayPlay: true,
      mayWander: true,
      mayBegin: true,
    });
  });

  it("rules out the two loud behaviours during a running session", () => {
    // The ball would roll over the floor ring, and a window that walks off
    // while you are deliberately not looking at it is the worst outcome here.
    const l = resolveLicence(
      licenceInputs({ focus: { remaining: 900, paused: false } }),
    );
    expect(l.mayCurl).toBe(true);
    expect(l.mayPlay).toBe(false);
    expect(l.mayWander).toBe(false);
  });

  it("stops the window moving while another of our windows is up", () => {
    const l = resolveLicence(licenceInputs({ otherWindows: true }));
    expect(l.mayWander).toBe(false);
    // ...but nothing else is affected.
    expect(l.mayCurl).toBe(true);
    expect(l.mayPlay).toBe(true);
  });

  it("never permits wandering without also permitting a start", () => {
    // mayWander implies the window may move, which must never happen from a
    // state that forbids beginning things.
    for (const mood of ALL_MOODS) {
      for (const hovering of [false, true]) {
        for (const dragging of [false, true]) {
          const l = resolveLicence(licenceInputs({ mood, hovering, dragging }));
          if (l.mayWander) expect(l.mayBegin, `${mood}`).toBe(true);
        }
      }
    }
  });
});

describe("canCurl", () => {
  it("excludes the characters that never touch the floor", () => {
    // All three would be curling up in mid-air.
    for (const id of ["fairy", "droid", "plane"]) {
      expect(canCurl(findCompanion(id)), id).toBe(false);
    }
  });

  it("excludes the machines — a box of rivets folding reads as damage", () => {
    for (const c of COMPANIONS) {
      if (c.group === "machines") expect(canCurl(c), c.id).toBe(false);
    }
  });

  it("includes every cat and dog", () => {
    for (const c of COMPANIONS) {
      if (c.group === "cats" || c.group === "dogs") {
        expect(canCurl(c), c.id).toBe(true);
      }
    }
  });

  it("agrees with castsShadow for every companion", () => {
    for (const c of COMPANIONS) {
      if (!c.castsShadow) expect(canCurl(c), c.id).toBe(false);
    }
  });
});

describe("the curl state machine", () => {
  const idle = resolveLicence(licenceInputs());
  /** Deterministic: always the midpoint of a range. */
  const midpoint = (): number => 0.5;

  const run = (
    d: CurlDirector,
    seconds: number,
    licence = idle,
    startMs = 0,
    phase = 0,
  ): number => {
    const dt = 1 / 60;
    let t = startMs;
    for (let i = 0; i < seconds * 60; i++) {
      t += dt * 1000;
      d.tick(dt, licence, phase, t);
    }
    return t;
  };

  it("stands still until the first loaf is due", () => {
    const d = new CurlDirector(midpoint);
    // Midpoint of 70..210 is 140 seconds.
    run(d, 100);
    expect(d.curl).toBe(0);
  });

  it("curls up once the schedule comes round", () => {
    const d = new CurlDirector(midpoint);
    run(d, 145);
    expect(d.curl).toBeGreaterThan(0);
  });

  it("takes about the documented time to curl in", () => {
    const d = new CurlDirector(midpoint);
    d.forceCurl(0, 60);
    run(d, CURL_IN_SECONDS + 0.1);
    expect(d.curl).toBeCloseTo(1, 2);
  });

  it("uncurls faster than it curls", () => {
    expect(CURL_IN_SECONDS).toBeGreaterThan(0.55);
  });

  it("gets up when the licence is withdrawn mid-loaf", () => {
    const d = new CurlDirector(midpoint);
    d.forceCurl(0, 600);
    let t = run(d, 2);
    expect(d.curl).toBeCloseTo(1, 2);

    const cross = resolveLicence(licenceInputs({ mood: "tantrum" }));
    t = run(d, 1, cross, t);
    expect(d.curl).toBe(0);
  });

  it("reschedules from the interruption rather than pouncing straight after", () => {
    // The bug this guards: an interrupted loaf that re-fires on the first idle
    // frame after the interruption clears, so the pet appears to curl AT you.
    const d = new CurlDirector(midpoint);
    d.forceCurl(0, 600);
    let t = run(d, 2);
    const cross = resolveLicence(licenceInputs({ mood: "tantrum" }));
    t = run(d, 1, cross, t);
    // Back to idle: it must NOT immediately curl again.
    t = run(d, 10, idle, t);
    expect(d.curl).toBe(0);
  });

  it("never curls a companion that cannot", () => {
    const d = new CurlDirector(midpoint);
    d.canLoaf = false;
    run(d, 400);
    expect(d.curl).toBe(0);
  });

  it("never curls while something else ambient is running", () => {
    const d = new CurlDirector(midpoint);
    const dt = 1 / 60;
    let t = 0;
    for (let i = 0; i < 400 * 60; i++) {
      t += dt * 1000;
      d.tick(dt, idle, 0, t, true); // busy
    }
    expect(d.curl).toBe(0);
  });

  it("respects the loafing setting being switched off", () => {
    const d = new CurlDirector(midpoint);
    d.settings = { ...defaultBehaviourSettings(), loafing: false };
    run(d, 400);
    expect(d.curl).toBe(0);
  });

  it("keeps curl in 0..1 whatever the frame time", () => {
    const d = new CurlDirector(midpoint);
    d.forceCurl(0, 600);
    // A giant dt — a stalled frame, or the machine waking from sleep.
    d.tick(5, idle, 0, 1000);
    expect(d.curl).toBeLessThanOrEqual(1);
    expect(d.curl).toBeGreaterThanOrEqual(0);
  });

  it("peeks only while deeply curled, on the phase clock", () => {
    const d = new CurlDirector(midpoint);
    d.forceCurl(0, 600);
    run(d, 2);
    // phase % 11 > 8.6 is the eyes-open window.
    d.tick(1 / 60, idle, 9.0, 5000);
    expect(d.state.peeking).toBe(true);
    d.tick(1 / 60, idle, 3.0, 5100);
    expect(d.state.peeking).toBe(false);
  });

  it("never peeks while standing", () => {
    const d = new CurlDirector(midpoint);
    d.tick(1 / 60, idle, 9.0, 100);
    expect(d.state.peeking).toBe(false);
  });
});

describe("the mood ladder", () => {
  const ladder = (over: Partial<MoodInputs>): Mood =>
    resolveMood({ hovering: false, override: null, sleeping: false, debug: null, ...over });

  it("lets petting outrank whatever else is going on", () => {
    // "Petting calms even a tantrum" — the reference puts hovering at the top on
    // purpose, and it is the rung most likely to be demoted by accident.
    expect(ladder({ hovering: true, override: "worried", sleeping: true })).toBe("happy");
  });

  it("lets a spoken line outrank being asleep", () => {
    // A nudge that arrived just as you stepped away must still show the worried
    // face rather than a sleeping one.
    expect(ladder({ override: "worried", sleeping: true })).toBe("worried");
  });

  it("sleeps when the tracker says you are away", () => {
    // The tracker reported this on every tick from the day it landed and nothing
    // was listening, so the character stayed wide awake through a lunch break.
    expect(ladder({ sleeping: true })).toBe("sleeping");
  });

  it("keeps the development cycle underneath every real signal", () => {
    expect(ladder({ debug: "proud" })).toBe("proud");
    expect(ladder({ debug: "proud", sleeping: true })).toBe("sleeping");
  });

  it("is idle when nothing at all is happening", () => {
    expect(ladder({})).toBe("idle");
  });
});
