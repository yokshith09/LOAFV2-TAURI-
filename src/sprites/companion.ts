import {
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  GROUND_Y,
  type Color,
  type CompanionGroup,
  type Companion,
  type CompanionPalette,
  type Ctx2D,
  type DrawableImage,
  type Point,
  type Rect,
  type SceneState,
} from "../core/types";
import { frameAt, frameRect, type SpritePack } from "./manifest";

/**
 * A sprite pack, wearing the `Companion` contract. Ported from
 * `SpriteCompanion` in `SpriteCompanion.swift`.
 *
 * The whole point of the contract is on display here: this draws a PNG and the
 * eighteen others draw beziers, and nothing above them can tell. It gets the
 * same moods, the same hats, the same focus ring, and it sits on the same shelf
 * in the closet — because everything shared talks to the anchors, and a pack
 * declares anchors just like a cat does.
 *
 * All four draw hooks but one are empty. A sheet is one flat picture, so there
 * is no back, body and head to separate: the frame goes down in `drawHead`,
 * which is the layer the shared eye system draws immediately after — so a pack
 * that does NOT draw its own face still gets eyes in the right place.
 */
export class SpriteCompanion implements Companion {
  /** Which mood is currently playing, and the phase it started at. */
  private playing: string | null = null;
  private clipStart = 0;

  constructor(
    readonly pack: SpritePack,
    private readonly sheet: DrawableImage,
  ) {}

  get id(): string {
    return this.pack.id;
  }
  get defaultName(): string {
    return this.pack.name;
  }
  get species(): string {
    return this.pack.species;
  }
  get blurb(): string {
    return this.pack.blurb;
  }
  get group(): CompanionGroup {
    return this.pack.group;
  }
  get castsShadow(): boolean {
    return this.pack.castsShadow;
  }
  get drawsOwnFace(): boolean {
    return this.pack.drawsOwnFace;
  }
  /** Always. This is the flag the fur ball and the pixel pass check. */
  readonly isPreRendered = true;
  /** A drawn character does not drift; only the ghost does, and it is ours. */
  readonly drifts = false;

  get palette(): CompanionPalette {
    return this.pack.palette;
  }
  get headEllipse(): Rect {
    return this.pack.headEllipse;
  }
  get eyeLeft(): Point {
    return this.pack.eyeLeft;
  }
  get eyeRight(): Point {
    return this.pack.eyeRight;
  }
  get eyeScale(): number {
    return this.pack.eyeScale;
  }
  get hatAnchor(): Point {
    return this.pack.hatAnchor;
  }
  get neckY(): number {
    return this.pack.neckY;
  }
  get handLeft(): Point {
    return this.pack.handLeft;
  }
  get handRight(): Point {
    return this.pack.handRight;
  }
  get handFill(): Color {
    return this.pack.palette.fur;
  }

  drawBehind(): void {}
  drawBody(): void {}
  drawMuzzle(): void {}

  drawHead(ctx: Ctx2D, s: SceneState): void {
    // A context with no `drawImage` is the recording stub used by the contract
    // tests. Drawing nothing there is correct and unreachable in the app.
    if (!ctx.drawImage) return;

    const clip = this.pack.clips[s.mood];
    if (!clip || clip.frames.length === 0) return;

    // Two things restart a clip. A change of mood is the real one. A phase that
    // went BACKWARDS is the closet: it renders eighteen thumbnails on a clock of
    // its own, and one view's timeline must not strand another on the last frame
    // of a played-out clip.
    if (this.playing !== s.mood || s.phase < this.clipStart) {
      this.playing = s.mood;
      this.clipStart = s.phase;
    }

    const src = frameRect(this.pack.sheet, frameAt(clip, s.phase - this.clipStart));
    const dest = this.destination();

    // The pixel pass rasterises the whole scene at 56x63 with smoothing already
    // off. Honour that rather than fighting it — turning smoothing back on here
    // would blur the one pass whose entire point is hard edges.
    if (ctx.imageSmoothingEnabled !== false) {
      ctx.imageSmoothingEnabled = !this.pack.pixelArt;
    }

    // The scene is drawn y-up and flipped once, so an image placed naively
    // arrives upside down. Un-flip locally, exactly as text does.
    ctx.save();
    ctx.translate(dest.x, dest.y + dest.height);
    ctx.scale(1, -1);
    ctx.drawImage(this.sheet, src.x, src.y, src.width, src.height, 0, 0, dest.width, dest.height);
    ctx.restore();
  }

  /**
   * Where the frame lands in design space.
   *
   * Sized by the sheet's own scale rather than stretched to fill: an @2x sheet
   * of 128x142 pixels is a 64x71 character, and a pack that drew a small animal
   * should get a small animal. Centred horizontally and stood on the ground
   * plane, so it shares a floor with everything else.
   */
  private destination(): Rect {
    const width = this.pack.sheet.frameWidth / this.pack.sheet.scale;
    const height = this.pack.sheet.frameHeight / this.pack.sheet.scale;
    return {
      x: (DESIGN_WIDTH - width) / 2,
      y: GROUND_Y,
      width,
      // A sheet taller than the design space is squashed to fit rather than
      // drawn through the badge strip.
      height: Math.min(height, DESIGN_HEIGHT - GROUND_Y),
    };
  }
}
