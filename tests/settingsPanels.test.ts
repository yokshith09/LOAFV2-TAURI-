import { describe, it, expect } from "vitest";
import {
  ClosetSettings,
  MemorySettingsStore,
  type ClosetState,
} from "../src/closet/settings";
import { COMPANIONS } from "../src/companions/registry";
import {
  listenRow,
  holdRow,
  engineRow,
  voiceRow,
  habitRows,
  soundRow,
  disclosurePanel,
  whisperDownloadRow,
  SETTINGS_CSS,
} from "../src/settings/panels";

/**
 * The settings controls, tested where they are defined.
 *
 * These used to be asserted through `closetBody`, because the closet was the
 * only window that rendered them. They live in the dashboard now, and testing
 * them through whichever window happens to host them this month is what made
 * the move noisy in the first place. The builders are the unit.
 */

const fresh = (): ClosetSettings => new ClosetSettings(new MemorySettingsStore());
const state = (over: Partial<ClosetState> = {}): ClosetState => ({
  ...fresh().read(),
  ...over,
});

describe("the habit switches", () => {
  const withHabits = (
    over: Record<string, boolean> = {},
    companionId?: string,
  ): ClosetState => {
    const s = fresh();
    if (companionId) s.setCompanion(companionId);
    s.habits = { loafing: true, playing: true, wandering: false, drifting: true, ...over };
    return s.read();
  };

  it("offers the three habits every character has", () => {
    const html = habitRows(withHabits());
    for (const h of ["loafing", "playing", "wandering"]) {
      expect(html).toContain(`data-habit="${h}"`);
    }
  });

  it("does not offer drifting to something that cannot drift", () => {
    // A switch wired to nothing, whose default is the opposite of wandering's
    // — baffling sitting next to it on a cat.
    expect(habitRows(withHabits({}, "cat-ginger"))).not.toContain('data-habit="drifting"');
  });

  it("offers drifting to a ghost", () => {
    const ghost = COMPANIONS.find((c) => c.drifts)!;
    expect(habitRows(withHabits({}, ghost.id))).toContain('data-habit="drifting"');
  });

  it("checks the ones that are on and leaves wandering off", () => {
    // The window walk has been built and tested and unreachable; this is the
    // control that finally turns it on, and it must start off.
    const html = habitRows(withHabits());
    expect(html).toMatch(/data-habit="loafing" checked/);
    expect(html).not.toMatch(/data-habit="wandering" checked/);
  });
});

describe("the sound switch", () => {
  // A checkbox labelled "Mute" is on when the app is quiet, which reads
  // backwards next to habits that are on when something happens.
  it("is checked when Loaf is NOT muted", () => {
    expect(soundRow(state({ muted: false }))).toMatch(/data-sound="muted" checked/);
    expect(soundRow(state({ muted: true }))).not.toMatch(/checked/);
  });
});

describe("the Whisper download row", () => {
  it("offers a download button when Whisper is not ready", () => {
    const html = whisperDownloadRow(state({ engine: "whisper" }));
    expect(html).toContain("data-whisper-download");
    expect(html).toContain("190 MB");
  });

  it("shows a progress bar instead of the button while downloading", () => {
    const html = whisperDownloadRow(
      state({
        engine: "whisper",
        whisperDownload: { downloaded: 95_000_000, total: 190_000_000 },
      }),
    );
    expect(html).not.toContain("data-whisper-download");
    expect(html).toContain("whisper-fill");
    expect(html).toContain("50%");
  });

  it("shows neither once Whisper is ready", () => {
    const html = whisperDownloadRow(
      state({
        engine: "whisper",
        engineAvailability: { builtinReady: true, whisperModel: true, hostedConnected: false },
      }),
    );
    expect(html).not.toContain("data-whisper-download");
    expect(html).not.toContain("whisper-fill");
  });

  it("names meetings once Whisper is installed, not just dictation", () => {
    const html = whisperDownloadRow(
      state({
        engine: "whisper",
        engineAvailability: { builtinReady: true, whisperModel: true, hostedConnected: false },
      }),
    );
    expect(html).toContain("whisper-ready");
    expect(html.toLowerCase()).toContain("meeting");
  });

  it("names meetings on the download button too, before anyone clicks it", () => {
    const html = whisperDownloadRow(state({ engine: "whisper" }));
    expect(html.toLowerCase()).toContain("meeting");
    expect(html).toContain("data-whisper-download");
  });
});

describe("the listening controls", () => {
  // Off is a switch, not the first line of a dropdown. The only answer to "is
  // this thing listening to me" should be readable at a glance.
  it("always offers the on/off switch, whatever the mode", () => {
    for (const m of ["off", "push", "hover", "always"] as const) {
      expect(listenRow(state({ listenMode: m }))).toContain("data-listen-on");
    }
  });

  it("checks the switch when anything but off is chosen", () => {
    expect(listenRow(state({ listenMode: "off" }))).not.toMatch(/data-listen-on checked/);
    for (const m of ["push", "hover", "always"] as const) {
      expect(listenRow(state({ listenMode: m }))).toMatch(/data-listen-on checked/);
    }
  });

  it("hides the how-it-listens picker entirely while it is off", () => {
    const html = listenRow(state({ listenMode: "off" }));
    expect(html).not.toContain("data-listen-mode");
    expect(html).not.toContain("data-wake-word");
  });

  // Offering "off" in both places is how the two end up disagreeing.
  it("keeps off out of the picker once it is on", () => {
    const html = listenRow(state({ listenMode: "push" }));
    expect(html).toContain("data-listen-mode");
    expect(html).not.toContain('value="off"');
  });

  it("offers a wake word only in the mode that uses one", () => {
    expect(listenRow(state({ listenMode: "always" }))).toContain("data-wake-word");
    expect(listenRow(state({ listenMode: "push" }))).not.toContain("data-wake-word");
  });

  it("offers a hold delay only in hover mode", () => {
    expect(holdRow(state({ listenMode: "hover" }))).toContain("data-hold");
    expect(holdRow(state({ listenMode: "always" }))).toBe("");
  });

  it("marks always-on as the loud one", () => {
    expect(listenRow(state({ listenMode: "always" }))).toContain("listen hot");
    expect(listenRow(state({ listenMode: "push" }))).not.toContain("listen hot");
  });
});

describe("the engine picker", () => {
  // Whisper is no longer one of the choices here. It is a batch transcriber:
  // it answers once a recording has finished, which is right for a meeting and
  // wrong for a command, where the gap between speaking and something
  // happening is the whole feature. It lives under Meetings instead.
  it("does not offer Whisper for talking to Loaf", () => {
    const html = engineRow(state());
    expect(html).not.toContain('value="whisper"');
    expect(html).toContain('value="builtin"');
  });

  it("still lists an engine that cannot run, with the reason attached", () => {
    // Hiding it leaves people wondering whether the option exists at all.
    const html = engineRow(state());
    expect(html).toContain('value="hosted"');
    expect(html).toMatch(/value="hosted"[^>]*disabled/);
  });

  it("marks an engine that sends audio away as the loud one", () => {
    expect(engineRow(state({ engine: "hosted" }))).toContain("listen hot");
    expect(engineRow(state({ engine: "builtin" }))).not.toContain("listen hot");
  });
});

describe("the spoken-voice picker", () => {
  it("says so when the machine has no local voices, rather than showing an empty list", () => {
    expect(voiceRow(state({ voices: [] }))).toContain("No speech voices");
  });

  it("offers the local ones, and letting Loaf choose", () => {
    const html = voiceRow(state({ voices: ["George", "Hazel"] }));
    expect(html).toContain("Let Loaf choose");
    expect(html).toContain("George");
  });
});

describe("the disclosure panel", () => {
  it("names the active speech engine and where its audio goes", () => {
    expect(disclosurePanel(state({ engine: "builtin" }))).toContain("never leaves this device");
    expect(disclosurePanel(state({ engine: "hosted" }))).toContain("Audio leaves this device");
  });

  it("names the wake word when always-listening is on", () => {
    expect(
      disclosurePanel(state({ listenMode: "always", wakeWord: "biscuit" })),
    ).toContain("biscuit");
  });

  it("says meeting recording is not available until Whisper is downloaded", () => {
    expect(
      disclosurePanel(
        state({
          engineAvailability: {
            builtinReady: true,
            whisperModel: false,
            hostedConnected: false,
          },
        }),
      ),
    ).toContain("Not available");
  });

  it("is honest that MCP connections do not have a UI yet", () => {
    expect(disclosurePanel(state())).toContain("not built yet");
  });

  // "Nothing happens when I talk" is the same symptom whether Loaf can see no
  // microphone or can see one and something else is wrong. The panel has to
  // tell those apart, or the only debugging move left is toggling permissions
  // at random.
  it("names the microphone it would record from", () => {
    expect(disclosurePanel(state({ microphone: "Headset (Realtek Audio)" }))).toContain(
      "Headset (Realtek Audio)",
    );
  });

  it("says so plainly when it can see no microphone at all", () => {
    expect(disclosurePanel(state({ microphone: null }))).toContain("None found");
  });

  // The built-in recogniser hears only the phrases it was handed. Someone who
  // has just tried to dictate into it and got nothing deserves to be told that
  // rather than left assuming their microphone is broken.
  it("says the built-in recogniser is what handles commands and dictation", () => {
    expect(disclosurePanel(state({ engine: "builtin" }))).toContain(
      "Used for commands and dictation",
    );
  });

  // Two jobs, two tools, and the panel has to say which does which.
  it("names Whisper as the meeting transcriber, not the command listener", () => {
    const ready = disclosurePanel(
      state({
        engineAvailability: { builtinReady: true, whisperModel: true, hostedConnected: false },
      }),
    );
    expect(ready).toContain("Whisper, on this machine");
    const missing = disclosurePanel(state());
    expect(missing).toContain("Meetings tab");
  });
});

describe("the stylesheet that travels with the markup", () => {
  // Carried with the builders so a window that renders these cannot end up
  // rendering them unstyled — which is what a settings page looks like when
  // someone moves it and forgets the CSS.
  it("styles every class the builders emit", () => {
    for (const cls of [
      ".habit",
      ".listen",
      ".voice select",
      ".disclosure",
      ".whisper-bar",
      ".whisper-dl-btn",
    ]) {
      expect(SETTINGS_CSS).toContain(cls);
    }
  });
});
