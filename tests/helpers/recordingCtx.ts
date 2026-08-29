import type { Ctx2D } from "../../src/core/types";

export interface RecordedCall {
  readonly op: string;
  readonly args: readonly number[];
  /** fillStyle/strokeStyle in force when the call was made. */
  readonly fill: string;
  readonly stroke: string;
  readonly lineWidth: number;
}

/**
 * A recording stand-in for `CanvasRenderingContext2D`.
 *
 * Lets the entire drawing layer be exercised in Node with no native canvas
 * binding and no browser — we assert on the *instructions* emitted rather than
 * on pixels. Pixel-level checks belong in the Phase 0 visual spike, not here.
 *
 * It also accumulates a bounding box of every coordinate touched, which is how
 * we enforce the design-space contract (nothing may draw into the tab-badge
 * strip, nothing may fall through the floor).
 */
export class RecordingCtx implements Ctx2D {
  fillStyle = "#000";
  strokeStyle = "#000";
  lineWidth = 1;
  lineCap: "butt" | "round" | "square" = "butt";
  lineJoin: "round" | "bevel" | "miter" = "miter";
  globalAlpha = 1;

  readonly calls: RecordedCall[] = [];

  minX = Number.POSITIVE_INFINITY;
  minY = Number.POSITIVE_INFINITY;
  maxX = Number.NEGATIVE_INFINITY;
  maxY = Number.NEGATIVE_INFINITY;

  private record(op: string, ...args: number[]): void {
    this.calls.push({
      op,
      args,
      fill: this.fillStyle,
      stroke: this.strokeStyle,
      lineWidth: this.lineWidth,
    });
  }

  /** Track a point for the bounding box. Ignores non-positional ops. */
  private touch(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  save(): void {
    this.record("save");
  }
  restore(): void {
    this.record("restore");
  }
  beginPath(): void {
    this.record("beginPath");
  }
  closePath(): void {
    this.record("closePath");
  }

  moveTo(x: number, y: number): void {
    this.touch(x, y);
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.touch(x, y);
    this.record("lineTo", x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    // Control points can legitimately sit outside the drawn shape, so only the
    // endpoint contributes to the bounding box.
    this.touch(x, y);
    this.record("bezierCurveTo", cp1x, cp1y, cp2x, cp2y, x, y);
  }
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.touch(x - rx, y - ry);
    this.touch(x + rx, y + ry);
    this.record(
      "ellipse",
      x,
      y,
      rx,
      ry,
      rotation,
      startAngle,
      endAngle,
      counterclockwise ? 1 : 0,
    );
  }
  fill(): void {
    this.record("fill");
  }
  stroke(): void {
    this.record("stroke");
  }
  clip(): void {
    this.record("clip");
  }
  translate(x: number, y: number): void {
    this.record("translate", x, y);
  }
  scale(x: number, y: number): void {
    this.record("scale", x, y);
  }
  rotate(angle: number): void {
    this.record("rotate", angle);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", x, y, w, h);
  }

  // --- assertions support ---

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
  /** Distinct fill/stroke colours actually used on a paint call. */
  paintedColours(): Set<string> {
    const out = new Set<string>();
    for (const c of this.calls) {
      if (c.op === "fill") out.add(c.fill);
      if (c.op === "stroke") out.add(c.stroke);
    }
    return out;
  }
  /** A stable fingerprint of the emitted geometry, for comparing two renders. */
  signature(): string {
    return this.calls
      .map((c) => `${c.op}(${c.args.map((n) => n.toFixed(3)).join(",")})`)
      .join("|");
  }
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }
  hasFiniteBounds(): boolean {
    return (
      Number.isFinite(this.minX) &&
      Number.isFinite(this.minY) &&
      Number.isFinite(this.maxX) &&
      Number.isFinite(this.maxY)
    );
  }
  /** True when any emitted number is NaN/Infinity — the classic bezier-maths bug. */
  hasNonFiniteArgs(): boolean {
    return this.calls.some((c) => c.args.some((n) => !Number.isFinite(n)));
  }
}
