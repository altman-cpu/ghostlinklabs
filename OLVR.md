# OLVR

**OLVR builds generative manufacturing tools that prove their own output.**

A prompt goes in. An artifact comes out. Attached to every artifact is an audit
that shows the work — and a *control* build that the audit is required to
reject. If the audit can't fail, it isn't an audit.

## The contract

Every OLVR module obeys the same four rules:

1. **One command produces the artifact.**
   `python -m <module> export "<prompt>" -o out/` — no hidden steps, no GUI
   required, no tribal knowledge.
2. **Every artifact ships with an audit.**
   Not a claim. Numbers: what was measured, what the threshold is, and whether
   it passed.
3. **The audit must be able to fail, and a control must fail it.**
   MeshForge audits a flat extrusion next to the real build; PathForge audits a
   ring-per-layer slice next to the spiral. Tests assert the control *is*
   rejected. An audit that can never fail proves nothing.
4. **Tests are part of the deliverable.**
   Python core: pytest. Browser: a headless harness that boots the real UI.

## Modules

| module | prompt → artifact | the audit |
| --- | --- | --- |
| [`meshforge/`](meshforge/README.md) | structural prompt → 1000-layer watertight printable mesh | **differentiation**: every layer is a distinct slice, never a scaled copy (control: flat extrusion → 1 unique shape, n−1 congruent) |
| [`pathforge/`](pathforge/README.md) | forged mesh → one continuous spiral toolpath (g-code) | **continuity**: no seams, no travel moves, Z never backtracks, all 1000 layers visited (control: ring-per-layer → travel moves at every layer) |

Rule of the house: **always match the differentiate.** A layer — or a bead —
may never be a copy of another.

## Quickstart

```bash
python3 -m meshforge serve                 # web forge: http://localhost:7600
python3 -m meshforge export "Helix, 1000 layers, bore 46%" -o out/
python3 -m pathforge export "Helix, 1000 layers, bore 46%" -o out/
python3 -m pathforge preview "Geometric waves" -o /tmp/waves.svg

python3 -m pytest tests/ -q                # 65 checks across both modules
node --experimental-loader ./tests/meshforge/importmap_hook.mjs \
     tests/meshforge/viewer_harness.mjs    # 47 checks driving the real UI
```

No third-party dependencies for either module: pure stdlib Python, vendored
three.js for the viewer.

## Repo map

```
OLVR.md          this file — brand and module contract
meshforge/       module 1: prompt → 1000-layer mesh
pathforge/       module 2: mesh → continuous toolpath
olvr/            namespace package: version + module registry
tools/           offline renderers (PNG/SVG) so output can be checked without a GPU
tests/           pytest suites + the headless browser harness
ghostlink/       legacy GhostLink package (predates the OLVR name)
```

## Why this shape

The value of a tool like this is not that it works once while its author is
watching. It's that it works the same way next month, for someone else, with
the proof attached. That's what the audits, the controls and the tests buy:
the artifact carries the evidence, so the work doesn't depend on anyone being
in the room.
