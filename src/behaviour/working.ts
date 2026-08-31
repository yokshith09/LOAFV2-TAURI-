/**
 * "Your machine is busy, so he waits with you."
 *
 * The signal is the foreground process's CPU. Loaf cannot know WHETHER that is
 * a model thinking, a build running or a video exporting, and it does not try —
 * knowing the window in front of you is working is the honest version, and it
 * is the version that behaves correctly for every long job rather than for one
 * vendor's.
 *
 * WHAT THIS IS NOT. No process is inspected beyond the one already in front of
 * you, which the tracker has been reading since the beginning. Nothing is
 * stored, nothing is named beyond what the tracker already records, and a
 * refusal from the OS reads as "no idea", never as "not busy".
 */

/**
 * Above this, the foreground process counts as working.
 *
 * Percentage of ONE core, not of the machine — a single-threaded build pinning
 * one core of sixteen is busy in every sense a person means it, and dividing by
 * the core count would call that 6% and report idle.
 *
 * Sixty rather than something lower because a modern editor idles noisily:
 * syntax highlighting, spell check and a blinking caret all cost a few percent,
 * and a threshold that catches those would leave him permanently "waiting".
 */
export const WORKING_THRESHOLD = 60;

/**
 * How long it must stay busy before he reacts, and how long after it stops.
 *
 * Asymmetric on purpose. Entering is slow so a one-second spike — saving a
 * file, opening a menu — does not pull him into a pose. Leaving is slower
 * still, because real work is bursty: a compiler that drops to 20% for half a
 * second between stages has not finished, and a character that snapped out and
 * back would flicker exactly when you are watching him.
 */
export const WORKING_ENTER_SECONDS = 2.5;
export const WORKING_LEAVE_SECONDS = 4;

/**
 * Below this, the job was too short to have been worth waiting for.
 *
 * Used only to decide whether to say anything when it ends. Remarking on a
 * four-second build is worse than saying nothing.
 */
export const WORTH_MENTIONING_SECONDS = 45;

export interface WorkingSample {
  /** Whether the machine is busy right now. */
  readonly busy: boolean;
  /** Seconds the current busy stretch has lasted, or 0 when not busy. */
  readonly forSeconds: number;
  /**
   * Set for exactly one tick, when a long stretch has just ended.
   *
   * Carries how long it ran, so the caller can say something proportionate —
   * or, below `WORTH_MENTIONING_SECONDS`, nothing at all.
   */
  readonly justFinished: number | null;
}

/**
 * Turns a stream of CPU readings into a state worth animating.
 *
 * Hysteresis rather than a threshold, for the reason `ScrollEnergy` uses it:
 * a bare "over 60% right now" flag flickers on every sample, and a character
 * that flickers reads as broken rather than as busy.
 */
export class WorkingWatch {
  private busyValue = false;
  /** Seconds the reading has disagreed with the current state. */
  private pending = 0;
  private heldFor = 0;

  constructor(
    private readonly threshold = WORKING_THRESHOLD,
    private readonly enterAfter = WORKING_ENTER_SECONDS,
    private readonly leaveAfter = WORKING_LEAVE_SECONDS,
  ) {}

  get busy(): boolean {
    return this.busyValue;
  }

  /**
   * @param cpu percentage of one core, or null when the OS would not say.
   * @param dt seconds since the last call.
   */
  tick(cpu: number | null, dt: number): WorkingSample {
    if (dt <= 0) {
      return { busy: this.busyValue, forSeconds: this.heldFor, justFinished: null };
    }

    // "No idea" is not "not busy" — but it cannot hold him in a pose forever
    // either, so it decays toward idle at the ordinary leaving rate rather than
    // being treated as a reading of zero.
    const readingIsBusy = cpu === null ? false : cpu >= this.threshold;

    let justFinished: number | null = null;

    if (readingIsBusy === this.busyValue) {
      this.pending = 0;
    } else {
      this.pending += dt;
      const needed = this.busyValue ? this.leaveAfter : this.enterAfter;
      if (this.pending >= needed) {
        this.pending = 0;
        if (this.busyValue) {
          // Report the stretch INCLUDING the quiet tail we waited through, so
          // "that took a while" is measured from when it actually started.
          justFinished = this.heldFor;
          this.busyValue = false;
          this.heldFor = 0;
        } else {
          this.busyValue = true;
          this.heldFor = 0;
        }
      }
    }

    if (this.busyValue) this.heldFor += dt;

    return { busy: this.busyValue, forSeconds: this.heldFor, justFinished };
  }

  reset(): void {
    this.busyValue = false;
    this.pending = 0;
    this.heldFor = 0;
  }
}
