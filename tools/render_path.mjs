#!/usr/bin/env node
/* Rasterise a PathForge toolpath to a PNG without a GPU or a browser.
 *
 *   node tools/render_path.mjs "Helix, 1000 layers" -o /tmp/bead.png
 *   node tools/render_path.mjs "Ghost, 600 layers" --w 900 --h 1200
 *
 * The bead is drawn as a depth-shaded polyline: the picture is the proof —
 * one unbroken stroke climbing the whole build.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
const prompt = argv.find(a => !a.startsWith('-') && !['-o', '--w', '--h'].includes(a))
  || 'Helix, 1000 layers';
const out = get('-o', '/tmp/path.png');
const W = +get('--w', 800);
const H = +get('--h', 1100);
const cap = +get('--cap', 200000);        // max points drawn

const { generate, parsePrompt } = await import(resolve(root, 'meshforge/web/engine.js'));
const pf = await import(resolve(root, 'meshforge/web/pathforge.js'));

const p = parsePrompt(prompt);
if (get('--layers')) p.layers = +get('--layers');
if (get('--samples')) p.samples = +get('--samples');

console.log(`forging ${p.family} ${p.layers}L x ${p.samples}P …`);
const res = await generate(p);
const path = pf.spiralPath(res);
const a = path.audit, st = path.stats;
console.log(`${st.points} points · ${st.path_length_m} m bead · ${a.turns} turns`);
console.log(`continuous=${a.continuous} seams=${a.seams} travel=${a.travel_moves} `
  + `monotonic_z=${a.monotonic_z} layers=${a.layers_traversed}/${st.layers} `
  + `pass=${a.pass}`);
console.log(`control: travel=${a.control.travel_moves} pass=${a.control.pass}`);

/* ---------------------------------------------------------------- raster */
const buf = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) {          // subtle vertical backdrop
  const y = (i / W) | 0;
  const t = y / H;
  buf[i * 3] = 10 + t * 6;
  buf[i * 3 + 1] = 12 + t * 8;
  buf[i * 3 + 2] = 16 + t * 10;
}

const pts = path.points;
const n = pts.length / 3;
const zs = path.points;
let zmax = 0;
for (let k = 2; k < zs.length; k += 3) if (zs[k] > zmax) zmax = zs[k];
const height = zmax || 1;
let rmax = 1;
for (let k = 0; k < pts.length; k += 3) {
  const r = Math.hypot(pts[k], pts[k + 1]);
  if (r > rmax) rmax = r;
}

/* camera: orbit slightly, look at the middle of the build */
const yaw = (+get('--yaw', 26)) * Math.PI / 180;
const pitch = (+get('--pitch', 12)) * Math.PI / 180;
const cy = Math.cos(yaw), sy = Math.sin(yaw);
const cp = Math.cos(pitch), sp = Math.sin(pitch);
const dist = Math.max(height * 1.45, rmax * 4.2) * 1.25;
const cx = 0, cyy = 0, cz = height / 2;
const focal = H * 0.95;

function project(x, y, z) {
  const dx = x - cx, dy = y - cyy, dz = z - cz;
  const x1 = dx * cy - dy * sy;
  const y1 = dx * sy + dy * cy;
  const y2 = y1 * cp - dz * sp;
  const z2 = y1 * sp + dz * cp;
  const d = dist - z2;
  if (d <= 1) return null;
  const s = focal / d;
  return [W / 2 + x1 * s, H / 2 - y2 * s * 1.0, d];
}

const zbuf = new Float32Array(W * H).fill(1e9);
function px(x, y, d, r, g, b) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  if (d > zbuf[i]) return;
  zbuf[i] = d;
  const o = i * 3;
  buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
}

function line(ax, ay, ad, bx, by, bd, col) {
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const d = ad + (bd - ad) * t;
    px(ax + (bx - ax) * t, ay + (by - ay) * t, d, col[0], col[1], col[2]);
  }
}

const step = Math.max(1, Math.ceil(n / cap));
let prev = null;
for (let k = 0; k < n; k += step) {
  const q = project(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]);
  if (prev && q) {
    const t = pts[k * 3 + 2] / height;             // colour climbs the build
    const depth = 1 - Math.min(1, (q[2] - (dist - rmax * 2)) / (rmax * 4));
    const shade = 0.55 + 0.45 * Math.max(0, Math.min(1, depth));
    const r = Math.round((70 + 185 * t) * shade);
    const g = Math.round((226 - 40 * t) * shade);
    const b = Math.round((196 - 70 * t) * shade);
    line(prev[0], prev[1], prev[2], q[0], q[1], q[2], [r, g, b]);
  }
  prev = q;
}

/* ------------------------------------------------------------------ png */
function crcTable() {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

writePng(out, W, H, buf);

/* how much of the frame is actually bead? (a blank render is a bug) */
let drawn = 0;
for (let i = 0; i < W * H; i++) if (zbuf[i] < 1e8) drawn++;
console.log(`coverage ${(100 * drawn / (W * H)).toFixed(2)}% of the frame`);
console.log(`wrote ${out}  (${W}x${H})`);
