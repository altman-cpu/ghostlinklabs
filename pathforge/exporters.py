"""PathForge exporters — gcode, JSON manifest, SVG proof sheet.

Decimation is an *export* concern only: the audit always runs on the full
path, and a decimated file still pushes exactly the same total filament
(cumulative E is sampled, not recomputed from the shorter move list).
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import List, Sequence, Tuple

from .core import ToolPath

_POINTS = Sequence[Tuple[float, float, float]]


def bead_height(path: ToolPath) -> float:
    """Bead height actually used: override, else the mesh's layer height."""
    return path.params.layer_height_mm or path.stats["bead_height_mm"]


def _filament_curve(path: ToolPath) -> List[float]:
    """Cumulative filament (mm) at every point of the full path."""
    pp = path.params
    lh = bead_height(path)
    area = math.pi * (pp.filament_mm / 2.0) ** 2
    cum = [0.0]
    for k in range(1, len(path.points)):
        d = math.dist(path.points[k - 1], path.points[k])
        cum.append(cum[-1] + d * pp.width_mm * lh / area)
    return cum


def _emit_indices(n: int, decimate: int) -> List[int]:
    step = max(1, int(decimate))
    idx = list(range(0, n, step))
    if idx and idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


# ---------------------------------------------------------------------- gcode
def gcode_text(path: ToolPath, *, decimate: int = 1) -> str:
    pp = path.params
    a, st = path.audit, path.stats
    pts = path.points
    cum = _filament_curve(path)
    idx = _emit_indices(len(pts), decimate)
    lh = bead_height(path)
    top = pts[-1][2]

    out: List[str] = []
    add = out.append
    add("; OLVR PathForge 1.0 — spiral toolpath")
    add("; rule: always match the differentiate")
    add(f"; source: MeshForge {st['family']} {st['layers']}L x {st['samples']}P"
        f" gid {path.source['gid'][:12]} digest {path.source['digest'][:16]}")
    add(f"; path digest: {path.digest[:24]}")
    add(f"; audit: continuous={a['continuous']} seams={a['seams']} "
        f"travel_moves={a['travel_moves']} monotonic_z={a['monotonic_z']} "
        f"layers={a['layers_traversed']}/{st['layers']} turns={a['turns']} "
        f"pass={a['pass']}")
    if a.get("control"):
        c = a["control"]
        add(f"; control (ring-per-layer): continuous={c['continuous']} "
            f"seams={c['seams']} travel_moves={c['travel_moves']} pass={c['pass']}")
    add(f"; stats: {st['path_length_m']} m of bead, {st['filament_m']} m filament, "
        f"{st['grams']} g, ~{st['est_minutes']} min at {pp.feedrate_mm_min:.0f} mm/min")
    add(f"; bead: {pp.width_mm:.2f} mm wide x {lh:.3f} mm high, "
        f"nozzle {pp.nozzle_mm:.2f} mm")
    if decimate > 1:
        add(f"; decimated 1:{decimate} for file size "
            f"({len(idx)} of {len(pts)} moves)")
    add("G21 ; millimetres")
    add("G90 ; absolute positioning")
    add("M82 ; absolute extrusion")
    add("G92 E0 ; zero the extruder")
    add(f"M104 S{pp.hotend_c} ; hotend")
    add(f"M140 S{pp.bed_c} ; bed")
    add(f"M109 S{pp.hotend_c} ; wait hotend")
    add(f"M190 S{pp.bed_c} ; wait bed")
    if pp.fan_percent:
        add(f"M106 S{int(255 * pp.fan_percent / 100)} ; fan")
    else:
        add("M107 ; fan off")
    add(f"G1 Z{top + 5.0:.3f} F600 ; safe height")
    add(f"G1 X{pts[0][0]:.3f} Y{pts[0][1]:.3f} F{pp.travel_feedrate_mm_min:.0f} "
        f"; travel to start")
    add(f"G1 Z{pts[0][2]:.3f} F600 ; descend")
    add("; ---- spiral: one bead, no travel, no retract ----")
    add(f"G1 F{pp.feedrate_mm_min:.0f}")
    prev_layer = -1
    for k in idx:
        if k == idx[0]:
            continue                      # already there
        x, y, z = pts[k]
        lay = path.layer_of[k]
        if lay != prev_layer and lay % 100 == 0 and lay:
            add(f"; layer {lay} of {st['layers']}  z={z:.3f}")
        prev_layer = lay
        add(f"G1 X{x:.3f} Y{y:.3f} Z{z:.4f} E{cum[k]:.5f}")
    add("; ---- end ----")
    if pp.retract_mm:
        add(f"G1 E{cum[idx[-1]] - pp.retract_mm:.5f} F1800 ; retract")
    add("M107 ; fan off")
    add(f"G1 Z{top + 10.0:.3f} F600 ; lift clear")
    add("M84 ; motors off")
    return "\n".join(out) + "\n"


def write_gcode(path: ToolPath, out: Path, *, decimate: int = 1) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(gcode_text(path, decimate=decimate), encoding="utf-8")
    return out


# ----------------------------------------------------------------------- json
def write_manifest(path: ToolPath, out: Path) -> Path:
    import json
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(path.manifest(), indent=1), encoding="utf-8")
    return out


def write_csv(path: ToolPath, out: Path) -> Path:
    """One row per layer: entry point, radius range, bead length, filament."""
    pp = path.params
    rows = ["layer,z_mm,points,r_min_mm,r_max_mm,bead_mm,filament_mm"]
    lh = pp.layer_height_mm or path.stats["bead_height_mm"]
    area = math.pi * (pp.filament_mm / 2.0) ** 2
    i = 0
    n = len(path.points)
    while i < n:
        lay = path.layer_of[i]
        j = i
        bead = 0.0
        rmin = rmax = math.hypot(path.points[i][0], path.points[i][1])
        while j + 1 < n:
            bead += math.dist(path.points[j], path.points[j + 1])
            r = math.hypot(path.points[j][0], path.points[j][1])
            rmin, rmax = min(rmin, r), max(rmax, r)
            if path.layer_of[j + 1] != lay:
                break
            j += 1
        rows.append(f"{lay},{path.points[i][2]:.4f},{j - i + 1},"
                    f"{rmin:.3f},{rmax:.3f},{bead:.3f},{bead * pp.width_mm * lh / area:.4f}")
        i = j + 1
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return out


# ------------------------------------------------------------------------ svg
def svg_text(path: ToolPath, *, width: int = 1200, height: int = 560,
             cap: int = 6000) -> str:
    """Two panels: the path from above, and the same path unrolled.

    The unrolled panel is the honest picture of a spiral: 1000 layers of a
    helix become 1000 continuous diagonal strokes with no vertical jumps.
    """
    pts = path.points
    step = max(1, math.ceil(len(pts) / cap))
    sample = pts[::step]
    a, st = path.audit, path.stats

    def polyline(seq, ox, oy, w, h, pad=14):
        xs = [p[0] for p in seq]
        ys = [p[1] for p in seq]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        sx = (w - 2 * pad) / max(x1 - x0, 1e-6)
        sy = (h - 2 * pad) / max(y1 - y0, 1e-6)
        s = min(sx, sy)
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        d = " ".join(
            f"{ox + w / 2 + (x - cx) * s:.2f},{oy + h / 2 - (y - cy) * s:.2f}"
            for x, y in seq)
        return f'<polyline points="{d}" fill="none" stroke="#4fd6c4" ' \
               f'stroke-width="1.1" stroke-opacity="0.92"/>'

    top = [(p[0], p[1]) for p in sample]
    turns = a["turns"]
    unrolled = [(i * step / max(len(pts) - 1, 1) * turns, p[2]) for i, p in enumerate(sample)]

    half = width // 2 - 20
    body = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="monospace">',
        f'<rect width="{width}" height="{height}" fill="#0e1116"/>',
        f'<text x="16" y="26" fill="#8ea0b5" font-size="14">OLVR PathForge — '
        f'{st["family"]} · {st["layers"]}L × {st["samples"]}P · spiral</text>',
        f'<text x="16" y="{height - 12}" fill="#8ea0b5" font-size="12">'
        f'continuous={a["continuous"]}  seams={a["seams"]}  travel={a["travel_moves"]}  '
        f'monotonic_z={a["monotonic_z"]}  turns={a["turns"]}  '
        f'layers={a["layers_traversed"]}/{st["layers"]}  '
        f'{st["path_length_m"]} m  {st["grams"]} g</text>',
        f'<text x="{width // 2 + 10}" y="26" fill="#8ea0b5" font-size="12">'
        f'unrolled: {turns:.1f} turns of bead, no vertical jumps</text>',
        polyline(top, 0, 40, half, height - 80),
        polyline(unrolled, width // 2, 40, half, height - 80),
        f'<line x1="{width // 2}" y1="20" x2="{width // 2}" y2="{height - 20}" '
        f'stroke="#2a3340"/>',
        "</svg>",
    ]
    return "\n".join(body) + "\n"


def write_svg(path: ToolPath, out: Path, **kw) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg_text(path, **kw), encoding="utf-8")
    return out


def stamp_filename(path: ToolPath, ext: str) -> str:
    st = path.stats
    return (f"{st['family']}_{st['layers']}L_{st['samples']}P_path_"
            f"{path.digest[:8]}.{ext}")
