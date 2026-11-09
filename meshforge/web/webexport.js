/* MeshForge browser-side exporters — pure functions, no three.js, no DOM.
 *
 * The binary STL written here is structurally identical to
 * meshforge/exporters.py:write_stl_binary (80-byte header, float32 triangle
 * records). The OBJ groups one `g` per layer so a slicer sees 1000 parts.
 */

export function makeStl(geo, { header = 'MeshForge 1000-layer forge · always match the differentiate', pointScale = 1 } = {}) {
  const idx = geo.idx, pos = geo.positions;
  const tris = idx.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf, 0, 80);
  const head = new TextEncoder().encode(header);
  u8.set(head.subarray(0, 80));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a] * pointScale, ay = pos[a + 1] * pointScale, az = pos[a + 2] * pointScale;
    const ux = pos[b] * pointScale - ax, uy = pos[b + 1] * pointScale - ay, uz = pos[b + 2] * pointScale - az;
    const vx = pos[c] * pointScale - ax, vy = pos[c + 1] * pointScale - ay, vz = pos[c + 2] * pointScale - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const ln = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / ln, true);
    dv.setFloat32(o + 4, ny / ln, true);
    dv.setFloat32(o + 8, nz / ln, true);
    dv.setFloat32(o + 12, ax, true);
    dv.setFloat32(o + 16, ay, true);
    dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, pos[b] * pointScale, true);
    dv.setFloat32(o + 28, pos[b + 1] * pointScale, true);
    dv.setFloat32(o + 32, pos[b + 2] * pointScale, true);
    dv.setFloat32(o + 36, pos[c] * pointScale, true);
    dv.setFloat32(o + 40, pos[c + 1] * pointScale, true);
    dv.setFloat32(o + 44, pos[c + 2] * pointScale, true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return buf;
}

export function makeObjText(geo, res, description = '') {
  const pos = geo.positions;
  const n = res.params.layers, s = res.params.samples;
  const chunks = [
    `# MeshForge 1000-layer forge\n# rule: always match the differentiate\n# ${description}\no meshforge\n`,
  ];
  let line = '';
  for (let i = 0; i < pos.length; i += 3) {
    line += `v ${pos[i].toFixed(4)} ${pos[i + 1].toFixed(4)} ${pos[i + 2].toFixed(4)}\n`;
    if (line.length > (1 << 20)) { chunks.push(line); line = ''; }
  }
  chunks.push(line);

  for (let i = 0; i < n - 1; i++) {
    const tag = res.layers[Math.min(i, res.layers.length - 1)].tag;
    let fl = `g L${String(i).padStart(4, '0')}_${tag}\n`;
    for (let j = 0; j < s; j++) {
      const j2 = (j + 1) % s;
      const a = i * s + j + 1, b = i * s + j2 + 1;
      const c = (i + 1) * s + j2 + 1, d = (i + 1) * s + j + 1;
      fl += `f ${a} ${b} ${c}\nf ${a} ${c} ${d}\n`;
    }
    chunks.push(fl);
  }
  return chunks.join('');
}

export function makeManifestObject(res, geo, id, describe) {
  const layers = res.layers.map(r => ({
    i: r.i, z: r.z, tag: r.tag, digest: r.digest,
    r_mean: r.r_mean, r_min: r.r_min, r_max: r.r_max,
    glyph: { phase: r.phase, twist: r.twist, amp: r.amp, drift: r.drift, wave: r.wave },
    sig: r.sig,
  }));
  return {
    generator: 'MeshForge 1.0',
    rule: 'always match the differentiate',
    id,
    params: res.params,
    description: describe || undefined,
    stats: {
      layers: res.params.layers,
      samples: res.params.samples,
      vertices: geo.vertices,
      triangles: geo.triangles,
      height_mm: +res.height_mm.toFixed(3),
      volume_cm3: +(geo.volume_mm3 / 1000).toFixed(4),
      surface_cm2: +(geo.surface_mm2 / 100).toFixed(3),
      filament_m: +(geo.volume_mm3 / 2.405 / 1000).toFixed(3),
      watertight: geo.watertight,
      euler_characteristic: geo.euler,
      genus: geo.genus,
      hollow: geo.hollow,
    },
    audit: {
      rule: 'no two layers congruent (rotation + scale invariant)',
      pass: res.audit.pass,
      unique: res.audit.unique,
      congruent_pairs: res.audit.congruent_pairs,
      checked_pairs: res.audit.checked_pairs,
      min_separation: res.audit.min_separation,
      mean_separation: res.audit.mean_separation,
      differentiation: res.params.differentiation,
      baseline: 'flat extrusion of one silhouette',
      baseline_unique: 1,
    },
    layers,
  };
}

export function makeCsvText(res) {
  const rows = ['i,z_mm,u,tag,digest,r_mean,r_min,r_max,phase,twist,amp,drift,wave'];
  for (const r of res.layers) {
    rows.push([r.i, r.z, r.u, r.tag, r.digest, r.r_mean, r.r_min, r.r_max,
      r.phase, r.twist, r.amp, r.drift, r.wave].join(','));
  }
  return rows.join('\n');
}

export function cliCommand(p, describe) {
  return `python -m meshforge export "${describe}" --layers ${p.layers} --samples ${p.samples} `
    + `--lobes ${p.lobes} --twist ${p.twist} --differentiation ${p.differentiation} --bore ${p.bore} `
    + `--diameter ${(p.radius_mm * 2).toFixed(1)} --layer-height ${p.layer_height_mm} --out out/`;
}
