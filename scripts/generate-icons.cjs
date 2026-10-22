// Generates PWA icons (regular, maskable, apple-touch, badge) from a simple
// vector description, using a hand-rolled PNG writer (no extra deps).
// Run: node scripts/generate-icons.cjs
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// PNG writing -----------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function writePng(filePath, width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
  console.log("wrote", filePath, `${Math.round(png.length / 1024)} KB`);
}

// Drawing ---------------------------------------------------------------------
function setColor(target, width, x, y, [r, g, b], alpha = 255) {
  if (x < 0 || y < 0 || x >= width || y >= target.length / (width * 4)) return;
  const offset = (y * width + x) * 4;
  const srcA = target[offset + 3] / 255;
  const dstA = alpha / 255;
  const outA = dstA + srcA * (1 - dstA);
  if (outA === 0) return;
  target[offset] = Math.round((r * dstA + target[offset] * srcA * (1 - dstA)) / outA);
  target[offset + 1] = Math.round((g * dstA + target[offset + 1] * srcA * (1 - dstA)) / outA);
  target[offset + 2] = Math.round((b * dstA + target[offset + 2] * srcA * (1 - dstA)) / outA);
  target[offset + 3] = Math.round(outA * 255);
}

// Draws the Bombila mark on a size x size RGBA buffer:
// dark rounded background, yellow circle, black ring, taxi checker band.
function drawMark(size, { safeRatio = 1 }) {
  const buffer = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = (size / 2) * 0.78 * safeRatio;
  const rFill = rOuter * 0.92;
  const bandHeight = rOuter * 0.34;
  const bandWidth = rOuter * 1.3;

  const fill = (x, y, color) => setColor(buffer, size, x, y, color);
  const inCircle = (x, y, cxp, cyp, r) => (x - cxp) ** 2 + (y - cyp) ** 2 <= r * r;

  // Background (rounded rect)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const margin = size * 0.04;
      const radius = size * 0.16;
      const inside =
        x >= margin && x < size - margin && y >= margin && y < size - margin;
      if (!inside) continue;
      const dx = Math.max(margin + radius - x, 0, x - (size - margin - radius) + radius);
      const dy = Math.max(margin + radius - y, 0, y - (size - margin - radius) + radius);
      fill(x, y, [0x0d, 0x0d, 0x0d]);
    }
  }

  // Yellow circle + thin dark outline
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d <= rFill * rFill) fill(x, y, [0xf7, 0xc7, 0x00]);
    }
  }

  // Taxi checker band (two offset rows) clipped to the circle
  const cell = rOuter * 0.19;
  const bandTop = cy - bandHeight / 2;
  const bandLeft = cx - bandWidth / 2;
  for (let y = Math.floor(bandTop); y < bandTop + bandHeight * 2; y += 1) {
    for (let x = Math.floor(bandLeft); x < bandLeft + bandWidth; x += 1) {
      if (!inCircle(x, y, cx, cy, rFill)) continue;
      const row = Math.floor((y - bandTop) / cell);
      const column = Math.floor((x - bandLeft) / cell);
      const black = (row + column) % 2 === 0;
      fill(x, y, black ? [0x11, 0x11, 0x11] : [0xf7, 0xc7, 0x00]);
    }
  }
  return buffer;
}

// Box-downsample 2x supersampled buffer to target size
function downsample(big, size) {
  const small = Buffer.alloc(size * size * 4);
  const bigSize = Math.round(Math.sqrt(big.length / 4));
  const scale = bigSize / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = (Math.floor(y * scale) * bigSize + Math.floor(x * scale)) * 4;
      const dst = (y * size + x) * 4;
      small[dst] = big[src];
      small[dst + 1] = big[src + 1];
      small[dst + 2] = big[src + 2];
      small[dst + 3] = big[src + 3];
    }
  }
  return small;
}

// Generate --------------------------------------------------------------------
const outDir = path.join(__dirname, "..", "client", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

const SUPERSAMPLE = 2;

for (const size of [192, 512]) {
  const big = drawMark(size * SUPERSAMPLE, { safeRatio: 1 });
  writePng(path.join(outDir, `icon-${size}.png`), size, size, downsample(big, size));
}

// Maskable: more padding so the safe zone survives launcher masking
{
  const big = drawMark(512 * SUPERSAMPLE, { safeRatio: 0.82 });
  writePng(path.join(outDir, "icon-maskable-512.png"), 512, 512, downsample(big, 512));
}

// Apple touch icon (iOS applies its own mask)
{
  const big = drawMark(180 * 2, { safeRatio: 1 });
  writePng(path.join(outDir, "apple-touch-icon-180.png"), 180, 180, downsample(big, 180));
}

// Badge for status bar notifications
{
  const size = 72;
  const big = drawMark(size * 2, { safeRatio: 1 });
  writePng(path.join(outDir, "badge-72.png"), size, size, downsample(big, size));
}

console.log("icons generated");
