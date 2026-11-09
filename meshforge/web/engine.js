/* MeshForge engine — browser port of meshforge/fields.py + differentiator.py
 *
 * Same field families, same SHA-256 glyph identity, same derivative dressing
 * and the same congruence audit as the Python exporter. If a prompt forges
 * "1000 layers, 0 congruent" here, `meshforge export` proves it on disk.
 */
const TAU = Math.PI * 2;
const BORE_EDGE = 0.06;

/* ------------------------------------------------------------------ params */
export const FAMILIES = [
  { key: 'helix',    label: 'Helix',           hint: 'Triple-strand tower, rotating as it rises', lobes: 3, amplitude: 0.30, twist: 1.0, bore: 0.0 },
  { key: 'waves',    label: 'Geometric waves', hint: 'Standing waves with sharpened crests',      lobes: 3, amplitude: 0.26, twist: 0.8, bore: 0.0 },
  { key: 'spiral',   label: 'Spiral',          hint: 'Archimedean sweep, widening as it climbs',  lobes: 2, amplitude: 0.34, twist: 1.6, bore: 0.0 },
  { key: 'lattice',  label: 'Lattice',         hint: 'Six-fold gear with alternating notches',    lobes: 6, amplitude: 0.22, twist: 0.4, bore: 0.0 },
  { key: 'ghost',    label: 'Ghost',           hint: 'Teardrop with decaying echo lobes',         lobes: 5, amplitude: 0.28, twist: 0.7, bore: 0.0 },
  { key: 'vortex',   label: 'Vortex',          hint: 'Hollow fluted column with spiralling bore', lobes: 5, amplitude: 0.24, twist: 1.2, bore: 0.46 },
  { key: 'mountain', label: 'Mountain',        hint: 'Five-octave ridge crest, rising into peaks',lobes: 3, amplitude: 0.30, twist: 0.2, bore: 0.0 },
  { key: 'seed',     label: 'Seed',            hint: 'Golden-angle grains on a smooth shell',     lobes: 7, amplitude: 0.20, twist: 2.4, bore: 0.0 },
];

export const ALIASES = {
  helix: ['helix', 'helical', 'strand'], waves: ['wave', 'waves', 'geometric', 'ripple', 'ocean'],
  spiral: ['spiral', 'swirl', 'coil', 'sweep'], lattice: ['lattice', 'gear', 'cog', 'truss', 'grid'],
  ghost: ['ghost', 'haunt', 'teardrop', 'phantom'], vortex: ['vortex', 'flute', 'fluted', 'chimney'],
  mountain: ['mountain', 'ridge', 'peak', 'terrain', 'range'], seed: ['seed', 'phyllotaxis', 'grain', 'pod', 'fibonacci'],
};

export function defaultParams(family = 'helix') {
  const f = FAMILIES.find(x => x.key === family) || FAMILIES[0];
  return {
    family: f.key, layers: 1000, samples: 128, lobes: f.lobes, amplitude: f.amplitude,
    twist: f.twist, differentiation: 0.55, bore: f.bore, radius_mm: 30,
    layer_height_mm: 0.2, seed: 0,
  };
}

export function clampParams(p) {
  const c = { ...p };
  c.layers = Math.max(2, Math.min(2000, Math.round(c.layers)));
  c.samples = Math.max(24, Math.min(512, Math.round(c.samples)));
  c.lobes = Math.max(2, Math.min(24, Math.round(c.lobes)));
  c.amplitude = Math.max(0, Math.min(0.55, c.amplitude));
  c.twist = Math.max(-6, Math.min(6, c.twist));
  c.differentiation = Math.max(0, Math.min(1.6, c.differentiation));
  c.bore = Math.max(0, Math.min(0.72, c.bore));
  c.radius_mm = Math.max(4, Math.min(240, c.radius_mm));
  c.layer_height_mm = Math.max(0.02, Math.min(1.2, c.layer_height_mm));
  return c;
}

/* ------------------------------------------------------------------ fields */
const sat = x => Math.tanh(2.2 * x) / Math.tanh(2.2);

const OUTER = {
  helix(u, t, p) {
    const a = p.amplitude, k = p.lobes, phi = TAU * p.twist * u;
    const primary = Math.cos(k * (t + phi));
    const secondary = Math.cos(2 * k * (t - 0.5 * phi));
    const strand = sat(primary * 1.9) * 0.62 + primary * 0.38;   // separate flutes
    return 1 + a * (0.86 * strand + 0.14 * secondary) - 0.09 * a * Math.cos(phi * 2);
  },
  waves(u, t, p) {
    const a = p.amplitude, k = p.lobes + 1;
    const w1 = Math.cos(k * t + 3.1 * TAU * 0.12 * p.twist * u);
    const w2 = Math.cos((k + 3) * t - 2.2 * TAU * 0.12 * p.twist * u);
    const w3 = Math.cos((k + 6) * t + 1.3 * TAU * 0.05 * u);
    const base = 0.58 * w1 + 0.28 * w2 + 0.14 * w3;
    const crest = sat(base * 1.35) * 0.86 + base * 0.14;
    return 1 + a * crest;
  },
  spiral(u, t, p) {
    const k = p.lobes, phase = k * t + TAU * 1.6 * p.twist * u;
    const envelope = 0.62 + 0.38 * Math.pow(1 - u, 1.4);
    return 1 + p.amplitude * envelope * Math.sin(phase) - 0.05 * p.amplitude * u;
  },
  lattice(u, t, p) {
    const k = Math.max(p.lobes, 4), phase = k * t - TAU * 0.35 * p.twist * u;
    const tooth = sat(Math.sin(phase) * 2.4);
    const notch = 0.18 * Math.cos(2 * phase + 0.9);
    return 1 + p.amplitude * (0.82 * tooth + notch);
  },
  ghost(u, t, p) {
    const a = p.amplitude, k = p.lobes;
    const bell = 0.74 + 0.42 * Math.pow(Math.sin(Math.PI * Math.min(u * 1.06, 1)), 1.5)
      + 0.16 * Math.pow(1 - u, 2);
    let drape = sat(Math.cos(k * t + TAU * 1.25 * p.twist * u + 0.6) * 1.5) * 0.72;
    drape += 0.28 * Math.cos(2 * k * t - TAU * 0.9 * p.twist * u + 1.2);
    const echo = 0.5 * Math.cos(5 * t + 5 * u) * Math.exp(-1.6 * u);
    const lean = 1 + 0.13 * Math.cos(t - (0.7 + 1.5 * u));
    return (bell + a * 0.9 * drape * (0.55 + 0.45 * (1 - u)) + 0.3 * a * echo) * lean;
  },
  vortex(u, t, p) {
    const k = p.lobes;
    return 1 + p.amplitude * Math.cos(k * t - TAU * p.twist * u);
  },
  mountain(u, t, p) {
    const a = p.amplitude; let total = 0, amp = 1, k = p.lobes;
    for (let o = 0; o < 5; o++) {
      const ridge = 1 - Math.abs(Math.cos(k * t * 0.5 + 1.7 * o + u * (1.1 + 0.4 * o)));
      total += amp * Math.pow(ridge, 1.55);
      amp *= 0.55; k *= 1.85;
    }
    const swell = 0.58 + 0.42 * Math.pow(Math.sin(Math.PI * Math.min(u, 1)), 0.6);
    return 1 + a * 1.06 * (total - 0.55) * swell;
  },
  seed(u, t, p) {
    const golden = 0.6180339887498949;
    const grain = 0.5 + 0.5 * Math.cos(t * 18 + TAU * golden * 21 * u);
    const row = 0.5 + 0.5 * Math.cos(p.lobes * t + TAU * 2.4 * p.twist * u);
    const pod = 0.9 + 0.1 * Math.sin(Math.PI * Math.min(u * 1.1, 1));
    return pod + p.amplitude * 1.25 * (0.55 * row + 0.45 * grain - 0.45);
  },
};

const outerOf = (family, u, t, p) => (OUTER[family] || OUTER.helix)(u, t, p);

/* ------------------------------------------------------- glyph identity */
/* SHA-256("family|seed|index") -> 5 x u32 BE — mirrors differentiator.py */
async function shaWords(key, count = 5) {
  const bytes = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const view = new DataView(buf);
  const out = [];
  for (let i = 0; i < count; i++) out.push(view.getUint32(i * 4, false));
  return out;
}

export async function buildGlyphs(family, seed, total) {
  const glyphs = new Array(total);
  for (let i = 0; i < total; i++) {
    const w = await shaWords(`${family}|${seed}|${i}`, 5);
    const unit = 4294967296;
    const [a, b, c, d, e] = w.map(x => x / unit);
    let edge = 1;
    if (total > 2) { const t = i / (total - 1); edge = 0.35 + 0.65 * Math.sqrt(Math.sin(Math.PI * t)); }
    glyphs[i] = {
      index: i,
      tag: (w[0] & 0xFFFFFF).toString(16).padStart(6, '0'),
      phase: (a - 0.5) * 0.0022 * edge,
      twist_offset: (b - 0.5) * 0.055 * edge,
      amp_scale: 1 + (c - 0.5) * 0.13,
      drift: (d - 0.5) * 2,
      wave: (e - 0.5) * 2,
    };
  }
  return glyphs;
}

/* -------------------------------------------------------- layer profiles */
export function layerRadii(u, p, g) {
  const k = p.lobes, d = p.differentiation;
  const delta = 3 / Math.max(p.layers - 1, 3);
  const u0 = Math.min(Math.max(u, 0), 1);
  const uLo = Math.max(u0 - delta, 0), uHi = Math.min(u0 + delta, 1);
  const span = Math.max(uHi - uLo, 1e-9);
  const radii = new Float64Array(p.samples);
  for (let j = 0; j < p.samples; j++) {
    const theta = TAU * j / p.samples;
    const th = theta + g.twist_offset;
    let f0 = outerOf(p.family, u0, th, p);
    if (d) {
      const trend = (outerOf(p.family, uHi, th, p) - outerOf(p.family, uLo, th, p)) / span;
      f0 += d * trend * 0.0016 * (0.7 + 0.3 * Math.abs(g.wave));
    }
    const ripple = 0.0030 * g.wave * Math.cos(3 * k * theta + 2.1 * g.phase * 6.3);
    const dev = (f0 - 1) * g.amp_scale + ripple + 0.0012 * g.drift * Math.sin(theta * 2);
    radii[j] = Math.max((1 + dev) * p.radius_mm, 1e-3);
  }
  return radii;
}

export function boreRadius(rm, p, g) {
  if (p.bore <= 0) return 0;
  const wobble = 0.055 * g.wave * rm;
  return Math.max(0, Math.min(p.bore * p.radius_mm * g.amp_scale + wobble, 0.8 * rm));
}

/* --------------------------------------------------------- signature/audit */
export const HARMONICS = 6;
const tableCache = new Map();
function harmonicTables(n) {
  if (tableCache.has(n)) return tableCache.get(n);
  const t = [];
  for (let k = 1; k <= HARMONICS; k++) {
    const cos = new Float64Array(n), sin = new Float64Array(n);
    for (let j = 0; j < n; j++) { const th = TAU * j / n; cos[j] = Math.cos(k * th); sin[j] = Math.sin(k * th); }
    t.push([cos, sin]);
  }
  tableCache.set(n, t);
  return t;
}

export function signature(radii) {
  const n = radii.length, inv = 1 / n;
  let mean = 0;
  for (let j = 0; j < n; j++) mean += radii[j];
  mean *= inv;
  if (mean <= 0) return new Float64Array(HARMONICS + 1);
  const invMean = 1 / mean;
  const out = new Float64Array(HARMONICS + 1);
  const tables = harmonicTables(n);
  for (let h = 0; h < HARMONICS; h++) {
    const [cos, sin] = tables[h];
    let re = 0, im = 0;
    for (let j = 0; j < n; j++) { re += radii[j] * cos[j]; im += radii[j] * sin[j]; }
    out[h] = Math.hypot(re * inv * invMean, im * inv * invMean);
  }
  let varSum = 0;
  for (let j = 0; j < n; j++) varSum += (radii[j] * invMean - 1) ** 2;
  out[HARMONICS] = Math.sqrt(varSum * inv);
  return out;
}

export function separation(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export function digestOf(radii) {
  /* 16-hex FNV-1a fold over the quantised profile — cheap, stable, browser-side */
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const q = new TextEncoder().encode(Array.from(radii, r => r.toFixed(4)).join(','));
  for (let i = 0; i < q.length; i++) {
    h1 ^= q[i]; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + q[i] * (i + 7)) >>> 0; h2 = Math.imul(h2 ^ (h2 >>> 13), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

export function audit(sigs, digests, differentiation) {
  const n = sigs.length;
  const eps = 1e-7;
  if (n < 2) return { layers: n, unique: new Set(digests).size, congruent_pairs: 0, min_separation: 0, pass: n >= 1 };
  const seps = new Float64Array(n - 1);
  let minSep = Infinity, sum = 0, congruent = 0;
  for (let i = 0; i < n - 1; i++) {
    const s = separation(sigs[i], sigs[i + 1]);
    seps[i] = s; sum += s;
    if (s < minSep) minSep = s;
    if (s < eps) congruent++;
  }
  const meanSep = sum / (n - 1);
  const unique = new Set(digests).size;
  return {
    layers: n,
    unique,
    exact_duplicates: n - unique,
    congruent_pairs: congruent,
    checked_pairs: n - 1,
    min_separation: minSep,
    mean_separation: meanSep,
    separation_ratio: meanSep ? minSep / meanSep : 0,
    gain_vs_baseline: minSep > eps ? minSep / eps : 0,
    differentiation,
    baseline_unique: 1,
    pass: congruent === 0 && unique === n,
  };
}

/* ------------------------------------------------------------- generation */
export async function generate(params, onProgress = () => {}) {
  const p = clampParams(params);
  const started = performance.now();
  const glyphs = await buildGlyphs(p.family, p.seed, p.layers);

  const profiles = [];
  const sigs = [];
  const digests = [];
  for (let i = 0; i < p.layers; i++) {
    const g = glyphs[i];
    const u = (p.layers > 1 ? i / (p.layers - 1) : 0) + g.phase;
    const radii = layerRadii(u, p, g);
    profiles.push(radii);
    sigs.push(signature(radii));
    digests.push(digestOf(radii));
    if (i % 64 === 0) {
      onProgress(i / p.layers);
      await new Promise(r => setTimeout(r, 0));   // keep the UI breathing
    }
  }
  onProgress(1);
  const report = audit(sigs, digests, p.differentiation);
  const height = p.layers * p.layer_height_mm;
  // ring 0 sits at z=0 and the last ring at `height`, so the surface really is
  // `layers * layer_height` tall (pitch = height / (layers - 1)).
  const pitch = height / Math.max(p.layers - 1, 1);
  const zs = Float32Array.from({ length: p.layers }, (_, i) => i * pitch);

  /* per-layer rows: same shape the Python manifest emits, so the inspector,
   * the JSON export and the CLI all describe layers the same way */
  const layers = new Array(p.layers);
  for (let i = 0; i < p.layers; i++) {
    const radii = profiles[i], g = glyphs[i];
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let j = 0; j < radii.length; j++) {
      const r = radii[j];
      sum += r;
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    layers[i] = {
      i,
      z: +(i * pitch).toFixed(4),
      u: +(p.layers > 1 ? i / (p.layers - 1) : 0).toFixed(6),
      tag: g.tag,
      digest: digests[i],
      r_mean: +(sum / radii.length).toFixed(4),
      r_min: +lo.toFixed(4),
      r_max: +hi.toFixed(4),
      phase: g.phase, twist: g.twist_offset, amp: g.amp_scale,
      drift: g.drift, wave: g.wave,
      sig: Array.from(sigs[i], x => +x.toFixed(6)),
    };
  }

  return {
    params: p, glyphs, profiles, zs, layers, audit: report,
    height_mm: height,
    ms: performance.now() - started,
  };
}

/* ------------------------------------------------------------- colour ramp */
/* Designed height ramp (deep teal -> mint -> amber), nudged by each layer's
 * own glyph hash: colour still encodes layer identity. Mirrors layerstack.py. */
export const RAMP = [
  [0.00, 0.505, 0.62, 0.30],
  [0.42, 0.415, 0.74, 0.62],
  [0.72, 0.29, 0.82, 0.60],
  [1.00, 0.105, 0.72, 0.55],
];

export function ramp(t) {
  t = Math.min(Math.max(t, 0), 1);
  for (let k = 0; k < RAMP.length - 1; k++) {
    const a = RAMP[k], b = RAMP[k + 1];
    if (t >= a[0] && t <= b[0]) {
      let f = (t - a[0]) / Math.max(b[0] - a[0], 1e-9);
      f = f * f * (3 - 2 * f);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return RAMP[RAMP.length - 1].slice(1);
}

export function layerColor(i, n, tag) {
  const t = n > 1 ? i / (n - 1) : 0;
  let [h, s, v] = ramp(t);
  const jitter = (parseInt(tag, 16) % 1000) / 1000 - 0.5;   // -0.5 .. 0.5
  h = ((h + jitter * 0.030) % 1 + 1) % 1;
  s = Math.min(1, Math.max(0, s + jitter * 0.10));
  v = Math.min(1, Math.max(0, v + jitter * 0.07));
  return hsv(h, s, v);
}

export function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const table = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
  return table[i % 6];
}

/* ------------------------------------------------------------ prompt parse */
const RULES = [
  [/(\d+(?:\.\d+)?)\s*(?:layers?|slices?)/i, 'layers'],
  [/(\d{2,4})\s*l\b/i, 'layers'],
  [/(\d+(?:\.\d+)?)\s*(?:samples?|points?|segments?|resolution|res)\b/i, 'samples'],
  [/(\d+(?:\.\d+)?)\s*(?:lobes?|petals?|folds?|flutes?|fins?|arms?)\b/i, 'lobes'],
  [/(\d+(?:\.\d+)?)\s*-?\s*fold/i, 'lobes'],
  [/(\d+(?:\.\d+)?)\s*(?:turns?|twists?|rotations?)\b/i, 'twist'],
  [/twist\s*(?:of\s*)?(\d+(?:\.\d+)?)/i, 'twist'],
  [/(\d+(?:\.\d+)?)\s*(?:depth|amplitude|relief|bulge)\b/i, 'amplitude'],
  [/(\d+(?:\.\d+)?)\s*(?:differentiation|diff|derivative)\b/i, 'differentiation'],
  [/(\d+(?:\.\d+)?)\s*(?:bore|hollow|inner)\b/i, 'bore'],
  [/(\d+(?:\.\d+)?)\s*mm\s*(?:diameter|dia|wide|across)\b/i, 'diameter'],
  [/(?:diameter|dia)\s*(?:of\s*)?(\d+(?:\.\d+)?)/i, 'diameter'],
  [/(\d+(?:\.\d+)?)\s*mm\s*(?:radius|r)\b/i, 'radius'],
  [/(\d+(?:\.\d+)?)\s*mm\s*(?:tall|high|height)\b/i, 'height'],
  [/height\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*mm/i, 'height'],
];

const LAYER_HINTS = [
  [/\b(ultra\s*fine|hairline|jewell?ery|micro)\b/i, 0.06],
  [/\b(fine|dense|smooth|delicate)\b/i, 0.10],
  [/\b(standard|normal|default)\b/i, 0.20],
  [/\b(coarse|chunky|bold|rough|fast)\b/i, 0.32],
];

export function parsePrompt(text) {
  const low = (text || '').trim();
  let best = 'helix', bestLen = 0;
  for (const [key, list] of Object.entries(ALIASES)) {
    for (const alias of [key, ...list]) {
      if (low.toLowerCase().includes(alias) && alias.length > bestLen) { best = key; bestLen = alias.length; }
    }
  }
  const p = defaultParams(best);
  for (const [rx, key] of RULES) {
    const m = rx.exec(low);
    if (!m) continue;
    const val = parseFloat(m[1]);
    if (!isFinite(val)) continue;
    if (key === 'layers') p.layers = Math.round(val);
    else if (key === 'samples') p.samples = Math.round(val);
    else if (key === 'lobes') p.lobes = Math.round(val);
    else if (key === 'twist') p.twist = val;
    else if (key === 'amplitude') p.amplitude = val > 1 ? val / 100 : val;
    else if (key === 'differentiation') p.differentiation = val > 1.6 ? val / 100 : val;
    else if (key === 'bore') p.bore = val > 1 ? val / 100 : val;
    else if (key === 'diameter') p.radius_mm = val / 2;
    else if (key === 'radius') p.radius_mm = val;
    else if (key === 'height') p.layer_height_mm = val / p.layers;
  }
  for (const [rx, lh] of LAYER_HINTS) if (rx.test(low)) { p.layer_height_mm = lh; break; }
  if (/\b(hollow|tube|pipe|sleeve|shell|open\s*center)\b/i.test(low) && p.bore < 0.12) p.bore = 0.46;
  if (/\b(mirror|invert|flip|reverse|left[-\s]?handed)\b/i.test(low)) p.twist = -Math.abs(p.twist);
  if (/\b(tight|steep)\b/i.test(low)) p.twist = Math.abs(p.twist) * 1.6;
  if (/\b(open|loose|gentle)\b/i.test(low)) p.twist = Math.abs(p.twist) * 0.55;
  return p;
}

export function describe(p) {
  const f = FAMILIES.find(x => x.key === p.family);
  const bits = [f ? f.label : p.family, `${p.layers}L × ${p.samples}P`, `${p.lobes}-fold`,
    `twist ${p.twist}×`];
  if (p.bore) bits.push(`bore ${Math.round(p.bore * 100)}%`);
  bits.push(`${(p.layers * p.layer_height_mm).toFixed(1)} mm tall`);
  return bits.join(' · ');
}

export { TAU, BORE_EDGE, outerOf };
