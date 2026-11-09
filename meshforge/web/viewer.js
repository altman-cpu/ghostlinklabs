/* MeshForge — forge UI, three.js preview, in-browser exports. */
import * as THREE from 'three';
import {
  FAMILIES, generate, parsePrompt, describe, defaultParams, clampParams, layerColor,
} from './engine.js';
import { buildGeometryData } from './geometry.js';
import {
  makeStl, makeObjText, makeManifestObject, makeCsvText, cliCommand,
} from './webexport.js';
import { defaultPathParams, spiralPath, gcodeText } from './pathforge.js';

const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;

/* ============================================================== state */
const state = {
  params: parsePrompt('Helix, 3-fold twist, hollow'),
  res: null,          // latest forge result
  geo: null,          // latest geometry data
  baseGeo: null,      // lazy baseline (clone test)
  baseline: false,
  draft: false,
  busy: false,
  inspect: 0,
  toggles: { spin: true, wire: false, scan: true, layers: true, clone: false,
             path: true },
  explode: 0,
  path: null,               // latest toolpath (PathForge)
  pathParams: defaultPathParams(),
};

/* ============================================================== three */
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 1, 40000);

const hemi = new THREE.HemisphereLight(0xcfe9ff, 0x0a0d12, 1.15);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(1.1, 0.9, 1.5);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8ff3d0, 0.85);
fill.position.set(-1.4, 0.4, 0.6);
scene.add(fill);
const rim = new THREE.PointLight(0xff9a6b, 60, 2600, 2);
rim.position.set(-0.8, -1.2, -1.4);
scene.add(rim);

const world = new THREE.Group();
scene.add(world);

/* toolpath: one continuous bead drawn over the mesh */
const pathGroup = new THREE.Group();
world.add(pathGroup);
const pathMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
});
let pathLine = null;

/* stage: thin disc + ring at the base */
const stage = new THREE.Group();
{
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 96),
    new THREE.MeshBasicMaterial({ color: 0x0c1015, transparent: true, opacity: 0.9 }),
  );
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      new Array(129).fill(0).map((_, i) => new THREE.Vector3(Math.cos(i / 128 * TAU), Math.sin(i / 128 * TAU), 0)),
    ),
    new THREE.LineBasicMaterial({ color: 0x2a3a44, transparent: true, opacity: 0.75 }),
  );
  stage.add(disc, ring);
  stage.userData.disc = disc;
  stage.userData.ring = ring;
}
scene.add(stage);

/* materials */
const mat = new THREE.MeshStandardMaterial({
  vertexColors: true, metalness: 0.34, roughness: 0.4,
  side: THREE.DoubleSide, flatShading: false,
  emissive: new THREE.Color(0x0a1512), emissiveIntensity: 0.7,
});
const wireMat = new THREE.MeshBasicMaterial({
  color: 0x8ff3d0, wireframe: true, transparent: true, opacity: 0.10, depthWrite: false,
});
const scanUniforms = {
  uScan: { value: new THREE.Vector3(-1e9, 2.0, 0) },
  uLayers: { value: 1000 },
  uHeight: { value: 200 },
  uExplode: { value: 0 },
  uBands: { value: 1 },
};
mat.onBeforeCompile = shader => {
  shader.uniforms.uScan = scanUniforms.uScan;
  shader.uniforms.uLayers = scanUniforms.uLayers;
  shader.uniforms.uHeight = scanUniforms.uHeight;
  shader.uniforms.uExplode = scanUniforms.uExplode;
  shader.uniforms.uBands = scanUniforms.uBands;

  shader.vertexShader = `
    attribute float aU;
    uniform float uExplode;
    varying float vU;
    varying vec3 vLocal;
  ` + shader.vertexShader.replace('#include <begin_vertex>', `
    #include <begin_vertex>
    vU = aU;
    transformed.z += uExplode * aU * 260.0;
    vLocal = transformed;
  `);

  shader.fragmentShader = `
    uniform vec3 uScan;
    uniform float uLayers;
    uniform float uHeight;
    uniform float uBands;
    varying float vU;
    varying vec3 vLocal;
  ` + shader.fragmentShader.replace('#include <dithering_fragment>', `
    #include <dithering_fragment>

    // per-layer banding: 1000 discrete layers, visible at every scale
    float band = fract(vU * uLayers);
    float edge = smoothstep(0.86, 1.0, band) * (1.0 - smoothstep(0.995, 1.0, band));
    gl_FragColor.rgb += uBands * edge * vec3(0.045, 0.085, 0.075);

    // scan sweep
    float d = abs(vLocal.z - uScan.x);
    float glow = smoothstep(uScan.y, 0.0, d);
    gl_FragColor.rgb += uScan.z * glow * vec3(0.35, 1.0, 0.78);
    gl_FragColor.a = 1.0;
  `);
};
mat.customProgramCacheKey = () => 'meshforge-v1';

const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
const wire = new THREE.Mesh(new THREE.BufferGeometry(), wireMat);
world.add(mesh, wire);

/* camera rig */
const view = { theta: 0.62, phi: 1.24, dist: 420, targetTheta: 0.62, targetPhi: 1.24, targetDist: 420, drag: false, vx: 0, vy: 0 };
function applyCamera() {
  const { theta, phi, dist } = view;
  camera.position.set(
    dist * Math.sin(phi) * Math.cos(theta),
    dist * Math.sin(phi) * Math.sin(theta),
    dist * Math.cos(phi),
  );
  camera.lookAt(0, 0, 0);
}
function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, box.width), h = Math.max(1, box.height);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('stage'));

/* pointer interaction */
const pointers = new Map();
let pinchStart = 0;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  view.drag = true; view.vx = 0; view.vy = 0;
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchStart) view.targetDist = clamp(view.targetDist * (pinchStart / d), 60, 3000);
    pinchStart = d;
    return;
  }
  view.targetTheta -= dx * 0.006;
  view.targetPhi = clamp(view.targetPhi - dy * 0.005, 0.18, Math.PI - 0.18);
  view.vx = dx * 0.006; view.vy = dy * 0.005;
});
const endPointer = e => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) { view.drag = false; canvas.style.cursor = 'grab'; }
  pinchStart = 0;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  view.targetDist = clamp(view.targetDist * (1 + Math.sign(e.deltaY) * 0.08), 60, 3000);
}, { passive: false });
canvas.style.cursor = 'grab';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* render loop */
let scanPhase = 0;
function tick(now = 0) {
  requestAnimationFrame(tick);

  if (!view.drag) {
    view.targetTheta += 0.0016 + view.vx;
    view.vx *= 0.94;
    view.targetPhi = clamp(view.targetPhi + view.vy * 0.35, 0.18, Math.PI - 0.18);
    view.vy *= 0.9;
    if (!state.toggles.spin) view.targetTheta -= 0.0016 + view.vx * 0.2;
  }

  view.theta += (view.targetTheta - view.theta) * 0.12;
  view.phi += (view.targetPhi - view.phi) * 0.12;
  view.dist += (view.targetDist - view.dist) * 0.1;
  applyCamera();

  if (state.toggles.scan && state.geo) {
    const h = state.geo.height_mm;
    scanPhase = (scanPhase + 0.006) % 1;
    const z = -h / 2 + scanPhase * h;
    const amp = 0.85;
    scanUniforms.uScan.value.set(z, Math.max(h * 0.02, 1.2), amp);
  } else {
    scanUniforms.uScan.value.z = -1e9;
  }
  scanUniforms.uExplode.value += ((state.explode) - scanUniforms.uExplode.value) * 0.12;

  renderer.render(scene, camera);
}

/* ============================================================ geometry */
const geoCache = { last: null };

function toThree(geo) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(geo.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(geo.colors, 3));
  g.setAttribute('aU', new THREE.BufferAttribute(geo.aU, 1));
  g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
  g.computeBoundingSphere();
  return g;
}

function applyGeometry(geo) {
  const prev = mesh.geometry;
  const g = toThree(geo);
  mesh.geometry = g;
  wire.geometry = g;
  if (prev) prev.dispose();

  const h = geo.height_mm;
  const r = state.params.radius_mm;
  world.position.z = 0;
  mesh.position.z = -h / 2;
  wire.position.z = -h / 2;

  // stage sits under the model
  const base = -h / 2;
  stage.position.z = base - 0.4;
  const ringR = Math.max(r * 1.55, 12);
  stage.userData.disc.scale.setScalar(ringR);
  stage.userData.ring.scale.setScalar(ringR);
  stage.userData.ring.material.opacity = state.baseline ? 0.28 : 0.75;

  scanUniforms.uLayers.value = state.params.layers;
  scanUniforms.uHeight.value = h;
  scanUniforms.uBands.value = state.toggles.layers ? 1 : 0;

  // fit camera once per distinct forge size
  const fit = Math.max(h * 1.25, r * 3.2, 40);
  const want = fit / Math.tan((camera.fov * Math.PI) / 360) * 0.62;
  if (Math.abs(view.targetDist - want) / want > 0.35 || !geoCache.last) {
    view.targetDist = want;
  }
  geoCache.last = geo;
}

/* ============================================================ toolpath */
function refreshPath(res = state.res) {
  if (!res) return null;
  const t0 = performance.now();
  const path = spiralPath(res, state.pathParams);
  state.path = path;

  const n = path.points.length / 3;
  const colors = new Float32Array(n * 3);
  const rows = res.layers;
  for (let k = 0; k < n; k++) {
    const i = path.layerOf[k];
    const c = layerColor(i, res.params.layers, rows[i] && rows[i].tag);
    colors[k * 3] = c[0]; colors[k * 3 + 1] = c[1]; colors[k * 3 + 2] = c[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(path.points, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (pathLine) { pathLine.geometry.dispose(); pathLine.geometry = g; }
  else { pathLine = new THREE.Line(g, pathMat); pathGroup.add(pathLine); }
  pathGroup.position.z = -(res.height_mm || 0) / 2;
  pathGroup.visible = state.toggles.path;
  path.ms = performance.now() - t0;
  updatePathReadout(path);
  return path;
}

function updatePathReadout(path) {
  const el = $('path-readout');
  if (!el || !path) return;
  const a = path.audit, st = path.stats, c = a.control || {};
  const yes = (ok, word = 'yes') => `<b class="${ok ? 'ok' : 'bad'}">${ok ? word : 'NO'}</b>`;
  el.innerHTML = [
    `<div class="prow"><span>bead</span><b>${st.path_length_m} m</b></div>`,
    `<div class="prow"><span>seams</span>${yes(a.seams === 0, '0')}</div>`,
    `<div class="prow"><span>travel moves</span>${yes(a.travel_moves === 0, '0')}</div>`,
    `<div class="prow"><span>monotonic z</span>${yes(a.monotonic_z)}</div>`,
    `<div class="prow"><span>layers</span><b>${a.layers_traversed}/${st.layers}</b></div>`,
    `<div class="prow"><span>turns</span><b>${a.turns}</b></div>`,
    `<div class="prow"><span>filament</span><b>${st.filament_m} m · ${st.grams} g</b></div>`,
    `<div class="prow"><span>print time</span><b>~${st.est_minutes} min</b></div>`,
    `<div class="prow ctrl"><span>control</span><b>${c.pass === false
      ? `rejected · ${c.travel_moves} travels` : (c.pass ? 'passed?!' : '—')}</b></div>`,
    `<div class="pverdict ${a.pass ? 'ok' : 'bad'}">${a.pass ? 'CONTINUOUS BEAD' : 'BROKEN PATH'}</div>`,
  ].join('');
  const bead = $('m-bead');
  if (bead) bead.textContent = `${st.path_length_m} m`;
}

/* =============================================================== forge */
function setBusy(on, label = 'forging layers…') {
  state.busy = on;
  const el = $('loading');
  el.classList.toggle('hidden', !on);
  el.querySelector('span').textContent = label;
  const pill = $('pill-audit');
  pill.classList.toggle('busy', on);
}

let forgeToken = 0;
async function forge({ draft = false } = {}) {
  const token = ++forgeToken;
  setBusy(true, draft ? 'drafting layers…' : `forging ${state.params.layers} layers…`);

  const p = { ...state.params };
  if (draft) {
    p.layers = Math.min(p.layers, 260);
    p.samples = Math.min(p.samples, 80);
  }
  state.draft = draft;

  let res;
  try {
    res = await generate(p);
  } catch (err) {
    console.error(err);
    setBusy(false);
    toast(`forge failed: ${err.message}`, true);
    return;
  }
  if (token !== forgeToken) return;

  const geo = buildGeometryData(res);
  state.res = res;
  state.geo = geo;
  state.baseline = false;
  applyGeometry(geo);
  updateHud(res, geo);
  updateInspector();
  buildFamilies();
  if (state.toggles.path || !state.path) refreshPath(res);
  if (!draft) {
    state.params = res.params;
    syncSliders();
    toast(`${res.params.layers} layers · ${res.audit.unique} unique · ${res.audit.congruent_pairs} congruent · ${Math.round(res.ms)} ms`);
  }
  setBusy(false);
}

/* ================================================================= HUD */
const fmt = n => n.toLocaleString('en-US');

function updateHud(res, geo) {
  const a = res.audit;
  const p = res.params;
  const isBase = state.baseline;

  $('hud-title').textContent = `${FAMILIES.find(f => f.key === p.family)?.label || p.family} · ${p.layers}L × ${p.samples}P`;
  $('hud-sub').textContent = describe(p);

  if (isBase) {
    $('m-layers').textContent = fmt(p.layers);
    $('m-unique').textContent = '1';
    $('m-congruent').textContent = fmt(p.layers - 1);
    $('m-congruent').className = 'bad';
    $('m-minsep').textContent = '0';
    $('pill-audit').classList.add('fail');
    $('pill-audit').classList.remove('busy');
    $('audit-verdict').textContent = 'clones';
  } else {
    $('m-layers').textContent = fmt(p.layers);
    $('m-unique').textContent = fmt(a.unique);
    $('m-congruent').textContent = fmt(a.congruent_pairs);
    $('m-congruent').className = a.congruent_pairs ? 'bad' : 'ok';
    $('m-minsep').textContent = a.min_separation ? a.min_separation.toExponential(1) : '—';
    $('pill-audit').classList.toggle('fail', !a.pass);
    $('audit-verdict').textContent = state.draft ? 'draft' : (a.pass ? 'differentiated' : 'clones');
  }

  $('m-tris').textContent = fmt(geo.triangles);
  const filament = geo.volume_mm3 / 2.405 / 1000;
  $('m-fil').textContent = `${filament.toFixed(2)} m`;

  $('water-verdict').textContent = geo.watertight ? 'watertight' : 'open edges';
  $('pill-water').classList.toggle('fail', !geo.watertight);

  $('forge-id').textContent = (res.gid || shortId()).slice(0, 8);
  $('compare-label').classList.toggle('hidden', !isBase);
}

function shortId() {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(state.params)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/* ============================================================ inspector */
const plot = $('insp-plot');
const pctx = plot.getContext('2d');

function updateInspector() {
  if (!state.res) return;
  const i = clamp(state.inspect, 0, state.params.layers - 1);
  state.inspect = i;
  const res = state.res;
  const row = res.layers[Math.min(i, res.layers.length - 1)];
  const radii = res.profiles[Math.min(i, res.profiles.length - 1)];
  const next = res.profiles[Math.min(i + 1, res.profiles.length - 1)];

  $('insp-tag').textContent = `#${row.tag}`;
  $('insp-i').textContent = i;
  $('insp-z').textContent = `${(i * state.params.layer_height_mm).toFixed(2)} mm`;
  $('insp-r').textContent = `${row.r_mean.toFixed(2)} mm`;
  $('insp-dig').textContent = row.digest;

  const dpr = Math.min(devicePixelRatio, 2);
  const W = 240, H = 120;
  if (plot.width !== W * dpr) { plot.width = W * dpr; plot.height = H * dpr; }
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2, s = 0.86;
  const maxR = Math.max(...radii);
  const scale = Math.min(W, H) / (2 * maxR * 1.18) * s;
  const [cr, cg, cb] = layerColor(i, state.params.layers, row.tag);
  const colStr = `rgb(${cr * 255 | 0},${cg * 255 | 0},${cb * 255 | 0})`;

  // reference circle at mean radius
  pctx.beginPath();
  pctx.arc(cx, cy, row.r_mean * scale, 0, TAU);
  pctx.strokeStyle = 'rgba(255,255,255,0.10)';
  pctx.setLineDash([2, 4]);
  pctx.lineWidth = 1;
  pctx.stroke();
  pctx.setLineDash([]);

  // next layer for contrast
  pctx.beginPath();
  next.forEach((r, j) => {
    const th = TAU * j / next.length - Math.PI / 2;
    const x = cx + r * scale * Math.cos(th), y = cy + r * scale * Math.sin(th);
    j ? pctx.lineTo(x, y) : pctx.moveTo(x, y);
  });
  pctx.closePath();
  pctx.strokeStyle = 'rgba(255,255,255,0.18)';
  pctx.lineWidth = 1;
  pctx.stroke();

  // this layer, filled
  pctx.beginPath();
  radii.forEach((r, j) => {
    const th = TAU * j / radii.length - Math.PI / 2;
    const x = cx + r * scale * Math.cos(th), y = cy + r * scale * Math.sin(th);
    j ? pctx.lineTo(x, y) : pctx.moveTo(x, y);
  });
  pctx.closePath();
  pctx.fillStyle = `rgba(${cr * 255 | 0},${cg * 255 | 0},${cb * 255 | 0},0.22)`;
  pctx.fill();
  pctx.strokeStyle = colStr;
  pctx.lineWidth = 1.4;
  pctx.stroke();

  // centre cross
  pctx.strokeStyle = 'rgba(255,255,255,0.07)';
  pctx.beginPath();
  pctx.moveTo(cx - 4, cy); pctx.lineTo(cx + 4, cy);
  pctx.moveTo(cx, cy - 4); pctx.lineTo(cx, cy + 4);
  pctx.stroke();

  // signature bars along the bottom
  const sig = row.sig || [];
  const bw = W / Math.max(sig.length, 1);
  sig.forEach((v, k) => {
    const norm = Math.min(1, v * 3.2);
    pctx.fillStyle = k === sig.length - 1 ? 'rgba(255,184,107,0.75)' : 'rgba(126,240,200,0.55)';
    pctx.fillRect(k * bw + 2, H - 16 - norm * 14, bw - 4, norm * 14);
  });
}

/* =============================================================== exports */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const baseName = () => {
  const p = state.params;
  return `${p.family}_${p.layers}L_${p.samples}P_${shortId()}`;
};

function makeBlobStl(geo) {
  return new Blob([makeStl(geo)], { type: 'model/stl' });
}

async function doExport(kind) {
  if (!state.res) { toast('forge something first', true); return; }
  const res = state.res, geo = state.geo;
  try {
    if (kind === 'stl') {
      download(makeBlobStl(geo), `${baseName()}.stl`);
      toast(`binary STL · ${fmt(geo.triangles)} triangles`);
    } else if (kind === 'obj') {
      download(new Blob([makeObjText(geo, res, describe(res.params))], { type: 'text/plain' }),
        `${baseName()}.obj`);
      toast(`OBJ · ${res.params.layers - 1} layer groups`);
    } else if (kind === 'json') {
      const obj = makeManifestObject(res, geo, shortId(), describe(res.params));
      download(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }),
        `${baseName()}.json`);
      toast('manifest written — includes the per-layer audit');
    } else if (kind === 'csv') {
      download(new Blob([makeCsvText(res)], { type: 'text/csv' }), `${baseName()}_layers.csv`);
      toast('layer table written');
    } else if (kind === 'png') {
      renderer.render(scene, camera);
      canvas.toBlob(b => download(b, `${baseName()}.png`), 'image/png');
      toast('frame captured');
    } else if (kind === 'gcode') {
      const path = state.path || refreshPath(res);
      const text = gcodeText(path, res);
      download(new Blob([text], { type: 'text/plain' }), `${baseName()}.gcode`);
      toast(`g-code · ${fmt(path.audit.points)} moves · ${path.stats.filament_m} m filament`);
    } else if (kind === 'cmd') {
      download(new Blob([cliCommand(state.params, describe(state.params)) + '\n'],
        { type: 'text/plain' }), `${baseName()}_command.txt`);
      toast('CLI command written to a .txt');
    }
  } catch (err) {
    console.error(err);
    toast(`export failed: ${err.message}`, true);
  }
}

/* ================================================================== UI */
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

function buildFamilies() {
  const box = $('families');
  if (box.childElementCount !== FAMILIES.length) {
    box.innerHTML = '';
    for (const f of FAMILIES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<b>${f.label}</b><span>${f.lobes}-fold</span>`;
      b.title = f.hint;
      b.onclick = () => {
        state.params = defaultParams(f.key);
        state.params.bore = f.bore;
        $('family-hint').textContent = f.hint;
        syncSliders();
        forge();
      };
      box.appendChild(b);
    }
  }
  [...box.children].forEach((b, i) => {
    b.setAttribute('aria-pressed', String(FAMILIES[i].key === state.params.family));
  });
  const f = FAMILIES.find(x => x.key === state.params.family);
  $('family-hint').textContent = f ? f.hint : '—';
}

const sliders = [
  ['s-layers', 'o-layers', v => v, 'layers'],
  ['s-samples', 'o-samples', v => v, 'samples'],
  ['s-lobes', 'o-lobes', v => v, 'lobes'],
  ['s-twist', 'o-twist', v => `${(+v).toFixed(2)}×`, 'twist'],
  ['s-amp', 'o-amp', v => `${v}%`, null],
  ['s-diff', 'o-diff', v => (+v).toFixed(2), 'differentiation'],
  ['s-bore', 'o-bore', v => `${v}%`, null],
  ['s-dia', 'o-dia', v => `${v} mm`, null],
  ['s-lh', 'o-lh', v => `${(+v).toFixed(2)} mm`, 'layer_height_mm'],
  ['s-seed', 'o-seed', v => v, 'seed'],
];

function readSliders() {
  const p = state.params;
  p.layers = +$('s-layers').value;
  p.samples = +$('s-samples').value;
  p.lobes = +$('s-lobes').value;
  p.twist = +$('s-twist').value;
  p.amplitude = +$('s-amp').value / 100;
  p.differentiation = +$('s-diff').value;
  p.bore = +$('s-bore').value / 100;
  p.radius_mm = +$('s-dia').value / 2;
  p.layer_height_mm = +$('s-lh').value;
  p.seed = +$('s-seed').value;
  state.params = clampParams(p);
  updateLabels();
}

function updateLabels() {
  for (const [id, out, fmtFn] of sliders) {
    const v = $(id).value;
    $(out).textContent = fmtFn(v);
  }
}

function syncSliders() {
  const p = state.params;
  $('s-layers').value = p.layers;
  $('s-samples').value = p.samples;
  $('s-lobes').value = p.lobes;
  $('s-twist').value = p.twist;
  $('s-amp').value = Math.round(p.amplitude * 100);
  $('s-diff').value = p.differentiation;
  $('s-bore').value = Math.round(p.bore * 100);
  $('s-dia').value = Math.round(p.radius_mm * 2);
  $('s-lh').value = p.layer_height_mm;
  $('s-seed').value = p.seed;
  $('s-inspect').max = String(p.layers - 1);
  updateLabels();
  buildFamilies();
}

let sliderTimer = 0, fullTimer = 0;
for (const [id] of sliders) {
  const el = $(id);
  el.addEventListener('input', () => {
    readSliders();
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => forge({ draft: true }), 140);
    clearTimeout(fullTimer);
    fullTimer = setTimeout(() => forge({ draft: false }), 620);
  });
}

$('s-inspect').addEventListener('input', e => {
  state.inspect = +e.target.value;
  updateInspector();
});
$('s-explode').addEventListener('input', e => {
  state.explode = +e.target.value / 100;
  $('o-explode').textContent = `${e.target.value}%`;
});

/* prompt */
function submitPrompt() {
  const text = $('prompt').value.trim() || 'Helix';
  state.params = parsePrompt(text);
  state.inspect = 0;
  syncSliders();
  forge();
}

$('forge').addEventListener('click', submitPrompt);
$('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
    e.preventDefault();
    submitPrompt();
  }
});
for (const chip of $('chips').children) {
  chip.addEventListener('click', () => {
    $('prompt').value = chip.dataset.p;
    submitPrompt();
  });
}
$('random').addEventListener('click', () => {
  const f = FAMILIES[Math.floor(Math.random() * FAMILIES.length)];
  const nouns = ['twist', 'bore', 'layers', 'petals', 'diameter'];
  const bore = Math.random() < 0.4 ? `, hollow bore ${30 + Math.floor(Math.random() * 30)}` : '';
  const chunky = Math.random() < 0.3 ? ', coarse' : (Math.random() < 0.5 ? ', fine layers' : '');
  const dia = `${40 + Math.floor(Math.random() * 60)} mm diameter`;
  const text = `${f.label}, ${2 + Math.floor(Math.random() * 7)}-fold, ${(0.5 + Math.random() * 2).toFixed(1)} turns${bore}${chunky}, ${dia}`;
  $('prompt').value = text;
  void nouns;
  submitPrompt();
});

for (const btn of document.querySelectorAll('[data-export]')) {
  btn.addEventListener('click', () => doExport(btn.dataset.export));
}

/* toggles */
const toggleDefs = [
  ['t-autorotate', 'spin', 'Spin'],
  ['t-wire', 'wire', 'Wire'],
  ['t-scan', 'scan', 'Scan'],
  ['t-compare', 'clone', 'Clone test'],
  ['t-path', 'path', 'Show bead'],
];
function applyToggles() {
  for (const [id, key, label] of toggleDefs) {
    const el = $(id);
    el.classList.toggle('on', state.toggles[key]);
    el.textContent = label;
  }
  wire.visible = state.toggles.wire;
  pathGroup.visible = state.toggles.path && !!pathLine;
  scanUniforms.uBands.value = state.toggles.layers ? 1 : 0;
}
for (const [id, key] of toggleDefs) {
  $(id).addEventListener('click', () => {
    state.toggles[key] = !state.toggles[key];
    applyToggles();
    if (key === 'clone') setBaseline(state.toggles.clone);
    if (key === 'path' && state.toggles.path && !state.path) refreshPath();
  });
}

function setBaseline(on) {
  if (!state.res) return;
  if (on) {
    if (!state.baseGeo) state.baseGeo = buildGeometryData(state.res, { baseline: true });
    state.baseline = true;
    applyGeometry(state.baseGeo);
    updateHud(state.res, state.baseGeo);
    $('hud-sub').textContent = 'baseline · one silhouette extruded';
  } else {
    state.baseline = false;
    applyGeometry(state.geo);
    updateHud(state.res, state.geo);
  }
}

/* keyboard */
addEventListener('keydown', e => {
  if (e.target.matches('textarea, input')) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { state.toggles.spin = !state.toggles.spin; applyToggles(); }
  if (k === 'w') { state.toggles.wire = !state.toggles.wire; applyToggles(); }
  if (k === 's') { state.toggles.scan = !state.toggles.scan; applyToggles(); }
  if (k === 'c') { state.toggles.clone = !state.toggles.clone; applyToggles(); setBaseline(state.toggles.clone); }
  if (k === 'p') { state.toggles.path = !state.toggles.path; applyToggles(); if (state.toggles.path) refreshPath(); }
  if (k === 'e') { $('s-explode').value = state.explode ? 0 : 35; $('s-explode').dispatchEvent(new Event('input')); }
});

/* exposed for the headless harness (harmless in the browser) */
globalThis.__mf_state = state;

/* ============================================================== start up */
$('prompt').value = 'Helix, 3-fold twist, hollow';
resize();
applyToggles();
syncSliders();
applyCamera();
tick();
forge();
