"""MeshForge test suite.

The important test in this file is ``test_audit_catches_clones``: an audit
that can never fail proves nothing, so we build a stack with the per-layer
identity switched off and assert the audit reports clones.
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from meshforge import fields, layerstack, prompts  # noqa: E402
from meshforge.differentiator import (  # noqa: E402
    audit_layers, digest, glyph, separation, signature,
)
from meshforge.exporters import (  # noqa: E402
    stamp_filename, write_manifest, write_obj, write_ordered_stl, write_stl_ascii,
    write_stl_binary,
)
from meshforge.fields import FAMILIES, Params, clamp_params  # noqa: E402
from meshforge.layerstack import forge, open_edge_count, volume  # noqa: E402


# ---------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def forged():
    return forge(Params(family="helix", layers=240, samples=96, bore=0.45))


@pytest.fixture(scope="module")
def solid():
    return forge(Params(family="waves", layers=200, samples=64, bore=0.0))


# ------------------------------------------------------------------ glyphs
def test_glyph_is_deterministic():
    a = glyph("helix", 137, seed=4, total=1000)
    b = glyph("helix", 137, seed=4, total=1000)
    assert a == b
    assert a.tag == b.tag and len(a.tag) == 6


def test_glyphs_differ_across_layers_and_seeds():
    tags = {glyph("helix", i, seed=0, total=1000).tag for i in range(400)}
    assert len(tags) > 380, "glyph tags should almost never collide"
    assert glyph("helix", 10, seed=0).tag != glyph("helix", 10, seed=1).tag
    assert glyph("helix", 10).tag != glyph("ghost", 10).tag


def test_glyph_ranges_are_bounded():
    for i in range(200):
        g = glyph("mountain", i, seed=7, total=1000)
        assert -0.01 < g.phase < 0.01
        assert abs(g.twist_offset) < 0.05
        assert 0.93 < g.amp_scale < 1.07
        assert -1 <= g.drift <= 1 and -1 <= g.wave <= 1


# -------------------------------------------------------------- signature
def test_signature_is_rotation_and_scale_invariant():
    radii = [10.0 + 2.0 * math.cos(3 * math.tau * j / 64) for j in range(64)]
    rotated = radii[17:] + radii[:17]
    scaled = [r * 4.25 for r in radii]
    sig = signature(radii)
    assert separation(sig, signature(rotated)) < 1e-9
    assert separation(sig, signature(scaled)) < 1e-9


def test_signature_rejects_a_flat_circle():
    circle = [12.0] * 64
    sig = signature(circle)
    assert sig[-1] == pytest.approx(0.0, abs=1e-12)   # anisotropy term


def test_digest_changes_with_geometry():
    a = [10.0 + 0.01 * j for j in range(32)]
    b = list(a)
    b[5] += 0.001
    assert digest(a) != digest(b)


# ------------------------------------------------------------------ audit
def test_audit_passes_on_a_differentiated_stack(forged):
    audit = forged.audit
    assert audit["layers"] == 240
    assert audit["unique"] == 240
    assert audit["congruent_pairs"] == 0
    assert audit["match"]["pass"] is True
    assert audit["match"]["verdict"] == "differentiated"


def test_audit_catches_clones(monkeypatch):
    """Control group: no differentiation, no glyph identity => clones."""
    def flat_glyph(family, index, seed=0, total=1):
        return layerstack.Glyph(index=index, tag="000000", phase=0.0,
                                twist_offset=0.0, amp_scale=1.0, drift=0.0, wave=0.0)

    monkeypatch.setattr(layerstack, "glyph", flat_glyph)
    p = Params(family="helix", layers=120, samples=48, differentiation=0.0)
    profiles, _ = layerstack.build_layer_profiles(p)
    audit = audit_layers([signature(r) for r in profiles], [digest(r) for r in profiles])
    assert audit["congruent_pairs"] > 0
    assert audit["match"]["pass"] is False
    assert audit["match"]["verdict"] == "clones detected"


def test_audit_beats_a_naive_lumina_style_stack():
    """A silhouette extruded without differentiation is one unique layer."""
    p = Params(family="ghost", layers=90, samples=48, differentiation=0.0)
    profiles, _ = layerstack.build_layer_profiles(p)
    # collapse every layer onto the middle one, as a naive extruder would
    mid = profiles[len(profiles) // 2]
    naive = [list(mid) for _ in profiles]
    audit = audit_layers([signature(r) for r in naive], [digest(r) for r in naive])
    assert audit["unique"] == 1
    assert audit["congruent_pairs"] == len(naive) - 1


def test_differentiation_widens_the_gap_between_layers():
    gaps = []
    for d in (0.0, 0.35, 1.2):
        p = Params(family="helix", layers=150, samples=64, differentiation=d)
        profiles, _ = layerstack.build_layer_profiles(p)
        sigs = [signature(r) for r in profiles]
        gaps.append(sum(separation(sigs[i], sigs[i + 1]) for i in range(len(sigs) - 1)) / (len(sigs) - 1))
    assert gaps[0] < gaps[1] < gaps[2]


# ------------------------------------------------------------------ mesh
def test_mesh_is_watertight_and_orientable(forged, solid):
    for r in (forged, solid):
        assert r.mesh.open_edges == 0
        assert r.mesh.watertight is True
        assert r.mesh.volume_mm3 > 0
        assert volume(r.mesh) == pytest.approx(r.mesh.volume_mm3, rel=1e-6)


def test_hollow_mesh_has_a_bore(forged, solid):
    assert forged.mesh.hollow is True
    assert forged.mesh.volume_mm3 < solid.mesh.volume_mm3 * 4   # sanity, not exact
    assert solid.mesh.hollow is False
    # a bore removes material: same envelope, less volume per unit height
    v_solid = solid.mesh.volume_mm3 / solid.params.height_mm
    v_hollow = forged.mesh.volume_mm3 / forged.params.height_mm
    assert v_hollow < v_solid


def test_every_layer_ring_has_the_requested_resolution(forged):
    s = forged.params.samples
    n = forged.params.layers
    assert len(forged.mesh.positions) == (n * s + (n * s if forged.mesh.hollow else 0)) * 3 + (
        s * 3 if forged.mesh.hollow else 2 * 3
    )
    assert forged.mesh.triangles == len(forged.mesh.indices) // 3


def test_layer_heights_are_evenly_spaced(forged):
    zs = [row["z"] for row in forged.layers]
    diffs = [zs[i + 1] - zs[i] for i in range(len(zs) - 1)]
    # the surface spans the requested height across (layers - 1) ring gaps
    assert max(diffs) - min(diffs) < 2e-4, "rings must be evenly spaced"
    assert sum(diffs) / len(diffs) == pytest.approx(forged.params.pitch_mm, abs=1e-4)


def test_open_edge_count_detects_a_hole(forged):
    assert open_edge_count(forged.mesh) == 0
    mesh = forged.mesh
    trimmed = type(mesh)(
        positions=mesh.positions, normals=mesh.normals, colors=mesh.colors,
        indices=mesh.indices[:-3],   # drop one triangle
    )
    assert open_edge_count(trimmed) > 0


# --------------------------------------------------------------- params
@pytest.mark.parametrize("key", sorted(FAMILIES))
def test_every_family_forges_cleanly(key):
    p = clamp_params(Params(family=key, layers=60, samples=48))
    r = forge(p)
    assert r.mesh.watertight, key
    assert r.audit["unique"] == 60, key
    assert r.audit["congruent_pairs"] == 0, key
    bmin, bmax = r.mesh.bounds()
    assert bmax[2] - bmin[2] == pytest.approx(r.params.height_mm, rel=1e-6)
    reach = r.params.radius_mm * 2.5
    assert max(abs(v) for v in bmin[:2] + bmax[:2]) < reach, key


def test_clamp_params_defends_the_build_envelope():
    p = clamp_params(Params(layers=999999, samples=1, lobes=0, amplitude=9,
                            twist=99, bore=9, radius_mm=0, layer_height_mm=-3))
    assert p.layers == 4000
    assert p.samples == 24
    assert p.lobes == 2
    assert 0 <= p.amplitude <= 0.55
    assert -6 <= p.twist <= 6
    assert p.bore <= 0.72
    assert p.radius_mm >= 4
    assert p.layer_height_mm >= 0.02


def test_same_prompt_same_object():
    a = forge(prompts.parse_prompt("Helix, 3-fold twist, hollow"))
    b = forge(prompts.parse_prompt("Helix, 3-fold twist, hollow"))
    assert a.gid == b.gid
    assert a.digest == b.digest
    assert [r["digest"] for r in a.layers[:32]] == [r["digest"] for r in b.layers[:32]]


def test_seed_changes_the_object():
    a = forge(Params(family="helix", layers=120, samples=48, seed=0))
    b = forge(Params(family="helix", layers=120, samples=48, seed=1))
    assert a.digest != b.digest
    assert [r["tag"] for r in a.layers[:8]] != [r["tag"] for r in b.layers[:8]]


# --------------------------------------------------------------- prompts
@pytest.mark.parametrize("text,family", [
    ("Helix", "helix"),
    ("Geometric waves, 5 petals", "waves"),
    ("spiral sweep", "spiral"),
    ("lattice gear", "lattice"),
    ("ghost teardrop", "ghost"),
    ("vortex fluted column", "vortex"),
    ("mountain ridge", "mountain"),
    ("seed pod phyllotaxis", "seed"),
])
def test_prompt_family_detection(text, family):
    assert prompts.parse_prompt(text).family == family


def test_prompt_reads_numbers():
    p = prompts.parse_prompt("helix 640 layers, 96 samples, 5 folds, 2.5 turns,"
                             " hollow bore 40, 80 mm diameter, fine layers")
    assert p.layers == 640
    assert p.samples == 96
    assert p.lobes == 5
    assert p.twist == 2.5
    assert p.bore == pytest.approx(0.40)
    assert p.radius_mm == pytest.approx(40.0)
    assert p.layer_height_mm == pytest.approx(0.10)


def test_prompt_hollow_keyword_opens_a_bore():
    p = prompts.parse_prompt("ghost tower, hollow")
    assert p.bore > 0.4
    q = prompts.parse_prompt("ghost tower")
    assert q.bore == 0.0


def test_prompt_mirror_flips_the_twist():
    assert prompts.parse_prompt("helix, mirror").twist < 0
    assert prompts.parse_prompt("helix, reverse 2 turns").twist < 0


def test_prompt_height_sets_layer_height():
    p = prompts.parse_prompt("helix 500 layers, 100 mm tall")
    assert p.layer_height_mm == pytest.approx(0.2)
    assert p.height_mm == pytest.approx(100.0)


def test_describe_is_human_readable():
    d = prompts.describe(prompts.parse_prompt("helix, hollow, 60 mm diameter"))
    assert "Helix" in d and "bore" in d and "mm tall" in d


# ---------------------------------------------------------------- exports
def test_binary_stl_header_and_count(forged, tmp_path):
    path = write_stl_binary(forged.mesh, tmp_path / "a.stl")
    raw = path.read_bytes()
    assert len(raw) == 84 + forged.mesh.triangles * 50
    assert struct.unpack("<I", raw[80:84])[0] == forged.mesh.triangles
    assert b"MeshForge" in raw[:80]


def test_binary_stl_normals_are_unit(solid, tmp_path):
    path = write_stl_binary(solid.mesh, tmp_path / "b.stl")
    raw = path.read_bytes()
    tris = struct.unpack("<I", raw[80:84])[0]
    for t in range(0, tris, max(1, tris // 500)):
        nx, ny, nz = struct.unpack_from("<3f", raw, 84 + t * 50)
        assert abs(math.sqrt(nx * nx + ny * ny + nz * nz) - 1.0) < 1e-3


def test_ascii_stl_is_loadable(solid, tmp_path):
    path = write_stl_ascii(solid.mesh, tmp_path / "c.stl", name="meshforge")
    text = path.read_text()
    assert text.startswith("solid meshforge")
    assert text.rstrip().endswith("endsolid meshforge")
    assert text.count("facet normal") == solid.mesh.triangles
    assert text.count("vertex") == solid.mesh.triangles * 3


def test_segmented_stl_literally_lists_every_layer(forged, tmp_path):
    path = write_ordered_stl(forged, tmp_path / "d.stl")
    text = path.read_text()
    solids = [ln for ln in text.splitlines() if ln.startswith("solid ")]
    assert len(solids) == forged.params.layers
    assert solids[0].startswith("solid L0000_")
    assert solids[-1].startswith(f"solid L{forged.params.layers - 1:04d}_")
    tags = [s.split("_")[-1] for s in solids]
    assert tags == [row["tag"] for row in forged.layers]


def test_obj_vertices_and_faces(solid, tmp_path):
    path = write_obj(solid.mesh, tmp_path / "e.obj")
    text = path.read_text()
    assert (text.count("\nv ") + text.count("\nv ", 0, 3)) == solid.mesh.vertices
    assert text.count("\nf ") == solid.mesh.triangles


def test_manifest_records_rule_audit_and_layers(forged, tmp_path):
    path = write_manifest(forged, tmp_path / "f.json")
    doc = json.loads(path.read_text())
    assert doc["rule"] == "always match the differentiate"
    assert doc["audit"]["pass"] is True
    assert doc["audit"]["unique"] == doc["params"]["layers"]
    assert doc["stats"]["watertight"] is True
    assert len(doc["layers"]) == doc["params"]["layers"]
    assert all(len(row["digest"]) == 16 for row in doc["layers"])
    assert all(len(row["tag"]) == 6 and int(row["tag"], 16) >= 0
               for row in doc["layers"])
    assert len({row["tag"] for row in doc["layers"]}) > 0.9 * len(doc["layers"])


def test_filenames_are_descriptive_and_unique(forged):
    name = stamp_filename(forged, "stl")
    assert name.startswith(f"helix_{forged.params.layers}L_")
    assert name.endswith(".stl")
    assert forged.gid[:8] in name
