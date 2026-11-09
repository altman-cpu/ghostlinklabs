/**
 * PathForge (browser) — the JS half of the OLVR path module.
 *
 * A faithful port of pathforge/core.py: same spiral, same audit, same control.
 * It turns a forged result into one continuous bead and proves the bead is
 * unbroken. Pure math — no three.js, so it can be tested head-less.
 */
import { boreRadius } from './engine.js';

export const SEAM_EPS_MM = 1.5;

export function defaultPathParams() {
  return {
    nozzle_mm: 0.4,
    width_mm: 0.45,
    layer_height_mm: 0.0,     // 0 -> inherit the mesh layer height
    filament_mm: 1.75,
    feedrate_mm_min: 900,
    travel_feedrate_mm_min: 3000,
    density_g_cm3: 1.24,
    turns_per_layer: 1.0,
    seam_eps_mm: SEAM_EPS_MM,
    z_hop_mm: 0.4,
    hotend_c: 205,
    bed_c: 60,
    fan_percent: 100,
    retract_mm: 2.0,
  };
}

const clamp = (v, lo, hi) => {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
};

export function clampPathParams(pp = {}) {
  const c = { ...defaultPathParams(), ...pp };
  c.nozzle_mm = clamp(c.nozzle_mm, 0.1, 1.2);
  c.width_mm = clamp(c.width_mm, c.nozzle_mm * 0.8, c.nozzle_mm * 3.0);
  c.layer_height_mm = c.layer_height_mm ? clamp(c.layer_height_mm, 0.02, 1.2) : 0;
  c.filament_mm = c.filament_mm < 2.0 ? 1.75 : 2.85;
  c.feedrate_mm_min = clamp(c.feedrate_mm_min, 60, 6000);
  c.travel_feedrate_mm_min = clamp(c.travel_feedrate_mm_min, 60, 12000);
  c.density_g_cm3 = clamp(c.density_g_cm3, 0.8, 2.0);
  c.turns_per_layer = clamp(c.turns_per_layer, 0.25, 4.0);
  c.seam_eps_mm = clamp(c.seam_eps_mm, 0.05, 50);
  c.z_hop_mm = clamp(c.z_hop_mm, 0, 5);
  c.hotend_c = Math.round(clamp(c.hotend_c, 150, 320));
  c.bed_c = Math.round(clamp(c.bed_c, 0, 130));
  c.fan_percent = Math.round(clamp(c.fan_percent, 0, 100));
  c.retract_mm = clamp(c.retract_mm, 0, 10);
  return c;
}

/** Ring-to-ring spacing: the surface spans layers * layer_height. */
export function pitchOf(res) {
  const p = res.params;
  const height = res.height_mm || p.height_mm || p.layers * p.layer_height_mm;
  return height / Math.max(p.layers - 1, 1);
}

function wallRadii(res) {
  const p = res.params;
  const out = [];
  for (let i = 0; i < res.profiles.length; i++) {
    const radii = res.profiles[i];
    let rm = 0;
    for (let j = 0; j < radii.length; j++) rm += radii[j];
    rm /= radii.length;
    const g = res.glyphs[i];
    out.push([radii, g ? boreRadius(rm, p, g) : 0]);
  }
  return out;
}

export function auditPath(points, extruding, { layers, pitch, pp }) {
  const n = points.length / 3;
  if (n < 2) {
    return { points: n, pass: false, match: { rule: 'continuous bead', pass: false } };
  }
  const seps = new Float64Array(n - 1);
  let total = 0;
  for (let k = 0; k < n - 1; k++) {
    const dx = points[(k + 1) * 3] - points[k * 3];
    const dy = points[(k + 1) * 3 + 1] - points[k * 3 + 1];
    const dz = points[(k + 1) * 3 + 2] - points[k * 3 + 2];
    seps[k] = Math.hypot(dx, dy, dz);
    total += seps[k];
  }
  const mean = total / (n - 1);
  const eps = Math.max(pp.seam_eps_mm, 6 * mean);
  let seams = 0;
  for (let k = 0; k < n - 1; k++) {
    if (!extruding[k + 1] || seps[k] > eps) seams++;
  }
  let travel = 0;
  for (let k = 0; k < n; k++) if (!extruding[k]) travel++;

  let monotone = true;
  for (let k = 0; k < n - 1; k++) {
    if (points[(k + 1) * 3 + 2] < points[k * 3 + 2] - 1e-9) { monotone = false; break; }
  }

  // angular travel, unwrapped
  let ang = 0;
  let prev = Math.atan2(points[1], points[0]);
  for (let k = 1; k < n; k++) {
    const a = Math.atan2(points[k * 3 + 1], points[k * 3]);
    let d = a - prev;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    ang += d;
    prev = a;
  }
  const turns = Math.abs(ang) / (Math.PI * 2);
  const bands = new Set();
  for (let k = 0; k < n; k++) bands.add(Math.floor(points[k * 3 + 2] / pitch + 1e-9));

  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < n - 1; k++) { mn = Math.min(mn, seps[k]); mx = Math.max(mx, seps[k]); }

  const passed = seams === 0 && travel === 0 && monotone && bands.size >= layers * 0.99;
  return {
    points: n,
    seams,
    travel_moves: travel,
    continuous: seams === 0,
    monotonic_z: monotone,
    layers_traversed: bands.size,
    turns: +turns.toFixed(3),
    turns_per_layer: +(turns / Math.max(layers, 1)).toFixed(4),
    z_span_mm: +((points[(n - 1) * 3 + 2] - points[2])).toFixed(4),
    step_min_mm: +mn.toFixed(5),
    step_mean_mm: +mean.toFixed(5),
    step_max_mm: +mx.toFixed(5),
    seam_eps_mm: pp.seam_eps_mm,
    seam_threshold_mm: +eps.toFixed(4),
    pass: passed,
    match: { rule: 'one continuous bead, all layers, no travel', pass: passed },
    baseline: 'closed ring per layer with a travel move between rings',
  };
}

function finish(points, extruding, layerOf, res, pp, control) {
  const p = res.params;
  const pitch = pitchOf(res);
  const audit = auditPath(points, extruding, { layers: p.layers, pitch, pp });
  audit.control = control;
  const lh = pp.layer_height_mm || p.layer_height_mm;
  const length = audit.step_mean_mm * Math.max(audit.points - 1, 0);
  const volume = length * pp.width_mm * lh;
  const area = Math.PI * (pp.filament_mm / 2) ** 2;
  const filament = volume / area;
  let rmin = Infinity, rmax = -Infinity;
  for (let k = 0; k < points.length; k += 3) {
    const r = Math.hypot(points[k], points[k + 1]);
    if (r < rmin) rmin = r;
    if (r > rmax) rmax = r;
  }
  const stats = {
    family: (res.stats && res.stats.family) || p.family || 'mesh',
    layers: p.layers,
    samples: p.samples,
    points: audit.points,
    path_length_mm: +length.toFixed(2),
    path_length_m: +(length / 1000).toFixed(3),
    bead_width_mm: pp.width_mm,
    bead_height_mm: +lh.toFixed(4),
    extruded_volume_cm3: +(volume / 1000).toFixed(3),
    filament_m: +(filament / 1000).toFixed(2),
    filament_mm: +filament.toFixed(2),
    grams: +((volume / 1000) * pp.density_g_cm3).toFixed(2),
    feedrate_mm_min: pp.feedrate_mm_min,
    est_minutes: +(length / pp.feedrate_mm_min).toFixed(1),
    radius_min_mm: +rmin.toFixed(3),
    radius_max_mm: +rmax.toFixed(3),
    height_mm: +(res.height_mm || p.layers * p.layer_height_mm).toFixed(3),
  };
  let h = 2166136261;
  for (let k = 0; k < points.length; k += 3 * 97) {
    h ^= Math.round(points[k] * 1000) | 0;
    h = (h * 16777619) >>> 0;
    h ^= Math.round(points[k + 2] * 10000) | 0;
    h = (h * 16777619) >>> 0;
  }
  return {
    params: pp, points, extruding, layerOf, audit, stats,
    digest: (h >>> 0).toString(16).padStart(8, '0') + points.length.toString(16),
    pitch,
  };
}

/** One continuous bead: the nozzle never lifts, never travels, never backs up. */
export function spiralPath(res, pp = defaultPathParams()) {
  const q = clampPathParams(pp);
  const p = res.params;
  const n = p.layers, s = p.samples;
  const pitch = pitchOf(res);
  const walls = wallRadii(res);
  const points = new Float32Array(n * s * 3);
  const extruding = new Uint8Array(n * s).fill(1);
  const layerOf = new Int32Array(n * s);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const [radii, ri] = walls[i];
    for (let j = 0; j < s; j++, k++) {
      const th = Math.PI * 2 * (i + j / s) * q.turns_per_layer;
      const ro = radii[j];
      const r = ri > 0 ? (ro + ri) / 2 : ro;
      points[k * 3] = r * Math.cos(th);
      points[k * 3 + 1] = r * Math.sin(th);
      points[k * 3 + 2] = (i + j / s) * pitch;
      layerOf[k] = i;
    }
  }
  return finish(points, extruding, layerOf, res, q, layeredPayload(res, q));
}

/**
 * The control: closed ring per layer, travel between rings. The audit must
 * reject this — an audit that can never fail proves nothing.
 */
export function layeredPath(res, pp = defaultPathParams()) {
  const q = clampPathParams(pp);
  const p = res.params;
  const n = p.layers, s = p.samples;
  const pitch = pitchOf(res);
  const walls = wallRadii(res);
  const total = n * (s + 2) - 1;
  const points = new Float32Array(total * 3);
  const extruding = new Uint8Array(total);
  const layerOf = new Int32Array(total);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const [radii, ri] = walls[i];
    for (let j = 0; j <= s; j++, k++) {
      const jj = j % s;
      const th = Math.PI * 2 * jj / s;
      const ro = radii[jj];
      const r = ri > 0 ? (ro + ri) / 2 : ro;
      points[k * 3] = r * Math.cos(th);
      points[k * 3 + 1] = r * Math.sin(th);
      points[k * 3 + 2] = i * pitch;
      extruding[k] = j === 0 ? 0 : 1;         // arrive dry, then extrude
      layerOf[k] = i;
    }
    if (i < n - 1) {                           // travel: lift to the next ring
      points[k * 3] = points[(k - 1) * 3];
      points[k * 3 + 1] = points[(k - 1) * 3 + 1];
      points[k * 3 + 2] = (i + 1) * pitch + q.z_hop_mm;
      extruding[k] = 0;
      layerOf[k] = i + 1;
      k++;
    }
  }
  return finish(points.slice(0, k * 3), extruding.slice(0, k), layerOf.slice(0, k),
                res, q, null);
}

function layeredPayload(res, q) {
  const c = layeredPath(res, q);
  return {
    points: c.audit.points,
    seams: c.audit.seams,
    travel_moves: c.audit.travel_moves,
    continuous: c.audit.continuous,
    monotonic_z: c.audit.monotonic_z,
    pass: c.audit.pass,
    note: 'the same build sliced ring-by-ring; the audit must reject it',
  };
}

/** Cumulative filament (mm) at every point — sampled, never recomputed. */
export function filamentCurve(path) {
  const pp = path.params;
  const lh = pp.layer_height_mm || path.stats.bead_height_mm;
  const area = Math.PI * (pp.filament_mm / 2) ** 2;
  const n = path.points.length / 3;
  const cum = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    const dx = path.points[k * 3] - path.points[(k - 1) * 3];
    const dy = path.points[k * 3 + 1] - path.points[(k - 1) * 3 + 1];
    const dz = path.points[k * 3 + 2] - path.points[(k - 1) * 3 + 2];
    cum[k] = cum[k - 1] + Math.hypot(dx, dy, dz) * pp.width_mm * lh / area;
  }
  return cum;
}

/* Python writes True/False; the JS port must print the same file. */
const B = (b) => (b ? 'True' : 'False');

export function gcodeText(path, res, { decimate = 1 } = {}) {
  const pp = path.params;
  const a = path.audit, st = path.stats;
  const pts = path.points;
  const n = pts.length / 3;
  const cum = filamentCurve(path);
  const step = Math.max(1, decimate | 0);
  const idx = [];
  for (let k = 0; k < n; k += step) idx.push(k);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const top = pts[(n - 1) * 3 + 2];

  const out = [];
  const add = (s) => out.push(s);
  add('; OLVR PathForge 1.0 — spiral toolpath');
  add('; rule: always match the differentiate');
  add(`; source: MeshForge ${st.family} ${st.layers}L x ${st.samples}P`
    + (res && res.gid ? ` gid ${String(res.gid).slice(0, 12)}` : ''));
  add(`; path digest: ${path.digest}`);
  add(`; audit: continuous=${B(a.continuous)} seams=${a.seams} travel_moves=${a.travel_moves}`
    + ` monotonic_z=${B(a.monotonic_z)} layers=${a.layers_traversed}/${st.layers}`
    + ` turns=${a.turns} pass=${B(a.pass)}`);
  if (a.control) {
    add(`; control (ring-per-layer): continuous=${B(a.control.continuous)}`
      + ` seams=${a.control.seams} travel_moves=${a.control.travel_moves}`
      + ` pass=${B(a.control.pass)}`);
  }
  add(`; stats: ${st.path_length_m} m of bead, ${st.filament_m} m filament,`
    + ` ${st.grams} g, ~${st.est_minutes} min at ${pp.feedrate_mm_min} mm/min`);
  add(`; bead: ${pp.width_mm.toFixed(2)} mm wide x ${st.bead_height_mm} mm high,`
    + ` nozzle ${pp.nozzle_mm.toFixed(2)} mm`);
  if (step > 1) add(`; decimated 1:${step} (${idx.length} of ${n} moves)`);
  add('G21 ; millimetres');
  add('G90 ; absolute positioning');
  add('M82 ; absolute extrusion');
  add('G92 E0 ; zero the extruder');
  add(`M104 S${pp.hotend_c} ; hotend`);
  add(`M140 S${pp.bed_c} ; bed`);
  add(`M109 S${pp.hotend_c} ; wait hotend`);
  add(`M190 S${pp.bed_c} ; wait bed`);
  add(pp.fan_percent ? `M106 S${Math.round(255 * pp.fan_percent / 100)} ; fan`
                     : 'M107 ; fan off');
  add(`G1 Z${(top + 5).toFixed(3)} F600 ; safe height`);
  add(`G1 X${pts[0].toFixed(3)} Y${pts[1].toFixed(3)}`
    + ` F${pp.travel_feedrate_mm_min} ; travel to start`);
  add(`G1 Z${pts[2].toFixed(3)} F600 ; descend`);
  add('; ---- spiral: one bead, no travel, no retract ----');
  add(`G1 F${pp.feedrate_mm_min}`);
  let prev = -1;
  for (let m = 1; m < idx.length; m++) {
    const k = idx[m];
    const lay = path.layerOf[k];
    if (lay !== prev && lay && lay % 100 === 0) {
      add(`; layer ${lay} of ${st.layers}  z=${pts[k * 3 + 2].toFixed(3)}`);
    }
    prev = lay;
    add(`G1 X${pts[k * 3].toFixed(3)} Y${pts[k * 3 + 1].toFixed(3)}`
      + ` Z${pts[k * 3 + 2].toFixed(4)} E${cum[k].toFixed(5)}`);
  }
  add('; ---- end ----');
  if (pp.retract_mm) add(`G1 E${(cum[idx[idx.length - 1]] - pp.retract_mm).toFixed(5)} F1800 ; retract`);
  add('M107 ; fan off');
  add(`G1 Z${(top + 10).toFixed(3)} F600 ; lift clear`);
  add('M84 ; motors off');
  return out.join('\n') + '\n';
}
