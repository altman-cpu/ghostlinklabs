"""Layer stack construction.

The stack is a closed surface of revolution whose radius changes on *both*
axes: around the section (θ) and up the build (u). Layer ``i`` is

    r_i(θ) = F(u_i, θ)                                   continuous field
           + D · [F(u_i+δ, θ) − F(u_i−δ, θ)]             its own derivative
           + glyph_i · ripple(θ)                          its own identity

where ``δ`` spans three layers either side and ``D`` is the differentiation
coupling. Nothing is copied, and nothing is scaled: skipping any layer loses
information that no other layer carries.

A stack can be solid or hollow. Hollow stacks are still watertight: an inner
annulus is lofted the same way, the top cap is an annulus, and the bottom cap
gets a bore opening. Every edge is then checked for exactly two incident
triangles before the result is declared printable.
"""
from __future__ import annotations

import math
from array import array
from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple

from .differentiator import Glyph, audit_layers, digest, glyph, signature, stamp
from .fields import Params, clamp_params, field_spec, sample_field

TAU = math.tau
BORE_EDGE = 0.06  # visual keel between outer wall and bore on the bottom cap


@dataclass
class Mesh:
    positions: array
    normals: array
    indices: array
    colors: array          # RGBA bytes, per vertex
    triangles: int = 0
    vertices: int = 0
    volume_mm3: float = 0.0
    surface_mm2: float = 0.0
    watertight: bool = False
    open_edges: int = 0
    hollow: bool = False

    def bounds(self) -> Tuple[Tuple[float, float, float], Tuple[float, float, float]]:
        p = self.positions
        return (
            (min(p[0::3]), min(p[1::3]), min(p[2::3])),
            (max(p[0::3]), max(p[1::3]), max(p[2::3])),
        )


@dataclass
class ForgeResult:
    params: Params
    mesh: Mesh
    layers: List[dict]
    audit: dict
    stats: dict
    gid: str
    digest: str

    def manifest(self) -> dict:
        return {
            "generator": "MeshForge 1.0",
            "rule": "always match the differentiate",
            "id": self.gid,
            "digest": self.digest,
            "params": self.params.to_dict(),
            "stats": self.stats,
            "audit": self.audit,
            "layers": self.layers,
        }


# --------------------------------------------------------------------------
# profiles
# --------------------------------------------------------------------------
def _ring_radii(u: float, outer, m: float, p: Params, g: Glyph) -> List[float]:
    """One cross-section: field + derivative dressing + glyph identity."""
    k = float(p.lobes)
    d = p.differentiation
    delta = 3.0 / max(p.layers - 1, 3)
    u0 = min(max(u, 0.0), 1.0)
    u_lo = max(u0 - delta, 0.0)
    u_hi = min(u0 + delta, 1.0)
    span = max(u_hi - u_lo, 1e-9)
    twist = g.twist_offset
    out: List[float] = []
    for j in range(p.samples):
        theta = TAU * j / p.samples
        th = theta + twist
        f0 = outer(u0, th)
        if d:
            trend = (outer(u_hi, th) - outer(u_lo, th)) / span
            f0 = f0 + d * trend * 0.0016 * (0.7 + 0.3 * abs(g.wave))
        ripple = 0.0030 * g.wave * math.cos(3.0 * k * theta + 2.1 * g.phase * 6.3)
        dev = (f0 - 1.0) * g.amp_scale + ripple + 0.0012 * g.drift * math.sin(theta * 2.0)
        out.append(max((1.0 + dev) * m, 1e-3))
    return out


def _layer_u(i: int, n: int) -> float:
    return i / (n - 1) if n > 1 else 0.0


def build_layer_profiles(p: Params) -> Tuple[List[List[float]], List[Glyph]]:
    outer, _ = sample_field(p)
    glyphs = [glyph(p.family, i, p.seed, p.layers) for i in range(p.layers)]
    profiles = [_ring_radii(_layer_u(i, p.layers) + g.phase, outer, p.radius_mm, p, g)
                for i, g in enumerate(glyphs)]
    return profiles, glyphs


def _bore_radius(rm: float, p: Params, g: Glyph) -> float:
    """Inner wall radius for one layer — carries its own glyph, always inside."""
    if p.bore <= 0.0:
        return 0.0
    wobble = 0.055 * g.wave * rm
    r = p.bore * p.radius_mm * g.amp_scale + wobble
    ceiling = 0.80 * rm
    return max(0.0, min(r, ceiling))


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------
def _hsv(h: float, s: float, v: float) -> Tuple[float, float, float]:
    h = h % 1.0
    i = int(h * 6.0)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i % 6]


# A designed ramp runs the height (deep teal -> mint -> amber). Each layer
# nudges it by its own glyph hash, so colour still encodes layer identity —
# two congruent layers would land on exactly the same colour.
RAMP = ((0.00, 0.505, 0.62, 0.30), (0.42, 0.415, 0.74, 0.62), (0.72, 0.29, 0.82, 0.60),
        (1.00, 0.105, 0.72, 0.55))


def ramp(t: float) -> Tuple[float, float, float]:
    t = min(max(t, 0.0), 1.0)
    for k in range(len(RAMP) - 1):
        a, b = RAMP[k], RAMP[k + 1]
        if a[0] <= t <= b[0]:
            f = (t - a[0]) / max(b[0] - a[0], 1e-9)
            f = f * f * (3.0 - 2.0 * f)          # smoothstep
            return (a[1] + (b[1] - a[1]) * f,
                    a[2] + (b[2] - a[2]) * f,
                    a[3] + (b[3] - a[3]) * f)
    return RAMP[-1][1:]


def _layer_color(i: int, n: int, tag: str) -> Tuple[int, int, int]:
    t = i / (n - 1) if n > 1 else 0.0
    h, s, v = ramp(t)
    jitter = (int(tag, 16) % 1000) / 1000.0 - 0.5     # -0.5 .. 0.5
    h = (h + jitter * 0.030) % 1.0
    s = min(1.0, max(0.0, s + jitter * 0.10))
    v = min(1.0, max(0.0, v + jitter * 0.07))
    r, g, b = _hsv(h, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


# --------------------------------------------------------------------------
# mesh
# --------------------------------------------------------------------------
def build_mesh(p: Params, profiles: Sequence[Sequence[float]], glyphs: Sequence[Glyph]) -> Mesh:
    n = len(profiles)
    s = p.samples
    hollow = p.bore > 0.0
    zs = [p.ring_z(i) for i in range(n)]

    positions = array("f")
    colors = array("B")
    indices = array("I")

    # ---- outer shell ---------------------------------------------------
    outer_start: List[int] = []
    for i, radii in enumerate(profiles):
        outer_start.append(len(positions) // 3)
        cr, cg, cb = _layer_color(i, n, glyphs[i].tag)
        z = zs[i]
        for j in range(s):
            th = TAU * j / s
            r = radii[j]
            positions.extend((r * math.cos(th), r * math.sin(th), z))
            colors.extend((cr, cg, cb, 255))

    for i in range(n - 1):
        a0, b0 = outer_start[i], outer_start[i + 1]
        for j in range(s):
            j2 = (j + 1) % s
            indices.extend((a0 + j, a0 + j2, b0 + j2, a0 + j, b0 + j2, b0 + j))

    # ---- inner shell ---------------------------------------------------
    inner_start: List[int] | None = None
    if hollow:
        inner_start = []
        for i in range(n):
            rm = sum(profiles[i]) / s
            ri = _bore_radius(rm, p, glyphs[i])
            inner_start.append(len(positions) // 3)
            cr, cg, cb = _layer_color(i, n, glyphs[i].tag)
            dk = (int(cr * 0.42), int(cg * 0.42), int(cb * 0.42))
            z = zs[i]
            for j in range(s):
                th = TAU * j / s
                positions.extend((ri * math.cos(th), ri * math.sin(th), z))
                colors.extend((*dk, 255))
        for i in range(n - 1):
            a0, b0 = inner_start[i], inner_start[i + 1]
            for j in range(s):
                j2 = (j + 1) % s
                # reversed winding: the inner wall faces the bore
                indices.extend((a0 + j2, a0 + j, b0 + j, a0 + j2, b0 + j, b0 + j2))

    # ---- caps ----------------------------------------------------------
    if hollow:
        # annulus at the top between outer and inner rings
        o, inn = outer_start[-1], inner_start[-1]  # type: ignore[index]
        for j in range(s):
            j2 = (j + 1) % s
            indices.extend((o + j, inn + j, inn + j2, o + j, inn + j2, o + j2))
        # bottom: outer wall -> keel -> bore opening
        o, inn = outer_start[0], inner_start[0]  # type: ignore[index]
        keel = len(positions) // 3
        for j in range(s):
            th = TAU * j / s
            ri = _bore_radius(sum(profiles[0]) / s, p, glyphs[0])
            r = ri + BORE_EDGE * (p.radius_mm - ri)
            positions.extend((r * math.cos(th), r * math.sin(th), 0.0))
            colors.extend((70, 74, 88, 255))
        for j in range(s):
            j2 = (j + 1) % s
            indices.extend((o + j2, o + j, keel + j, o + j2, keel + j, keel + j2))
            indices.extend((keel + j2, keel + j, inn + j, keel + j2, inn + j, inn + j2))
    else:
        # solid: centre-fan caps at both ends
        centers = []
        for i in (0, n - 1):
            centers.append(len(positions) // 3)
            cr, cg, cb = _layer_color(i, n, glyphs[i].tag)
            positions.extend((0.0, 0.0, zs[i]))
            colors.extend((int(cr * 0.55), int(cg * 0.55), int(cb * 0.55), 255))
        bot, top = centers
        ring_bot, ring_top = outer_start[0], outer_start[-1]
        for j in range(s):
            j2 = (j + 1) % s
            indices.extend((ring_bot + j, ring_bot + j2, bot))
            indices.extend((ring_top + j2, ring_top + j, top))

    mesh = Mesh(positions=positions, colors=colors, indices=indices, normals=array("f"),
                hollow=hollow)
    orient_positive(mesh)
    compute_normals(mesh)
    mesh.vertices = len(positions) // 3
    mesh.triangles = len(indices) // 3
    mesh.volume_mm3 = volume(mesh)
    mesh.surface_mm2 = surface_area(mesh)
    mesh.open_edges = open_edge_count(mesh)
    mesh.watertight = mesh.open_edges == 0
    return mesh


# --------------------------------------------------------------------------
# utilities
# --------------------------------------------------------------------------
def _tri_volume(p: array, vi: int, vj: int, vk: int) -> float:
    """Signed volume of the tetrahedron (origin, v_i, v_j, v_k)."""
    a, b, c = 3 * vi, 3 * vj, 3 * vk
    ax, ay, az = p[a], p[a + 1], p[a + 2]
    bx, by, bz = p[b], p[b + 1], p[b + 2]
    cx, cy, cz = p[c], p[c + 1], p[c + 2]
    return (ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx)) / 6.0


def volume(mesh: Mesh) -> float:
    idx = mesh.indices
    return sum(_tri_volume(mesh.positions, idx[t], idx[t + 1], idx[t + 2])
               for t in range(0, len(idx), 3))


def orient_positive(mesh: Mesh) -> None:
    if volume(mesh) < 0:
        idx = mesh.indices
        for t in range(0, len(idx), 3):
            idx[t + 1], idx[t + 2] = idx[t + 2], idx[t + 1]


def compute_normals(mesh: Mesh) -> None:
    pos, idx = mesh.positions, mesh.indices
    acc = array("f", bytes(4 * len(pos)))
    for t in range(0, len(idx), 3):
        i0, i1, i2 = idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3
        ax, ay, az = pos[i0], pos[i0 + 1], pos[i0 + 2]
        ux, uy, uz = pos[i1] - ax, pos[i1 + 1] - ay, pos[i1 + 2] - az
        vx, vy, vz = pos[i2] - ax, pos[i2 + 1] - ay, pos[i2 + 2] - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        for k in (i0, i1, i2):
            acc[k] += nx
            acc[k + 1] += ny
            acc[k + 2] += nz
    normals = array("f")
    for k in range(0, len(pos), 3):
        nx, ny, nz = acc[k], acc[k + 1], acc[k + 2]
        ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        normals.extend((nx / ln, ny / ln, nz / ln))
    mesh.normals = normals


def surface_area(mesh: Mesh) -> float:
    pos, idx = mesh.positions, mesh.indices
    total = 0.0
    for t in range(0, len(idx), 3):
        i0, i1, i2 = idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3
        ux, uy, uz = pos[i1] - pos[i0], pos[i1 + 1] - pos[i0 + 1], pos[i1 + 2] - pos[i0 + 2]
        vx, vy, vz = pos[i2] - pos[i0], pos[i2 + 1] - pos[i0 + 1], pos[i2 + 2] - pos[i0 + 2]
        cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        total += 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)
    return total


def open_edge_count(mesh: Mesh) -> int:
    """Count edges with exactly one incident triangle (0 => watertight)."""
    idx = mesh.indices
    edges: Dict[Tuple[int, int], int] = {}
    for t in range(0, len(idx), 3):
        a, b, c = idx[t], idx[t + 1], idx[t + 2]
        for e in ((a, b), (b, c), (c, a)):
            key = e if e[0] < e[1] else (e[1], e[0])
            edges[key] = edges.get(key, 0) + 1
    return sum(1 for v in edges.values() if v != 2)


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------
def forge(params: Params | None = None, prompt: str = "") -> ForgeResult:
    from .prompts import parse_prompt

    if params is None:
        params = parse_prompt(prompt) if prompt else Params()
    p = clamp_params(params)

    profiles, glyphs = build_layer_profiles(p)
    mesh = build_mesh(p, profiles, glyphs)

    sigs: List[Tuple[float, ...]] = []
    layer_rows: List[dict] = []
    for i, (radii, g) in enumerate(zip(profiles, glyphs)):
        sig = signature(radii)
        sigs.append(sig)
        layer_rows.append({
            "i": i,
            "z": round(p.ring_z(i), 4),
            "u": round(_layer_u(i, p.layers), 6),
            "r_mean": round(sum(radii) / len(radii), 4),
            "r_min": round(min(radii), 4),
            "r_max": round(max(radii), 4),
            "digest": digest(radii),
            **g.to_dict(),
            "sig": [round(x, 6) for x in sig],
        })

    audit = audit_layers(
        sigs,
        [row["digest"] for row in layer_rows],
        baseline_unique=1,
        differentiation=p.differentiation,
    )
    audit["watertight"] = mesh.watertight
    audit["open_edges"] = mesh.open_edges

    gid = stamp(f"{p.to_dict()}|{mesh.vertices}|{mesh.triangles}")
    fam = field_spec(p)
    stats = {
        "family": fam.label,
        "layers": p.layers,
        "samples": p.samples,
        "vertices": mesh.vertices,
        "triangles": mesh.triangles,
        "height_mm": round(p.height_mm, 3),
        "diameter_mm": round(2 * p.radius_mm, 3),
        "layer_height_mm": p.layer_height_mm,
        "layer_pitch_mm": round(p.pitch_mm, 6),
        "volume_cm3": round(mesh.volume_mm3 / 1000.0, 4),
        "surface_cm2": round(mesh.surface_mm2 / 100.0, 3),
        "hollow": mesh.hollow,
        "watertight": mesh.watertight,
        "filament_m": round(mesh.volume_mm3 / 2.405 / 1000.0, 2),
    }
    return ForgeResult(
        params=p, mesh=mesh, layers=layer_rows, audit=audit, stats=stats,
        gid=gid,
        digest=stamp(",".join(r["digest"] for r in layer_rows)),
    )
