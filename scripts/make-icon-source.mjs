/**
 * Generate the 1024x1024 source PNG that `npx tauri icon` expands into every
 * platform icon format.
 *
 * Written as a script rather than a committed binary so the icon is
 * reproducible and reviewable — the same reason the reference renders its
 * closet thumbnails from the live character code instead of shipping PNGs.
 *
 * Deliberately dependency-free: a small hand-rolled PNG encoder (zlib is in
 * Node core) rather than pulling an image library into a project whose whole
 * pitch is a small, auditable dependency list.
 *
 *   node scripts/make-icon-source.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = 1024;
const OUT = "src-tauri/icon-source.png";

// Loaf's ginger tabby, straight from CatBreeds.
const FUR = [0xf6, 0xc1, 0x77];
const FUR_DARK = [0xdd, 0x9a, 0x4e];
const INK = [0x4a, 0x35, 0x27];
const INNER = [0xf2, 0xa2, 0xa2];

/** CRC32, per the PNG spec. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// RGBA canvas.
const px = new Uint8Array(SIZE * SIZE * 4);
const put = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Simple source-over so overlapping shapes blend rather than punch holes.
  const sa = a / 255;
  px[i] = Math.round(r * sa + px[i] * (1 - sa));
  px[i + 1] = Math.round(g * sa + px[i + 1] * (1 - sa));
  px[i + 2] = Math.round(b * sa + px[i + 2] * (1 - sa));
  px[i + 3] = Math.max(px[i + 3], a);
};

const ellipse = (cx, cy, rx, ry, colour) => {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        // Feather the last few percent so the edge is not staircased.
        const edge = Math.min(1, (1 - d) * 40);
        put(x, y, colour, Math.round(255 * edge));
      }
    }
  }
};

const triangle = (ax, ay, bx, by, cx2, cy2, colour) => {
  const minX = Math.floor(Math.min(ax, bx, cx2));
  const maxX = Math.ceil(Math.max(ax, bx, cx2));
  const minY = Math.floor(Math.min(ay, by, cy2));
  const maxY = Math.ceil(Math.max(ay, by, cy2));
  const sign = (px1, py1, px2, py2, px3, py3) =>
    (px1 - px3) * (py2 - py3) - (px2 - px3) * (py1 - py3);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = sign(x, y, ax, ay, bx, by);
      const d2 = sign(x, y, bx, by, cx2, cy2);
      const d3 = sign(x, y, cx2, cy2, ax, ay);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) put(x, y, colour);
    }
  }
};

// A loaf-shaped cat head, centred, with room to breathe at the edges.
const CX = SIZE / 2;
const CY = SIZE / 2 + 40;

// Ears.
triangle(300, 470, 360, 230, 470, 420, FUR);
triangle(724, 470, 664, 230, 554, 420, FUR);
triangle(340, 455, 378, 300, 448, 425, INNER);
triangle(684, 455, 646, 300, 576, 425, INNER);

// Head.
ellipse(CX, CY, 300, 262, FUR);

// Forehead M — the tabby giveaway.
for (const [ox, h] of [
  [-70, 110],
  [0, 150],
  [70, 110],
]) {
  ellipse(CX + ox, CY - 170, 22, h / 2, FUR_DARK);
}

// Eyes.
ellipse(CX - 112, CY - 20, 44, 58, INK);
ellipse(CX + 112, CY - 20, 44, 58, INK);
ellipse(CX - 96, CY - 46, 17, 17, [255, 255, 255]);
ellipse(CX + 128, CY - 46, 17, 17, [255, 255, 255]);

// Nose.
triangle(CX - 30, CY + 84, CX + 30, CY + 84, CX, CY + 122, [0xc9, 0x7b, 0x63]);

// Encode: each scanline is prefixed with filter byte 0.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(
    raw,
    y * (SIZE * 4 + 1) + 1,
  );
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes)`);
