// 生成 plugin.json 用的 256×256 图标：深色圆角底 + 上青下紫的双向换源箭头。
// 无第三方依赖，纯 Node 输出 PNG。用法：node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const SCALE = 4;
const W = SIZE * SCALE;
const root = fileURLToPath(new URL("../", import.meta.url));

const pixels = new Uint8Array(W * W * 4);

function blend(x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const index = (y * W + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  pixels[index] = Math.round(pixels[index] * (1 - a) + color[0] * a);
  pixels[index + 1] = Math.round(pixels[index + 1] * (1 - a) + color[1] * a);
  pixels[index + 2] = Math.round(pixels[index + 2] * (1 - a) + color[2] * a);
  pixels[index + 3] = Math.round(pixels[index + 3] * (1 - a) + 255 * a);
}

function roundedRect(x0, y0, x1, y1, radius, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x1 - radius);
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y1 - radius);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) blend(x, y, color);
    }
  }
}

function triangle(a, b, c, color) {
  const minX = Math.floor(Math.min(a[0], b[0], c[0]));
  const maxX = Math.ceil(Math.max(a[0], b[0], c[0]));
  const minY = Math.floor(Math.min(a[1], b[1], c[1]));
  const maxY = Math.ceil(Math.max(a[1], b[1], c[1]));
  const edge = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = edge(a, b, px, py);
      const w1 = edge(b, c, px, py);
      const w2 = edge(c, a, px, py);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) blend(x, y, color);
    }
  }
}

const S = SCALE;
const cyan = [34, 211, 238];
const violet = [167, 139, 250];
const background = [15, 23, 42];

roundedRect(8 * S, 8 * S, 248 * S, 248 * S, 56 * S, background);
// 上箭头：青色条 + 向右箭头
roundedRect(44 * S, 84 * S, 168 * S, 112 * S, 14 * S, cyan);
triangle([166 * S, 70 * S], [206 * S, 98 * S], [166 * S, 126 * S], cyan);
// 下箭头：紫色条 + 向左箭头
roundedRect(88 * S, 144 * S, 212 * S, 172 * S, 14 * S, violet);
triangle([90 * S, 130 * S], [50 * S, 158 * S], [90 * S, 186 * S], violet);

// 4×4 超采样降噪
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < SCALE; sy += 1) {
      for (let sx = 0; sx < SCALE; sx += 1) {
        const index = ((y * SCALE + sy) * W + (x * SCALE + sx)) * 4;
        for (let channel = 0; channel < 4; channel += 1) sum[channel] += pixels[index + channel];
      }
    }
    const offset = (y * SIZE + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) out[offset + channel] = Math.round(sum[channel] / (SCALE * SCALE));
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(path.join(root, "icon.png"), png);
console.log(`icon.png ${SIZE}x${SIZE} ${png.length} bytes`);
