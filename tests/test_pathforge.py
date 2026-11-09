"""PathForge test suite.

The important test is ``test_control_is_rejected``: an audit that can never
fail proves nothing, so we slice the same mesh ring-by-ring with a travel move
between rings and assert the audit reports seams — and then we break a good
path on purpose (``test_audit_can_fail_on_a_broken_path``) to show the audit is
reading the geometry, not returning a constant.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from meshforge.layerstack import forge                       # noqa: E402
from meshforge.fields import Params                          # noqa: E402
from meshforge.prompts import parse_prompt                   # noqa: E402
from pathforge.core import (PathParams, audit_path, forge_path,  # noqa: E402
                            layered_path, spiral_path, wall_radii)
from pathforge.exporters import (gcode_text, svg_text, write_csv,  # noqa: E402
                                 write_gcode, write_manifest, write_svg)


# --------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def result():
    return forge(Params(family="helix", layers=60, samples=48, bore=0.45))


@pytest.fixture(scope="module")
def path(result):
    return forge_path(result)


# ------------------------------------------------------------ continuity
def test_spiral_is_one_continuous_bead(path):
    a = path.audit
    assert a["seams"] == 0
    assert a["travel_moves"] == 0
    assert a["continuous"] is True
    assert a["monotonic_z"] is True
    assert a["pass"] is True


def test_z_never_backtracks(path):
    zs = [p[2] for p in path.points]
    assert all(zs[i + 1] >= zs[i] - 1e-9 for i in range(len(zs) - 1))
    assert zs[0] == 0.0


def test_every_layer_is_traversed(path):
    assert path.audit["layers_traversed"] == 60
    # the path climbs essentially the whole build height
    assert path.audit["z_span_mm"] == pytest.approx(
        path.stats["height_mm"], rel=0.02)


def test_turns_match_the_layer_count(path):
    assert path.audit["turns"] == pytest.approx(60.0, rel=0.01)
    assert path.audit["turns_per_layer"] == pytest.approx(1.0, abs=0.01)


def test_control_is_rejected(path, result):
    """The ring-per-layer control must FAIL the continuity audit."""
    a = path.audit
    assert a["control"] is not None
    control = a["control"]
    assert control["travel_moves"] >= 60
    assert control["seams"] >= 60
    assert control["continuous"] is False
    assert control["pass"] is False
    # and the control object agrees with its own audit
    layered = layered_path(result)
    assert layered.audit["pass"] is False
    assert layered.audit["seams"] >= 60
    # the control breaks continuity two ways: travels, and a Z-hop that must
    # come back down
    assert layered.audit["monotonic_z"] is False


def test_audit_can_fail_on_a_broken_path(path):
    """Teleport one point: the audit must notice a seam."""
    pts = list(path.points)
    x, y, z = pts[500]
    pts[500] = (x + 40.0, y, z)                      # a jump, extruder still on
    a = audit_path(pts, path.extruding, layers=60,
                   pitch_mm=path.stats["height_mm"] / 59,
                   params=path.params)
    assert a["seams"] >= 1
    assert a["continuous"] is False
    assert a["pass"] is False


def test_audit_rejects_a_path_that_goes_downhill(path):
    pts = list(path.points)
    pts[900] = (pts[900][0], pts[900][1], pts[900][2] - 5.0)
    a = audit_path(pts, path.extruding, layers=60,
                   pitch_mm=path.stats["height_mm"] / 59,
                   params=path.params)
    assert a["monotonic_z"] is False
    assert a["pass"] is False


# --------------------------------------------------------------- geometry
def test_path_rides_inside_the_wall(path, result):
    walls = wall_radii(result)
    by_layer: dict[int, list[float]] = {}
    for (x, y, _), lay in zip(path.points, path.layer_of):
        by_layer.setdefault(lay, []).append(math.hypot(x, y))
    for lay, radii in by_layer.items():
        outer, ri = walls[lay]
        mean_path = sum(radii) / len(radii)
        outer_mean = sum(outer) / len(outer)
        assert ri - 1e-6 <= mean_path <= outer_mean + 1e-6, lay


def test_path_is_deterministic(result):
    a = forge_path(result).digest
    b = forge_path(result).digest
    assert a == b
    assert forge_path(forge(Params(family="ghost", layers=60, samples=48))).digest != a


# ---------------------------------------------------------------- exports
def _moves(text: str) -> list:
    """Extruding moves only (the travel-to-start line has no E)."""
    return [l for l in text.splitlines() if l.startswith("G1 X") and " E" in l]


def _final_e(text: str) -> float:
    mv = _moves(text)
    return float(mv[-1].split("E")[1]) if mv else 0.0


def test_gcode_is_well_formed(path):
    text = gcode_text(path)
    lines = text.splitlines()
    assert lines[0].startswith("; OLVR PathForge")
    assert "G21" in text and "G90" in text and "G92 E0" in text
    assert "; rule: always match the differentiate" in text
    assert "NaN" not in text and "inf" not in text.lower().replace("info", "")
    moves = _moves(text)
    assert len(moves) == len(path.points) - 1
    # extrusion never runs backwards
    es = [float(l.split("E")[1]) for l in moves]
    assert all(es[i + 1] >= es[i] - 1e-9 for i in range(len(es) - 1))
    assert es[0] > 0.0
    assert lines[-1] == "M84 ; motors off"


def test_gcode_filament_matches_the_stats(path):
    text = gcode_text(path)
    assert _final_e(text) == pytest.approx(path.stats["filament_mm"], rel=0.01)


def test_decimation_shrinks_the_file_but_not_the_material(path):
    full = gcode_text(path)
    thin = gcode_text(path, decimate=4)
    moves_full, moves_thin = len(_moves(full)), len(_moves(thin))
    assert moves_thin < moves_full / 3
    assert _final_e(thin) == pytest.approx(_final_e(full), rel=1e-6)


def test_manifest_records_brand_rule_audit_and_control(path, tmp_path):
    doc = json.loads(write_manifest(path, tmp_path / "p.json").read_text())
    assert doc["brand"] == "OLVR"
    assert doc["rule"] == "always match the differentiate"
    assert doc["generator"] == "PathForge 1.0"
    assert doc["audit"]["pass"] is True
    assert doc["audit"]["control"]["pass"] is False
    assert doc["source"]["module"] == "MeshForge"
    assert doc["source"]["mesh_audit_pass"] is True
    assert 1 < len(doc["preview"]) <= 2001
    assert all(len(row) == 3 for row in doc["preview"])


def test_csv_has_one_row_per_layer(path, tmp_path):
    text = write_csv(path, tmp_path / "p.csv").read_text().splitlines()
    assert len(text) == path.stats["layers"] + 1
    assert text[0].startswith("layer,z_mm,points,")
    assert len(text[1].split(",")) == 7


def test_svg_is_a_proof_sheet(path, tmp_path):
    doc = write_svg(path, tmp_path / "p.svg").read_text()
    assert doc.startswith("<svg") and doc.rstrip().endswith("</svg>")
    assert doc.count("<polyline") == 2           # plan view + unrolled
    assert "continuous=True" in doc
    assert "seams=0" in doc


# ----------------------------------------------------------------- params
def test_clamp_defends_the_machine():
    c = PathParams(nozzle_mm=9.0, width_mm=0.01, feedrate_mm_min=-5,
                   density_g_cm3=99, turns_per_layer=0).clamp()
    assert c.nozzle_mm == 1.2
    assert c.width_mm == pytest.approx(1.2 * 0.8)
    assert c.feedrate_mm_min == 60.0
    assert c.density_g_cm3 == 2.0
    assert c.turns_per_layer == 0.25
    assert PathParams(filament_mm=3.0).clamp().filament_mm == 2.85
    assert PathParams(filament_mm=1.7).clamp().filament_mm == 1.75


def test_stats_are_sane(path):
    s = path.stats
    assert s["path_length_mm"] > s["height_mm"]
    assert s["grams"] > 0 and s["est_minutes"] > 0
    assert 0 < s["radius_min_mm"] <= s["radius_max_mm"]


# ------------------------------------------------------------- end to end
def test_prompt_to_gcode_end_to_end(tmp_path):
    params = parse_prompt("Ghost, 240 layers, bore 40")
    p = forge_path(forge(params))
    assert p.audit["pass"] is True
    assert p.audit["layers_traversed"] == 240
    out = write_gcode(p, tmp_path / "ghost.gcode")
    assert out.stat().st_size > 10_000
    assert len(_moves(out.read_text())) == len(p.points) - 1


def test_cli_reports_a_continuous_bead():
    env = {"PATH": "/usr/bin:/bin:/usr/local/bin", "PYTHONPATH": str(ROOT),
           "HOME": str(Path.home())}
    proc = subprocess.run(
        [sys.executable, "-m", "pathforge", "audit", "Helix, 80 layers"],
        cwd=str(ROOT), capture_output=True, text=True, env=env, timeout=300)
    assert proc.returncode == 0, proc.stderr
    assert "PASS" in proc.stdout
    assert "seams" in proc.stdout
