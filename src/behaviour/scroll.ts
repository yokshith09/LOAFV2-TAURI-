/**
 * The scrolling pose's trigger. Ported from `scrollEnergy` in `CompanionView.swift`.
 *
 * Energy rises while the wheel is moving and bleeds off when it stops, so a
 * single stray notch does not yank him into the pose and a real scroll holds it
 * for a moment after you finish. A bare "scrolled in the last 300ms" flag would
 * make him flicker on every accidental touch of a trackpad.
 *
 * The reference drives this from event deltas, which it can because it receives
 * the events. Here the platform reports only how long since the last one — see
 * `scroll.rs` for why that is all it is allowed to know — so the rise is a rate
 * rather than a magnitude. The reference has exactly this as its own fallback
 * path, for when an event monitor is unavailable.
 */

/** Above this, he is scrolling. Matches the reference. */
export const SCROLL_TRIGGER = 12;
/** Energy is capped, so a long scroll does not take a long time to end. */
export const SCROLL_CEILING = 60;
/** Per second, while the wheel is moving. Reaches the trigger in about 0.4s. */
export const SCROLL_RISE = 30;
/** Per second, once it stops. The reference bleeds 45 a second. */
export const SCROLL_DECAY = 45;
/**
 * How recent a scroll has to be to count as still scrolling.
 *
 * The reference uses 0.35s in its own fallback. Wider and a pause between
 * flicks reads as one continuous scroll; narrower and the gap between two
 * wheel notches breaks it.
 */
export const SCROLL_RECENT = 0.35;

export class ScrollEnergy {
  private value = 0;

  get energy(): number {
    return this.value;
  }

  get isScrolling(): boolean {
    return this.value > SCROLL_TRIGGER;
  }

  /**
   * @param secondsSinceScroll what the platform reported, or null if it cannot say.
   * @param dt seconds since the last call.
   */
  tick(secondsSinceScroll: number | null, dt: number): void {
    if (dt <= 0) return;
    // A platform that cannot answer decays to nothing rather than holding the
    // last pose forever. Loaf without a scroll pose is a small loss; Loaf stuck
    // reading an imaginary scroll is a bug.
    const recent = secondsSinceScroll !== null && secondsSinceScroll < SCROLL_RECENT;
    this.value = recent
      ? Math.min(SCROLL_CEILING, this.value + SCROLL_RISE * dt)
      : Math.max(0, this.value - SCROLL_DECAY * dt);
  }

  reset(): void {
    this.value = 0;
  }
}
