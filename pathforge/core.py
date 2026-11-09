"""PathForge core — one continuous toolpath through a forged mesh.

MeshForge proves every *slice* of a 1000-layer mesh is its own shape.
PathForge proves the *path that prints it* is one unbroken bead:

    a spiral toolpath never lifts, never travels, never backtracks in Z,
    and visits all 1000 layers.

The proof is the same shape as MeshForge's: an audit that **can** fail, with a
layered (ring-per-layer, travel-between-rings) control build reported beside it.
An audit that can never fail proves nothing.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import List, Optional, Sequence, Tuple

from meshforge.differentiator import stamp
from meshforge.layerstack import ForgeResult, _bore_radius

TAU = math.tau

#: A move longer than this (or any move with the extruder off) is a seam.
SEAM_EPS_MM = 1.5


# --------------------------------------------------------------------- params
@dataclass
class PathParams:
    """Machine + bead settings. Everything has a sane, clampable default."""

    nozzle_mm: float = 0.4
    width_mm: float = 0.45          # extrusion width
    layer_height_mm: float = 0.0    # 0 -> inherit the mesh's layer height
    filament_mm: float = 1.75
    feedrate_mm_min: float = 900.0
    travel_feedrate_mm_min: float = 3000.0
    density_g_cm3: float = 1.24     # PLA
    turns_per_layer: float = 1.0
    seam_eps_mm: float = SEAM_EPS_MM
    z_hop_mm: float = 0.4
    hotend_c: int = 205
    bed_c: int = 60
    fan_percent: int = 100
    retract_mm: float = 2.0

    def clamp(self) -> "PathParams":
        c = replace(self)
        c.nozzle_mm = _clamp(c.nozzle_mm, 0.1, 1.2)
        c.width_mm = _clamp(c.width_mm, c.nozzle_mm * 0.8, c.nozzle_mm * 3.0)
        c.layer_height_mm = (0.0 if not c.layer_height_mm
                             else _clamp(c.layer_height_mm, 0.02, 1.2))
        c.filament_mm = 1.75 if c.filament_mm < 2.0 else 2.85
        c.feedrate_mm_min = _clamp(c.feedrate_mm_min, 60.0, 6000.0)
        c.travel_feedrate_mm_min = _clamp(c.travel_feedrate_mm_min, 60.0, 12000.0)
        c.density_g_cm3 = _clamp(c.density_g_cm3, 0.80, 2.00)
        c.turns_per_layer = _clamp(c.turns_per_layer, 0.25, 4.0)
        c.seam_eps_mm = _clamp(c.seam_eps_mm, 0.05, 50.0)
        c.z_hop_mm = _clamp(c.z_hop_mm, 0.0, 5.0)
        c.hotend_c = int(_clamp(c.hotend_c, 150, 320))
        c.bed_c = int(_clamp(c.bed_c, 0, 130))
        c.fan_percent = int(_clamp(c.fan_percent, 0, 100))
        c.retract_mm = _clamp(c.retract_mm, 0.0, 10.0)
        return c

    def to_dict(self) -> dict:
        return dict(self.__dict__)


def _clamp(v: float, lo: float, hi: float) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return lo
    if math.isnan(v) or math.isinf(v):
        return lo
    return max(lo, min(hi, v))


# ------------------------------------------------------------------ toolpath
@dataclass
class ToolPath:
    params: PathParams
    source: dict                       # what it was cut from
    points: List[Tuple[float, float, float]]
    extruding: List[bool]              # False = travel, extruder off
    layer_of: List[int]
    audit: dict
    stats: dict
    digest: str

    def manifest(self) -> dict:
        return {
            "generator": "PathForge 1.0",
            "brand": "OLVR",
            "rule": "always match the differentiate",
            "source": self.source,
            "params": self.params.to_dict(),
            "audit": self.audit,
            "stats": self.stats,
            "digest": self.digest,
            "preview": _preview(self.points),
        }

    @property
    def length_mm(self) -> float:
        return float(self.stats["path_length_mm"])


def _preview(points: Sequence[Tuple[float, float, float]], cap: int = 2000) -> List[list]:
    """A downsampled polyline so a manifest stays readable (and previewable)."""
    n = len(points)
    step = max(1, math.ceil(n / cap))
    return [[round(x, 3), round(y, 3), round(z, 4)]
            for x, y, z in points[::step]]


# ------------------------------------------------------------------ geometry
def wall_radii(result: ForgeResult) -> List[Tuple[List[float], float]]:
    """(outer radii, bore radius) per layer — the band the nozzle rides in."""
    p = result.params
    out: List[Tuple[List[float], float]] = []
    for i, radii in enumerate(result.profiles):
        rm = sum(radii) / len(radii)
        g = result.glyphs[i] if result.glyphs else None
        ri = _bore_radius(rm, p, g) if g is not None else 0.0
        out.append((list(radii), ri))
    return out


def spiral_path(result: ForgeResult, params: Optional[PathParams] = None) -> ToolPath:
    """One continuous bead: the nozzle never stops, never lifts, never backs up.

    Step ``k`` sits at turn ``k / samples`` and at height ``(k / samples) * pitch``,
    so the tool travels a true helix while the radius keeps reading the forged
    field. There is no seam, by construction.
    """
    pp = (params or PathParams()).clamp()
    p = result.params
    n, s = p.layers, p.samples
    pitch = p.pitch_mm
    walls = wall_radii(result)

    points: List[Tuple[float, float, float]] = []
    extruding: List[bool] = []
    layer_of: List[int] = []
    for i in range(n):
        radii, ri = walls[i]
        for j in range(s):
            f = (i + j / s) * pp.turns_per_layer
            th = TAU * f
            ro = radii[j]
            r = (ro + ri) / 2.0 if ri > 0.0 else ro      # ride the mid-wall
            points.append((r * math.cos(th), r * math.sin(th), (i + j / s) * pitch))
            extruding.append(True)
            layer_of.append(i)

    return _finish(points, extruding, layer_of, result, pp, control=_layered_payload(
        result, pp))


def layered_path(result: ForgeResult, params: Optional[PathParams] = None) -> ToolPath:
    """The control: closed ring per layer with a travel move between layers.

    This is how a normal (non-spiral) slicer would print it, and it is exactly
    what the audit is supposed to reject: ``travel_moves > 0`` and seams at
    every layer change.
    """
    pp = (params or PathParams()).clamp()
    p = result.params
    n, s = p.layers, p.samples
    pitch = p.pitch_mm
    walls = wall_radii(result)

    points: List[Tuple[float, float, float]] = []
    extruding: List[bool] = []
    layer_of: List[int] = []
    for i in range(n):
        radii, ri = walls[i]
        for j in range(s + 1):                      # +1 closes the ring
            jj = j % s
            th = TAU * jj / s
            ro = radii[jj]
            r = (ro + ri) / 2.0 if ri > 0.0 else ro
            points.append((r * math.cos(th), r * math.sin(th), i * pitch))
            extruding.append(not (j == 0))           # arrive dry, then extrude
            layer_of.append(i)
        if i < n - 1:
            # travel: lift and move to the next ring's start
            points.append((points[-1][0], points[-1][1], (i + 1) * pitch + pp.z_hop_mm))
            extruding.append(False)
            layer_of.append(i + 1)

    return _finish(points, extruding, layer_of, result, pp, control=None)


# --------------------------------------------------------------------- audit
def audit_path(points, extruding, *, layers: int, pitch_mm: float,
               params: PathParams, control: Optional[dict] = None) -> dict:
    """Is this one unbroken bead? Every number here can fail."""
    pp = params
    n = len(points)
    if n < 2:
        return {"points": n, "pass": False, "match": {"rule": "continuous bead",
                                                      "pass": False}}

    seps = [_dist(points[k], points[k + 1]) for k in range(n - 1)]
    mean_step = sum(seps) / len(seps)
    # A seam is a break in the bead: the extruder shut off, or a jump out of
    # scale with the path's own step length (so fine meshes aren't false-flagged).
    eps = max(pp.seam_eps_mm, 6.0 * mean_step)
    seams = sum(1 for k in range(n - 1)
                if (not extruding[k + 1]) or seps[k] > eps)
    travel = sum(1 for e in extruding if not e)

    zs = [pt[2] for pt in points]
    monotone = all(zs[k + 1] >= zs[k] - 1e-9 for k in range(n - 1))
    turns = abs(_angular_travel(points)) / TAU
    bands = (len({math.floor(z / pitch_mm + 1e-9) for z in zs})
             if pitch_mm > 0 else 0)

    lh = pp.layer_height_mm or pitch_mm
    length = sum(seps)
    volume = length * pp.width_mm * lh          # extruded bead volume, mm^3
    filament = volume / (math.pi * (pp.filament_mm / 2.0) ** 2)

    passed = (seams == 0 and travel == 0 and monotone and bands >= layers * 0.99)
    return {
        "points": n,
        "seams": seams,
        "travel_moves": travel,
        "continuous": seams == 0,
        "monotonic_z": monotone,
        "layers_traversed": bands,
        "turns": round(turns, 3),
        "turns_per_layer": round(turns / max(layers, 1), 4),
        "z_span_mm": round(zs[-1] - zs[0], 4),
        "step_min_mm": round(min(seps), 5),
        "step_mean_mm": round(mean_step, 5),
        "step_max_mm": round(max(seps), 5),
        "seam_eps_mm": pp.seam_eps_mm,
        "seam_threshold_mm": round(eps, 4),
        "pass": passed,
        "match": {"rule": "one continuous bead, all layers, no travel",
                  "pass": passed},
        "baseline": "closed ring per layer with a travel move between rings",
        "control": control,
    }


def _angular_travel(points) -> float:
    total = 0.0
    prev = math.atan2(points[0][1], points[0][0])
    for k in range(1, len(points)):
        a = math.atan2(points[k][1], points[k][0])
        d = a - prev
        while d > math.pi:
            d -= TAU
        while d < -math.pi:
            d += TAU
        total += d
        prev = a
    return total


def _dist(a, b) -> float:
    return math.dist(a, b)


# --------------------------------------------------------------------- build
def _finish(points, extruding, layer_of, result: ForgeResult, pp: PathParams,
            control: Optional[dict]) -> ToolPath:
    p = result.params
    audit = audit_path(points, extruding, layers=p.layers, pitch_mm=p.pitch_mm,
                       params=pp, control=control)
    lh = pp.layer_height_mm or p.layer_height_mm
    length = audit["step_mean_mm"] * max(audit["points"] - 1, 0)
    volume = length * pp.width_mm * lh
    filament = volume / (math.pi * (pp.filament_mm / 2.0) ** 2)
    grams = volume / 1000.0 * pp.density_g_cm3
    stats = {
        "family": result.stats.get("family", p.family),
        "layers": p.layers,
        "samples": p.samples,
        "points": audit["points"],
        "path_length_mm": round(length, 2),
        "path_length_m": round(length / 1000.0, 3),
        "bead_width_mm": pp.width_mm,
        "bead_height_mm": round(lh, 4),
        "extruded_volume_cm3": round(volume / 1000.0, 3),
        "filament_m": round(filament / 1000.0, 2),
        "filament_mm": round(filament, 2),
        "grams": round(grams, 2),
        "feedrate_mm_min": pp.feedrate_mm_min,
        "est_minutes": round(length / pp.feedrate_mm_min, 1),
        "radius_min_mm": round(min(math.hypot(x, y) for x, y, _ in points), 3),
        "radius_max_mm": round(max(math.hypot(x, y) for x, y, _ in points), 3),
        "height_mm": round(p.height_mm, 3),
    }
    source = {
        "module": "MeshForge",
        "gid": result.gid,
        "digest": result.digest,
        "family": p.family,
        "layers": p.layers,
        "samples": p.samples,
        "hollow": bool(p.bore > 0.0),
        "mesh_audit_pass": result.audit.get("pass"),
    }
    dig = stamp("|".join(f"{x:.3f},{y:.3f},{z:.4f}"
                         for x, y, z in points[::97]) + f"|{len(points)}")
    return ToolPath(params=pp, source=source, points=points, extruding=extruding,
                    layer_of=layer_of, audit=audit, stats=stats, digest=dig)


def _layered_payload(result: ForgeResult, pp: PathParams) -> dict:
    """Run the control build and summarise it inside the real audit."""
    ctrl = layered_path(result, pp)
    a = ctrl.audit
    return {
        "points": a["points"],
        "seams": a["seams"],
        "travel_moves": a["travel_moves"],
        "continuous": a["continuous"],
        "monotonic_z": a["monotonic_z"],
        "pass": a["pass"],
        "note": "the same build sliced ring-by-ring; the audit must reject it",
    }


def forge_path(result: ForgeResult, params: Optional[PathParams] = None) -> ToolPath:
    """Cut the spiral toolpath for a forged mesh (audit + control included)."""
    return spiral_path(result, params)
