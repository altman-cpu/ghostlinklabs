# PathForge

The second OLVR module: **a forged mesh in, one continuous printable toolpath
out** — with a continuity audit that can fail, and a control that does.

```bash
python3 -m pathforge export "Helix, 1000 layers, bore 46%" -o out/
python3 -m pathforge audit  "Ghost, 1000 layers"
python3 -m pathforge preview "Geometric waves" -o /tmp/waves.svg
```

## What it does

A 1000-layer MeshForge shell is normally sliced as 1000 closed rings with a
travel move and a Z-hop between each. PathForge cuts it as **one bead**: the
nozzle spirals up the wall without ever lifting, stopping, or backtracking,
riding the mid-wall radius so the extrusion lands inside the shell.

Step `k` sits at turn `k / samples` and height `(k / samples) × pitch`, so the
tool describes a true helix while the radius keeps reading the forged field.

## The audit

| field | meaning |
| --- | --- |
| `seams` | breaks in the bead: the extruder shut off, or a jump out of scale with the path's own step length |
| `travel_moves` | dry moves — must be `0` |
| `monotonic_z` | Z never goes backwards — no hop-and-drop |
| `layers_traversed` | distinct layer bands the bead passes through — must be all of them |
| `turns` | total angular travel / 2π (≈ the layer count) |
| `control` | **the same build sliced ring-by-ring**: closed rings with a travel + Z-hop between layers. It reports ~2×layers travel moves and must be rejected |

Reference build (1000 L × 128 P helix, Ø60, 200 mm, bore 46 %):
128,000 points, 154.7 m of bead, 1,000/1,000 layers, 0 seams, 0 travel moves,
monotone Z — and the control reports 1,999 travel moves and fails.

## Output

| file | contents |
| --- | --- |
| `.gcode` | G21/G90/M82, absolute E, no travel inside the bead, comments carrying the audit + the control |
| `.json` | manifest: brand, rule, source mesh gid, audit, stats, downsampled preview polyline |
| `.csv` | one row per layer: entry Z, point count, radius range, bead length, filament |
| `.svg` | proof sheet — plan view beside the same path unrolled (turns × height) |

Decimation (`--decimate N`) is an export concern only: the audit always runs on
the full path, and a decimated file still pushes exactly the same filament
because E is sampled from the full-resolution curve, not recomputed.

## In the browser

`meshforge/web/pathforge.js` is the JS port (same spiral, same audit, same
control) and drives the **Toolpath** panel in the web forge: toggle *Show bead*
(or press **P**) to draw the spiral over the model, and **G-code** to download
it. The panel shows seams, travel moves, monotonic Z, layers, turns, filament
and print time, with the rejected control underneath.

## Tests

```bash
python3 -m pytest tests/test_pathforge.py -q     # 19 checks
node tools/render_path.mjs "Helix, 600 layers" -o /tmp/bead.png
```
