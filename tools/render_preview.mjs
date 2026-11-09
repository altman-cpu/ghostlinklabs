#!/usr/bin/env node
/* Software-rasterised preview of a forged stack — no browser required.
 *
 *   node tools/render_preview.mjs "<prompt>" out.png [--layers N] [--samples N]
 *                                 [--w 900] [--h 1200] [--yaw .62] [--pitch .16]
 *
 * Z-buffered, smooth-normal shading with per-layer vertex colour, a key light,
 * a cool fill, a rim light, specular and a contact shadow. The mesh is built
 * by the same engine the web forge uses, so what you see is what you download.
 */
import { generate, parsePrompt, describe } from '../meshforge/web/engine.js';
import { buildGeometryData } from '../meshforge/web/geometry.js';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[0] || 'Helix, 3-fold twist, hollow';
const out = args[1] || 'preview.png';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };

const W = opt('w', 900), H = opt('h', 1200);
const params = parsePrompt(prompt);
params.layers = opt('layers', 1000);
params.samples = opt('samples', 160);
const yaw = opt('yaw', 0.7), pitch = opt('pitch', 0.16);

const res = await generate(params);
const geo = buildGeometryData(res);
const P = geo.positions, N = geo.normals, C = geo.colors, I = geo.idx;
console.log(`${describe(res.params)}\n${geo.triangles} tris · watertight=${geo.watertight} `
  + `genus=${geo.genus} · audit ${res.audit.unique}/${res.params.layers} unique, `
  + `${res.audit.congruent_pairs} congruent`);

/* ---------------------------------------------------------------- camera */
const target = [0, 0, geo.height_mm / 2];
const camDir = norm([Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)]);
const fov = 34 * Math.PI / 180;
const halfH = geo.height_mm / 2;
const maxR = params.radius_mm * 1.55;
const distV = halfH / Math.tan(fov / 2);
const distH = maxR / Math.tan(fov / 2) / (W / H);
const dist = Math.max(distV, distH) * 1.28;
const eye = [target[0] + camDir[0] * dist, target[1] + camDir[1] * dist, target[2] + camDir[2] * dist];

const fwd = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
const right = norm(cross(fwd, [0, 0, 1]));
const up = cross(right, fwd);
const focal = (H / 2) / Math.tan(fov / 2);

/* ------------------------------------------------------------- rasterise */
const px = new Float32Array(W * H * 3);
for (let y = 0; y < H; y++) {
  const t = y / H;
  const r = 0.052 + 0.03 * (1 - t) ** 2;
  for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 3;
    const vig = 1 - 0.55 * (((x / W - 0.5) ** 2) + ((y / H - 0.5) ** 2)) * 1.6;
    px[k] = r * 0.9 * vig; px[k + 1] = r * 1.02 * vig; px[k + 2] = r * 1.28 * vig;
  }
}
const zb = new Float32Array(W * H).fill(Infinity);

const verts = P.length / 3;
const sx = new Float32Array(verts), sy = new Float32Array(verts), vz = new Float32Array(verts);
const vnx = new Float32Array(verts), vny = new Float32Array(verts), vnz = new Float32Array(verts);
for (let v = 0; v < verts; v++) {
  const dx = P[v * 3] - eye[0], dy = P[v * 3 + 1] - eye[1], dz = P[v * 3 + 2] - eye[2];
  const x = dx * right[0] + dy * right[1] + dz * right[2];
  const yy = dx * up[0] + dy * up[1] + dz * up[2];
  const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
  vz[v] = z;
  sx[v] = z > 0.01 ? W / 2 + (x / z) * focal : -1e6;
  sy[v] = z > 0.01 ? H / 2 - (yy / z) * focal : -1e6;
  vnx[v] = N[v * 3]; vny[v] = N[v * 3 + 1]; vnz[v] = N[v * 3 + 2];
}

const Lkey = norm([0.52, 0.42, 0.74]);
const Lfill = norm([-0.85, 0.15, 0.28]);
const Lrim = norm([-0.2, -0.9, 0.35]);

for (let t = 0; t < I.length; t += 3) {
  const a = I[t], b = I[t + 1], c = I[t + 2];
  if (vz[a] < 0.01 || vz[b] < 0.01 || vz[c] < 0.01) continue;
  const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[c], y2 = sy[c];
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) continue;
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) continue;
  const inv = 1 / area;

  for (let y = minY; y <= maxY; y++) {
    const pyy = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const pxx = x + 0.5;
      const w0 = ((x1 - pxx) * (y2 - pyy) - (x2 - pxx) * (y1 - pyy)) * inv;
      const w1 = ((x2 - pxx) * (y0 - pyy) - (x0 - pxx) * (y2 - pyy)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      // perspective-correct depth
      const iz = w0 / vz[a] + w1 / vz[b] + w2 / vz[c];
      const z = 1 / iz;
      const k = y * W + x;
      if (z >= zb[k]) continue;
      zb[k] = z;

      // interpolated normal + colour
      let nx = (w0 * vnx[a] / vz[a] + w1 * vnx[b] / vz[b] + w2 * vnx[c] / vz[c]) * z;
      let ny = (w0 * vny[a] / vz[a] + w1 * vny[b] / vz[b] + w2 * vny[c] / vz[c]) * z;
      let nz = (w0 * vnz[a] / vz[a] + w1 * vnz[b] / vz[b] + w2 * vnz[c] / vz[c]) * z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      const cr = (w0 * C[a * 3] + w1 * C[b * 3] + w2 * C[c * 3]);
      const cg = (w0 * C[a * 3 + 1] + w1 * C[b * 3 + 1] + w2 * C[c * 3 + 1]);
      const cb = (w0 * C[a * 3 + 2] + w1 * C[b * 3 + 2] + w2 * C[c * 3 + 2]);

      const dKey = Math.max(0, nx * Lkey[0] + ny * Lkey[1] + nz * Lkey[2]);
      const dFill = Math.max(0, nx * Lfill[0] + ny * Lfill[1] + nz * Lfill[2]);
      const dRim = Math.max(0, nx * Lrim[0] + ny * Lrim[1] + nz * Lrim[2]);
      // view vector (surface -> eye), approx straight back along fwd
      const hvx = Lkey[0] - fwd[0], hvy = Lkey[1] - fwd[1], hvz = Lkey[2] - fwd[2];
      const hl = Math.hypot(hvx, hvy, hvz) || 1;
      const spec = Math.pow(Math.max(0, (nx * hvx + ny * hvy + nz * hvz) / hl), 42);

      const amb = 0.13 + 0.1 * Math.max(0, nz);
      const key = 1.02 * dKey;
      const fillC = 0.34 * dFill;
      const rimC = 0.5 * Math.pow(dRim, 1.6) * Math.pow(1 - Math.abs(nx * fwd[0] + ny * fwd[1] + nz * fwd[2]), 3);

      const shade = amb + key;
      const o = k * 3;
      px[o] = cr * shade + fillC * 0.42 + rimC * 0.55 + spec * 0.85;
      px[o + 1] = cg * shade + fillC * 0.72 + rimC * 0.95 + spec * 0.92;
      px[o + 2] = cb * shade + fillC * 1.0 + rimC * 0.82 + spec * 0.88;
    }
  }
}

/* contact shadow under the model */
const baseZ = 0;
{
  const bx = baseZ; void bx;
  const cx0 = 0, cy0 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (zb[k] < Infinity) continue;
      const dx = (x - W / 2) / focal, dy = (y - H / 2) / focal;
      const wx = eye[0] + fwd[0] * dist + (right[0] * dx - up[0] * dy) * dist;
      const wy = eye[1] + fwd[1] * dist + (right[1] * dx - up[1] * dy) * dist;
      const d = Math.hypot(wx - cx0, wy - cy0) / (params.radius_mm * 2.2);
      if (d < 1) {
        const a = (1 - d) ** 2 * 0.5;
        const o = k * 3;
        px[o] *= 1 - a; px[o + 1] *= 1 - a; px[o + 2] *= 1 - a;
      }
    }
  }
}

/* ------------------------------------------------------------------- PNG */
const raw = Buffer.alloc((W * 3 + 1) * H);
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0;
  for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 3;
    for (let ch = 0; ch < 3; ch++) {
      const v = Math.min(1, Math.pow(Math.max(0, px[k + ch]), 1 / 2.2));
      raw[p++] = Math.round(v * 255);
    }
  }
}
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote ${out}`);

function norm(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
