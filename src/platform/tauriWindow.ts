import type { Frame, MovableWindow, Pt, ScreenInfo } from "../behaviour/wander";

/**
 * A `MovableWindow` backed by Tauri's window API.
 *
 * WHY A CACHE. `WanderController` is synchronous, because the walk has to be
 * abortable on the frame the interruption happens — that is the whole reason it
 * is hand-rolled rather than handed to a platform animator. Tauri's window API
 * is async. Rather than make the controller async (and lose that property, and
 * the tests that depend on it), this adapter keeps a snapshot: positions and
 * monitors are refreshed on a slow poll, and `setOrigin` is fire-and-forget.
 *
 * That is sound because of what each value is used for. Monitors change when
 * someone plugs in a display — rarely, and the walk clamps against the *cached*
 * layout every frame anyway, so a stale snapshot is at worst one poll interval
 * of walking toward a spot that has just become illegal, which the next poll
 * corrects. The window's own origin is authoritative here because we are the
 * only thing moving it, apart from the user dragging — which aborts the walk.
 */

/** Monitors barely ever change; the origin only changes when we move it. */
const REFRESH_MS = 2000;

export class TauriMovableWindow implements MovableWindow {
  private frame: Frame = { x: 0, y: 0, width: 0, height: 0 };
  private screensValue: ScreenInfo[] = [];
  private lastRefresh = 0;
  private refreshing = false;
  private ready = false;

  /** True once a real frame has been read; the caller should not walk before. */
  get isReady(): boolean {
    return this.ready;
  }

  getFrame(): Frame {
    return this.frame;
  }

  screens(): readonly ScreenInfo[] {
    return this.screensValue;
  }

  setOrigin(p: Pt): void {
    // Optimistic: update the snapshot immediately so the next frame's clamp
    // reasons about where we just asked to be, not where we were.
    this.frame = { ...this.frame, x: Math.round(p.x), y: Math.round(p.y) };
    void this.applyOrigin(this.frame.x, this.frame.y);
  }

  private async applyOrigin(x: number, y: number): Promise<void> {
    try {
      const [{ getCurrentWindow }, { PhysicalPosition }] = await Promise.all([
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/dpi"),
      ]);
      await getCurrentWindow().setPosition(new PhysicalPosition(x, y));
    } catch {
      // Running in a plain browser, or the window went away mid-walk. Either
      // way there is nothing to move and nothing to report.
    }
  }

  /**
   * Refresh the snapshot if it is stale. Safe to call every frame; it does
   * nothing most of the time.
   */
  poll(nowMs: number): void {
    if (this.refreshing || nowMs - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = nowMs;
    this.refreshing = true;
    void this.refresh().finally(() => {
      this.refreshing = false;
    });
  }

  private async refresh(): Promise<void> {
    try {
      const { getCurrentWindow, availableMonitors } = await import(
        "@tauri-apps/api/window"
      );
      const win = getCurrentWindow();
      const [pos, size, monitors] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        availableMonitors(),
      ]);

      this.frame = { x: pos.x, y: pos.y, width: size.width, height: size.height };
      this.screensValue = monitors.map((m) => {
        const frame: Frame = {
          x: m.position.x,
          y: m.position.y,
          width: m.size.width,
          height: m.size.height,
        };
        // Tauri does not expose a work area, so the dock/taskbar inset is an
        // approximation. The reference has the same problem and solves it the
        // same way; the leash and the clamp both still hold, the pet just will
        // not walk quite to the very edge.
        const inset = Math.round(Math.min(frame.height * 0.06, 60));
        return {
          frame,
          visible: {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: Math.max(0, frame.height - inset),
          },
        };
      });
      this.ready = this.screensValue.length > 0 && this.frame.width > 0;
    } catch {
      // No Tauri host. Stay not-ready, which keeps the walk switched off.
      this.ready = false;
    }
  }
}
