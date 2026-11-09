# MeshForge

Prompt-driven generator for **1000-layer, 3D-printable meshes**.

You type a structural prompt (`Helix`, `Geometric waves`, `ghost, 1200 layers, bore 40`).
MeshForge returns a watertight, manifold, hollow shell plus a **differentiation
audit** that proves every one of the 1000 slices is its own shape.

> **Rule: always match the differentiate.**
> A layer may never be a scaled copy of another layer. Each slice is the field
> sampled along the build axis **plus its own derivative dressing** **plus a
> per-layer hash glyph**. The app proves it, it doesn't claim it.

---

## Quick start

```bash
# web forge (prompt box, live preview, audit readout, exports)
python3 -m meshforge serve            # → http://localhost:7600

# command line
python3 -m meshforge export "Helix, 1000 layers, 128 samples, bore 46%" -o out/
python3 -m meshforge audit "Geometric waves" --layers 1000
python3 -m meshforge families
```

`python3 -m meshforge --help` lists everything. No third-party dependencies —
the generator is pure stdlib Python, and the viewer is a static ES-module page
with [three.js](https://threejs.org) vendored at `meshforge/three/`.

---

## What "differentiated" means, precisely

For layer `i` of `n`:

1. **Field** — one of eight families (`helix`, `waves`, `spiral`, `lattice`,
   `ghost`, `vortex`, `mountain`, `seed`) evaluated at `u = i/(n-1)`.
2. **Derivative dressing** — the field is sampled at `u-δ` and `u+δ` and the
   finite difference is added back with weight `differentiation`, so the slice
   carries the *slope* of the shape, not just its height.
3. **Glyph** — `SHA-256("family|seed|index")` drives a deterministic per-layer
   phase, twist offset, amplitude scale, drift and wave. Change one layer index
   and only that layer changes.

The audit then compares each slice's **rotation- and scale-invariant
signature** against its neighbour:

| audit field | meaning |
| --- | --- |
| `unique` | distinct layer digests — must equal `layers` |
| `congruent_pairs` | neighbouring slices identical under rotation+scale — must be `0` |
| `min_separation` | smallest neighbour distance; congruent means `< 1e-7` |
| `gain_vs_baseline` | how far above the congruent threshold the worst pair sits |
| `baseline_unique` | **control**: the same build with per-layer identity switched off reports `1` unique shape and `n-1` congruent pairs |

The control matters. An audit that can never fail proves nothing, so the UI
renders the flat-extrusion control next to the real build, and the test suite
(`tests/test_meshforge.py::test_audit_catches_clones`) asserts the control
*does* collapse.

---

## Output

| file | contents |
| --- | --- |
| `.stl` | binary STL, watertight, outward normals, ASCII-safe header |
| `-ordered.stl` | same mesh, triangles grouped layer by layer |
| `.obj` | per-layer `g` groups (outer wall; no caps) |
| `.json` | manifest: params, stats, full audit, all 1000 layer rows |
| `.csv` | one row per layer (`i,z,u,tag,digest,r_mean,r_min,r_max,…`) |
| `.txt` | the CLI command that reproduces the mesh |

Geometry facts for the reference build (1000 L × 128 P, Ø60, 200 mm, bore 46%):
256,128 vertices, 512,256 triangles, watertight, genus 1, **1000/1000 layers
unique, 0 congruent pairs**.

---

## Web forge

`meshforge/web/` is a static ES-module app served by `meshforge serve`:

- `engine.js` — the field/glyph/differentiator port (parity with Python: same
  SHA-256 glyphs, same signatures, same audit numbers)
- `geometry.js` — typed-array mesh builder (wall + inner bore + caps), solved
  winding so the shell is watertight
- `viewer.js` — prompt box, sliders, HUD, audit panel, layer inspector, exports
- `webexport.js` — the exporters, shared by the UI and the harness (no copy)
- `index.html`, `styles.css`

Prompt syntax understood by both the CLI and the web box:

```
helix 640 layers, 96 samples, 5 folds, 2.5 turns, hollow bore 40, 80 mm diameter, fine layers
```

Numbers may precede or follow their keyword; `layers`, `samples`, `folds`,
`twist/turns`, `bore/hollow`, `relief/amplitude`, `differentiation`, `seed`,
diameter/radius, height, and layer-height hints (`coarse`/`fine`/`ultra`) are
all read. Unrecognised words pick the family.

---

## Tests

```bash
python3 -m pytest tests/test_meshforge.py -q          # 46 checks, Python core
node --experimental-loader ./tests/meshforge/importmap_hook.mjs \
     tests/meshforge/viewer_harness.mjs               # 27 checks, real UI headless
```

The node harness boots the actual viewer against a three.js stub and asserts the
HUD, the audit panel, watertightness and every export. `tools/render_preview.mjs`
rasterises any prompt to a PNG without a GPU or a browser:

```bash
node tools/render_preview.mjs "Helix, 1000 layers" -o /tmp/helix.png
```
