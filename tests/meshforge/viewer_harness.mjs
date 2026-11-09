#!/usr/bin/env node
/* Headless smoke test for the MeshForge forge UI.
 *
 * No browser in CI: this stubs just enough DOM + WebGL + three.js to boot
 * viewer.js for real, drive the controls, and assert the HUD and the
 * in-browser exporters. Run: node tests/meshforge/viewer_harness.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/* ------------------------------------------------------------ DOM stub */
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, on) { if (on === undefined) on = !this.set.has(c); on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
  get value() { return [...this.set].join(' '); }
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.childElementCount = 0;
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList(this);
    this.listeners = new Map();
    this.value = '';
    this.max = '';
    this.textContent = '';
    this.innerHTML = '';
    this.title = '';
    this.type = '';
    this.width = 240; this.height = 120;
    this.attributes = new Map();
    this._rect = { width: 1280, height: 800, top: 0, left: 0 };
  }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return this.classList.value; }
  appendChild(c) { this.children.push(c); this.childElementCount = this.children.length; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); this.childElementCount = this.children.length; }
  remove() {}
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) {
    const fn = this.listeners.get(ev.type || 'input') || [];
    fn.forEach(f => f({ target: this, preventDefault() {}, ...ev }));
    return true;
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'aria-pressed') this['aria-pressed'] = String(v); }
  getAttribute(k) { return this.attributes.get(k); }
  getBoundingClientRect() { return this._rect; }
  setPointerCapture() {}
  getContext(kind) {
    if (kind === '2d') return ctx2d();
    return null;
  }
  toBlob(cb) { cb(new Blob([new Uint8Array(16)], { type: 'image/png' })); }
  querySelector() { return new El('span'); }
  focus() {}
  matches() { return false; }
  get parentElement() { return this._parent || ids.get('stage'); }
}

const noop = () => {};
function ctx2d() {
  return new Proxy({}, { get: (_, k) => (k in {} ? undefined : noop) });
}

const ids = new Map();
const mk = (tag, id) => { const e = new El(tag, id); ids.set(id, e); return e; };

for (const id of [
  'view', 'stage', 'toast', 'loading', 'audit-verdict', 'water-verdict', 'forge-id',
  'prompt', 'forge', 'random', 'chips', 'families', 'family-hint',
  'hud-title', 'hud-sub', 'm-layers', 'm-unique', 'm-congruent', 'm-minsep', 'm-tris', 'm-fil',
  'insp-tag', 'insp-plot', 'insp-i', 'insp-z', 'insp-r', 'insp-dig', 's-inspect',
  's-explode', 'o-explode', 'compare-label', 'pill-audit', 'pill-water',
  't-autorotate', 't-wire', 't-scan', 't-compare', 't-path',
  'path-readout', 'm-bead',
]) mk(id === 'view' || id === 'insp-plot' ? 'canvas' : 'div', id);

// sliders
const sliderIds = ['layers', 'samples', 'lobes', 'twist', 'amp', 'diff', 'bore', 'dia', 'lh', 'seed'];
for (const k of sliderIds) mk('input', `s-${k}`);
for (const k of sliderIds) mk('output', `o-${k}`);

// export buttons
const exportBtns = ['stl', 'obj', 'json', 'csv', 'png', 'cmd', 'gcode'].map(k => {
  const b = new El('button');
  b.dataset.export = k;
  return b;
});

globalThis.document = {
  getElementById: id => ids.get(id) || (ids.set(id, new El('div', id)), ids.get(id)),
  createElement: tag => new El(tag),
  querySelectorAll: sel => (sel === '[data-export]' ? exportBtns : []),
  body: new El('body'),
  addEventListener: noop,
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = fn => setTimeout(() => {}, 0);   // don't loop
globalThis.addEventListener = noop;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = noop;

// defaults matching index.html
ids.get('s-layers').value = '1000';
ids.get('s-samples').value = '128';
ids.get('s-lobes').value = '3';
ids.get('s-twist').value = '1';
ids.get('s-amp').value = '30';
ids.get('s-diff').value = '0.55';
ids.get('s-bore').value = '0';
ids.get('s-dia').value = '60';
ids.get('s-lh').value = '0.2';
ids.get('s-seed').value = '0';
ids.get('s-inspect').value = '0';
ids.get('s-explode').value = '0';

/* ----------------------------------------------------------- three stub */
globalThis.__THREE_STUB = await import(resolve(root, 'tests/meshforge/three_stub.mjs'));

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };

await import(resolve(root, 'meshforge/web/viewer.js'));

/* let the initial forge settle */
await new Promise(r => setTimeout(r, 2600));

/* --------------------------------------------------------------- checks */
const fail = [];
const check = (name, ok, detail = '') => {
  if (!ok) fail.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const text = id => ids.get(id).textContent;
const state = globalThis.__mf_state;

check('viewer booted without console errors', errors.length === 0, errors[0] || '');
check('forge produced a result', !!state && !!state.res);
check('1000 layers forged', state?.res?.params?.layers === 1000, String(state?.res?.params?.layers));
check('audit: every layer unique', state?.res?.audit?.unique === 1000, String(state?.res?.audit?.unique));
check('audit: zero congruent pairs', state?.res?.audit?.congruent_pairs === 0,
  String(state?.res?.audit?.congruent_pairs));
check('audit verdict passed', state?.res?.audit?.pass === true);
check('hollow helix is watertight', state?.geo?.watertight === true,
  `euler=${state?.geo?.euler} genus=${state?.geo?.genus}`);
check('hollow helix is genus 1', state?.geo?.genus === 1, String(state?.geo?.genus));
check('HUD shows 1000 layers', text('m-layers') === '1,000', text('m-layers'));
check('HUD shows 0 congruent', text('m-congruent') === '0', text('m-congruent'));
check('HUD verdict differentiated', text('audit-verdict') === 'differentiated', text('audit-verdict'));
check('watertight badge', text('water-verdict') === 'watertight', text('water-verdict'));
check('inspector drew a layer', text('insp-tag').startsWith('#'), text('insp-tag'));

/* exports */
const { makeStl, makeObjText, makeManifestObject, makeCsvText, cliCommand } =
  await import(resolve(root, 'meshforge/web/webexport.js'));

const geo = state.geo, res = state.res;
const stlBuf = makeStl(geo);
const dv = new DataView(stlBuf);
const triCount = dv.getUint32(80, true);
check('STL triangle count matches geometry', triCount === geo.idx.length / 3, `${triCount}`);
check('STL byte length exact', stlBuf.byteLength === 84 + triCount * 50, `${stlBuf.byteLength}`);
let badNormal = 0;
for (let t = 0; t < Math.min(triCount, 5000); t++) {
  const o = 84 + t * 50;
  const nx = dv.getFloat32(o, true), ny = dv.getFloat32(o + 4, true), nz = dv.getFloat32(o + 8, true);
  const len = Math.hypot(nx, ny, nz);
  if (Math.abs(len - 1) > 1e-3) badNormal++;
}
check('STL normals unit length', badNormal === 0, `${badNormal} bad`);

const objText = makeObjText(geo, res, 'test');
const groups = (objText.match(/^g L\d{4}_[0-9a-f]{6}$/gm) || []).length;
check('OBJ has one group per layer', groups === res.params.layers - 1, `${groups} groups`);
check('OBJ vertex count matches', (objText.match(/^v /gm) || []).length === geo.positions.length / 3);
// the OBJ writer groups only the outer wall (one band per layer, crisp caps live in STL)
const objTris = (res.params.layers - 1) * res.params.samples * 2;
check('OBJ face count matches the wall', (objText.match(/^f /gm) || []).length === objTris,
  `${(objText.match(/^f /gm) || []).length} vs ${objTris}`);

const manifest = makeManifestObject(res, geo, 'abcd1234', 'test');
check('manifest records the rule', manifest.rule === 'always match the differentiate');
check('manifest audit passes', manifest.audit.pass === true);
check('manifest lists every layer', manifest.layers.length === 1000);
check('manifest watertight flag', manifest.stats.watertight === true);
check('CSV has header + 1000 rows', makeCsvText(res).split('\n').length === 1001);

const cmd = cliCommand(res.params, 'x');
check('CLI command quotes the prompt', cmd.includes('python -m meshforge export "x"'), cmd.slice(0, 60));

/* baseline clone test */
const { buildGeometryData } = await import(resolve(root, 'meshforge/web/geometry.js'));
const base = buildGeometryData(res, { baseline: true });
const uniqueRadii = new Set();
const s0 = res.params.samples;
for (let i = 0; i < res.params.layers; i++) {
  const v = i * s0;                       // vertex 0 of layer i
  uniqueRadii.add(`${base.positions[v * 3]},${base.positions[v * 3 + 1]}`);
}
check('baseline collapses to one silhouette', uniqueRadii.size === 1, `${uniqueRadii.size} distinct rings`);
check('baseline still watertight', base.watertight === true);

/* ------------------------------------------------- PathForge (toolpath) */
const pf = await import(resolve(root, 'meshforge/web/pathforge.js'));
const P = state.path;

check('toolpath was cut', !!P && P.points.length === 1000 * 128 * 3,
  P ? String(P.points.length / 3) + ' points' : 'none');
check('toolpath audit passes', P?.audit?.pass === true,
  `seams=${P?.audit?.seams} travel=${P?.audit?.travel_moves}`);
check('toolpath has no seams', P?.audit?.seams === 0, String(P?.audit?.seams));
check('toolpath never travels', P?.audit?.travel_moves === 0, String(P?.audit?.travel_moves));
check('toolpath z never backtracks', P?.audit?.monotonic_z === true);
check('toolpath visits every layer', P?.audit?.layers_traversed === 1000,
  String(P?.audit?.layers_traversed));
check('toolpath turns once per layer', Math.abs(P?.audit?.turns - 1000) < 0.1,
  String(P?.audit?.turns));
check('control build is rejected', P?.audit?.control?.pass === false,
  `control travel=${P?.audit?.control?.travel_moves}`);
check('control fails on seams, not on Z', P?.audit?.control?.seams > 0
  && P?.audit?.control?.monotonic_z === false);
check('readout reports a continuous bead',
  ids.get('path-readout').innerHTML.includes('CONTINUOUS BEAD'));
check('readout shows the rejected control',
  ids.get('path-readout').innerHTML.includes('rejected'));
check('HUD bead metric set', /\d/.test(text('m-bead')), text('m-bead'));

// the audit must be able to fail
const broken = Float32Array.from(P.points);
broken[500 * 3] += 40;
const badAudit = pf.auditPath(broken, P.extruding,
  { layers: 1000, pitch: pf.pitchOf(res), pp: P.params });
check('audit catches a teleport in the bead', badAudit.seams > 0 && badAudit.pass === false,
  `seams=${badAudit.seams}`);

const gcode = pf.gcodeText(P, res);
const gMoves = gcode.split('\n').filter(l => l.startsWith('G1 X') && l.includes(' E'));
check('g-code has one move per point', gMoves.length === P.points.length / 3 - 1,
  `${gMoves.length}`);
const body = (gcode.split('; ---- spiral')[1] || '').split('; ---- end')[0];
check('g-code has no travel or lift inside the bead',
  !/;\s*(travel|lift|descend|safe height)/.test(body),
  (body.match(/;\s*(travel|lift|descend|safe height)/) || [''])[0]);
const es = gMoves.map(l => parseFloat(l.split('E')[1]));
check('g-code extrusion only ever advances', es.every((v, i) => i === 0 || v >= es[i - 1]));
check('g-code filament matches the stats',
  Math.abs(es[es.length - 1] - P.stats.filament_mm) / P.stats.filament_mm < 0.01,
  `${es[es.length - 1].toFixed(1)} mm vs ${P.stats.filament_mm} mm`);
check('g-code carries the rule and the audit',
  gcode.includes('; rule: always match the differentiate')
  && gcode.includes('pass=True') && gcode.includes('control (ring-per-layer): continuous=False'));
check('g-code ends cleanly', gcode.trimEnd().endsWith('M84 ; motors off'));

const thin = pf.gcodeText(P, res, { decimate: 4 });
const thinMoves = thin.split('\n').filter(l => l.startsWith('G1 X') && l.includes(' E'));
check('decimation shrinks the file', thinMoves.length < gMoves.length / 3,
  `${thinMoves.length} vs ${gMoves.length}`);

console.log('');
if (fail.length) {
  console.log(`${fail.length} FAILURE(S):`);
  fail.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log('all checks passed');
