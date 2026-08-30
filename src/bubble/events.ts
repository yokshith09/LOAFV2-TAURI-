/**
 * What the companion window sends the bubble window.
 *
 * The companion decides what to say and when; the bubble only renders and
 * measures. Keeping the decision on one side means the mood override, the
 * focus-session suppression and the prompt rotation all live next to the state
 * they depend on.
 */

export const BUBBLE_SHOW_EVENT = "loaf://bubble/show";
export const BUBBLE_HIDE_EVENT = "loaf://bubble/hide";

export type BubblePayload =
  | {
      readonly kind: "speech";
      readonly text: string;
      /** Auto-hide after this long. 0 or absent means it stays until dismissed. */
      readonly seconds?: number;
    }
  | {
      readonly kind: "preview";
      /**
       * The history, serialised.
       *
       * Passed rather than re-read from disk: the companion holds unsaved ticks
       * for up to a minute, and a preview that read the file would show a total
       * lower than the one the character is standing next to.
       */
      readonly stats: string;
      readonly seconds?: number;
    };
