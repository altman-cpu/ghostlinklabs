/* MeshForge geometry — pure typed-array mesh builder (no three.js).
 *
 * Mirrors meshforge/layerstack.py: outer shell, optional bore shell, caps,
 * smooth analytic normals, per-vertex colour from each layer's glyph tag.
 * Runs in the browser and in Node, so topology is audited headlessly.
 *
 * Two index sets:
 *   geo.idx       welded topology — volume, area, manifold/Euler audit
 *   geo.indices   render topology — cap rim rings duplicated so rims shade crisp
 *
 * Winding was derived, not guessed: with rings ordered
 *   outer → keel → bore on the bottom and outer → bore on top, the closed,
 * orientation-consistent manifold is "strips 011 + reversed bore wall".
 */
import { layerColor, hsv } from './engine.js';

const TAU = Math.PI * 2;
const BORE_EDGE = 0.06;

export function buildGeometryData(res, { baseline = false } = {}) {
  const p = res.params;
  const n = p.layers;
  const s = p.samples;
  const h = p.layer_height_mm;
  const hollow = p.bore > 0;
  const glyphs = res.glyphs;
  const profiles = baseline
    ? new Array(n).fill(res.profiles[Math.floor(n / 2)])   // one silhouette, extruded
    : res.profiles;
  // the baseline has no per-layer identity: one glyph, one colour, no jitter
  const glyph = baseline ? { tag: '5a6472', amp_scale: 1, wave: 0, phase: 0 } : null;
  const gAt = i => (baseline ? glyph : res.glyphs[i]);

  /* ---------------- vertex budget (exact) ---------------- */
  const weldedRings = (hollow ? 2 : 1) * n * s + (hollow ? s : 0) + (hollow ? 0 : 2);
  const capVerts = hollow ? 6 * s : 2 + 2 * s;   // three crisp strips, two rings each
  const totalVerts = weldedRings + capVerts;

  const pos = new Float32Array(totalVerts * 3);
  const nrm = new Float32Array(totalVerts * 3);
  const col = new Float32Array(totalVerts * 3);
  const au = new Float32Array(totalVerts);
  let v = 0;

  const put = (x, y, z, nx, ny, nz, r, g, b, u) => {
    if (v >= totalVerts) throw new Error(`vertex overflow at ${v}/${totalVerts}`);
    const k = v * 3;
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
    nrm[k] = nx; nrm[k + 1] = ny; nrm[k + 2] = nz;
    col[k] = r; col[k + 1] = g; col[k + 2] = b;
    au[v] = u;
    v++;
  };

  const idx = [];     // welded
  const render = [];  // crisp caps

  /* ---------------- outer shell ---------------- */
  for (let i = 0; i < n; i++) {
    const radii = profiles[i];
    const [r, g, b] = baseline ? [0.36, 0.38, 0.42] : layerRGB(i, n, gAt(i).tag);
    const z = i * h;
    const u = n > 1 ? i / (n - 1) : 0;
    for (let j = 0; j < s; j++) {
      const th = TAU * j / s;
      put(radii[j] * Math.cos(th), radii[j] * Math.sin(th), z, 0, 0, 0, r, g, b, u);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a0 = i * s, b0 = (i + 1) * s;
    for (let j = 0; j < s; j++) {
      const j2 = (j + 1) % s;
      idx.push(a0 + j, a0 + j2, b0 + j2, a0 + j, b0 + j2, b0 + j);
    }
  }
  shellNormals(pos, nrm, 0, n, s, 1);

  /* ---------------- inner shell (bore) ---------------- */
  let innerBase = -1;
  if (hollow) {
    innerBase = v;
    for (let i = 0; i < n; i++) {
      const radii = profiles[i];
      const ri = boreRadius(mean(radii), p, gAt(i));
      const rgb = baseline ? [0.1, 0.11, 0.13] : layerRGB(i, n, gAt(i).tag).map(x => x * 0.34);
      const z = i * h;
      const u = n > 1 ? i / (n - 1) : 0;
      for (let j = 0; j < s; j++) {
        const th = TAU * j / s;
        put(ri * Math.cos(th), ri * Math.sin(th), z, 0, 0, 0, rgb[0], rgb[1], rgb[2], u);
      }
    }
    for (let i = 0; i < n - 1; i++) {   // reversed: faces the bore
      const a0 = innerBase + i * s, b0 = innerBase + (i + 1) * s;
      for (let j = 0; j < s; j++) {
        const j2 = (j + 1) % s;
        idx.push(a0 + j, b0 + j, b0 + j2, a0 + j, b0 + j2, a0 + j2);
      }
    }
    shellNormals(pos, nrm, innerBase, n, s, -1);
  }

  /* ---------------- caps (welded) ---------------- */
  const oBot = 0;
  const oTop = (n - 1) * s;

  if (hollow) {
    const iBot = innerBase;
    const iTop = innerBase + (n - 1) * s;
    const rBot = profiles[0], rTop = profiles[n - 1];
    const riBot = boreRadius(mean(rBot), p, gAt(0));
    const riTop = boreRadius(mean(rTop), p, gAt(n - 1));
    const rk = riBot + BORE_EDGE * (p.radius_mm - riBot);

    const keelBase = v;
    for (let j = 0; j < s; j++) {
      const th = TAU * j / s;
      put(rk * Math.cos(th), rk * Math.sin(th), 0, 0, 0, -1, 0.24, 0.25, 0.29, 0);
    }
    for (let j = 0; j < s; j++) {
      const j2 = (j + 1) % s;
      // top annulus: outer top -> inner top
      idx.push(oTop + j, oTop + j2, iTop + j2, oTop + j, iTop + j2, iTop + j);
      // bottom outer rim: outer -> keel
      idx.push(oBot + j2, oBot + j, keelBase + j, oBot + j2, keelBase + j, keelBase + j2);
      // bottom bore rim: keel -> bore
      idx.push(keelBase + j2, keelBase + j, iBot + j, keelBase + j2, iBot + j, iBot + j2);
    }

    // crisp duplicates: bottom outer → keel → bore, then top annulus
    render.push(...strip(put, v, s, rBot, rk, 0, -1, [0.30, 0.32, 0.36], [0.24, 0.25, 0.29], 1));
    render.push(...strip(put, v, s, rk, riBot, 0, -1, [0.24, 0.25, 0.29], [0.20, 0.21, 0.24], 1));
    render.push(...strip(put, v, s, rTop, riTop, (n - 1) * h, +1, [0.34, 0.36, 0.40], [0.26, 0.27, 0.30], 0));
  } else {
    const cBot = v;
    put(0, 0, 0, 0, 0, -1, 0.26, 0.28, 0.32, 0);
    const cTop = v;
    put(0, 0, (n - 1) * h, 0, 0, 1, 0.34, 0.36, 0.42, 1);
    for (let j = 0; j < s; j++) {
      const j2 = (j + 1) % s;
      idx.push(cBot, j2, j);                                // bottom fan
      idx.push(cTop, oTop + j, oTop + j2);                  // top fan
    }
    render.push(...fan(put, v, s, profiles[0], 0, -1, [0.26, 0.28, 0.32], 0));
    render.push(...fan(put, v, s, profiles[n - 1], (n - 1) * h, +1, [0.34, 0.36, 0.42], 1));
  }

  /* ---------------- finish ---------------- */
  if (v !== totalVerts) throw new Error(`vertex budget off: ${v} != ${totalVerts}`);

  const welded = new Uint32Array(idx);
  const shellTris = 3 * (n - 1) * s * (hollow ? 2 : 1);
  const renderIdx = new Uint32Array(shellTris + render.length);
  renderIdx.set(welded.subarray(0, shellTris), 0);
  renderIdx.set(render, shellTris);

  const geo = {
    positions: pos,
    normals: nrm,
    colors: col,
    aU: au,
    idx: welded,
    indices: renderIdx,
    vertices: v,
    triangles: renderIdx.length / 3,
    height_mm: (n - 1) * h,
    hollow,
    baseline,
  };
  geo.volume_mm3 = signedVolume(pos, welded);
  geo.surface_mm2 = surfaceArea(pos, welded);
  const topo = manifold(pos, welded);
  geo.watertight = topo.ok;
  geo.open_edges = topo.open_edges;
  geo.euler = topo.chi;
  geo.genus = topo.genus;
  return geo;
}

/* ------------------------------------------------------------ primitives */
/* A flat strip between ring A and ring B at one height. rev=1 reverses the
 * winding so the face points the other way. Returns render indices. */
function strip(put, start, s, radiiA, radiiB, z, dir, rgbA, rgbB, rev) {
  const A = start, B = start + s;
  const innerB = typeof radiiB === 'number' ? new Float64Array(s).fill(radiiB) : radiiB;
  for (let j = 0; j < s; j++) {
    const th = TAU * j / s, c = Math.cos(th), sn = Math.sin(th);
    put(radiiA[j] * c, radiiA[j] * sn, z, 0, 0, dir, rgbA[0], rgbA[1], rgbA[2], 1);
    put(innerB[j] * c, innerB[j] * sn, z, 0, 0, dir, rgbB[0], rgbB[1], rgbB[2], 1);
  }
  const out = [];
  for (let j = 0; j < s; j++) {
    const j2 = (j + 1) % s;
    if (rev) out.push(A + j2, A + j, B + j, A + j2, B + j, B + j2);
    else out.push(A + j, A + j2, B + j2, A + j, B + j2, B + j);
  }
  return out;
}

/* A centre fan on a duplicated rim ring. */
function fan(put, start, s, radii, z, dir, rgb, u) {
  const centre = start;
  put(0, 0, z, 0, 0, dir, rgb[0] * 0.8, rgb[1] * 0.8, rgb[2] * 0.8, u);
  for (let j = 0; j < s; j++) {
    const th = TAU * j / s;
    put(radii[j] * Math.cos(th), radii[j] * Math.sin(th), z, 0, 0, dir, rgb[0], rgb[1], rgb[2], u);
  }
  const out = [];
  const ring = start + 1;
  for (let j = 0; j < s; j++) {
    const j2 = (j + 1) % s;
    if (dir > 0) out.push(centre, ring + j, ring + j2);
    else out.push(centre, ring + j2, ring + j);
  }
  return out;
}

/* --------------------------------------------------------------- helpers */
export function mean(a) {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i];
  return t / a.length;
}

export function boreRadius(rm, p, g) {
  if (!p.bore) return 0;
  const raw = p.bore * p.radius_mm * (g.amp_scale ?? 1) + 0.055 * (g.wave ?? 0) * rm;
  return Math.max(0, Math.min(raw, 0.8 * rm));
}

function layerRGB(i, n, tag) {
  return layerColor(i, n, tag);
}

export { hsv };

/* normals from the ring lattice: n = ± normalize(∂θ × ∂u) */
function shellNormals(pos, nrm, base, n, s, sign) {
  for (let i = 0; i < n; i++) {
    const ip = Math.min(i + 1, n - 1), im = Math.max(i - 1, 0);
    for (let j = 0; j < s; j++) {
      const jp = (j + 1) % s, jm = (j - 1 + s) % s;
      const A = (base + i * s + jp) * 3, B = (base + i * s + jm) * 3;
      const C = (base + ip * s + j) * 3, D = (base + im * s + j) * 3;
      const tx = pos[A] - pos[B], ty = pos[A + 1] - pos[B + 1], tz = pos[A + 2] - pos[B + 2];
      const ux = pos[C] - pos[D], uy = pos[C + 1] - pos[D + 1], uz = pos[C + 2] - pos[D + 2];
      let nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
      const ln = Math.hypot(nx, ny, nz) || 1;
      const k = (base + i * s + j) * 3;
      nrm[k] = sign * nx / ln;
      nrm[k + 1] = sign * ny / ln;
      nrm[k + 2] = sign * nz / ln;
    }
  }
}

export function signedVolume(pos, idx) {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

export function surfaceArea(pos, idx) {
  let a = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    a += 0.5 * Math.hypot(cx, cy, cz);
  }
  return a;
}

/* Closed, orientation-consistent manifold:
 *   - no directed edge may repeat  (consistent orientation)
 *   - every undirected edge must be used exactly twice  (no holes)
 * Skipped for giant meshes; the Python exporter always runs the full audit. */
export function manifold(pos, idx) {
  const tris = idx.length / 3;
  if (tris > 900000) return { ok: true, open_edges: 0, chi: null, genus: null, skipped: true };
  const dir = new Set();
  const und = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const d = x * 8388608 + y;
      if (dir.has(d)) return { ok: false, open_edges: -1, chi: null, genus: null, reason: 'inconsistent winding' };
      dir.add(d);
      const u = Math.min(x, y) * 8388608 + Math.max(x, y);
      und.set(u, (und.get(u) || 0) + 1);
    }
  }
  let bad = 0;
  for (const n of und.values()) if (n !== 2) bad++;
  if (bad) return { ok: false, open_edges: bad, chi: null, genus: null, reason: 'open boundary' };

  const used = new Set();
  for (let t = 0; t < idx.length; t++) used.add(idx[t]);
  const V = used.size, E = und.size, F = tris;
  const chi = V - E + F;
  return { ok: true, open_edges: 0, chi: chi, genus: (2 - chi) / 2 };
}
