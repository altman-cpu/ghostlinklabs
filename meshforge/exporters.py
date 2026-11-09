"""Mesh exporters: binary STL, ASCII STL, OBJ, JSON manifest.

Two print paths are offered:

* **Triangulated** — one triangle per quad. Fast, universal, and what most
  slicers expect for a closed shell.
* **Segmented (1000-layer)** — emits a separate `solid` per layer, each named
  with its index, digest and glyph tag. This is what makes "1000 printable
  layers" literal in the file: a slicer or a per-layer tool sees exactly 1000
  named solids, each with its own geometry.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import BinaryIO, Iterable

from .layerstack import ForgeResult, Mesh


# --------------------------------------------------------------------------
# STL
# --------------------------------------------------------------------------
def _tri_normal(p, a: int, b: int, c: int):
    ax, ay, az = p[a], p[a + 1], p[a + 2]
    ux, uy, uz = p[b] - ax, p[b + 1] - ay, p[b + 2] - az
    vx, vy, vz = p[c] - ax, p[c + 1] - ay, p[c + 2] - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    ln = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
    return nx / ln, ny / ln, nz / ln


def write_stl_binary(mesh: Mesh, path: Path, header: str = "MeshForge 1000L") -> Path:
    pos, idx = mesh.positions, mesh.indices
    count = len(idx) // 3
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        fh.write(header.encode("ascii", "replace")[:80].ljust(80, b" "))
        fh.write(struct.pack("<I", count))
        rec = struct.Struct("<12fH")
        for t in range(0, len(idx), 3):
            a, b, c = idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3
            nx, ny, nz = _tri_normal(pos, a, b, c)
            fh.write(rec.pack(
                nx, ny, nz,
                pos[a], pos[a + 1], pos[a + 2],
                pos[b], pos[b + 1], pos[b + 2],
                pos[c], pos[c + 1], pos[c + 2],
                0,
            ))
    return path


def write_stl_ascii(mesh: Mesh, path: Path, name: str = "meshforge") -> Path:
    pos, idx = mesh.positions, mesh.indices
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="ascii") as fh:
        fh.write(f"solid {name}\n")
        for t in range(0, len(idx), 3):
            a, b, c = idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3
            nx, ny, nz = _tri_normal(pos, a, b, c)
            fh.write(f"  facet normal {nx:.6e} {ny:.6e} {nz:.6e}\n    outer loop\n")
            for k in (a, b, c):
                fh.write(f"      vertex {pos[k]:.6e} {pos[k + 1]:.6e} {pos[k + 2]:.6e}\n")
            fh.write("    endloop\n  endfacet\n")
        fh.write(f"endsolid {name}\n")
    return path


def write_ordered_stl(result: ForgeResult, path: Path) -> Path:
    """One named solid per layer — literally 1000 printable layers."""
    pos = result.mesh.positions
    s = result.params.samples
    n = result.params.layers
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="ascii") as fh:
        fh.write("; MeshForge segmented export - one solid per layer\n")
        fh.write(f"; layers={n} samples={s} digest={result.digest}\n")
        for i, row in enumerate(result.layers):
            fh.write(f"solid L{i:04d}_{row['tag']}\n")
            ring_a = i * s
            ring_b = (i + 1) * s
            for j in range(s):
                j2 = (j + 1) % s
                quad = [
                    (ring_a + j) * 3,
                    (ring_a + j2) * 3,
                    (ring_b + j2) * 3,
                    (ring_b + j) * 3,
                ]
                for tri in ((0, 1, 2), (0, 2, 3)):
                    a, b, c = (quad[k] for k in tri)
                    nx, ny, nz = _tri_normal(pos, a, b, c)
                    fh.write(f"  facet normal {nx:.5e} {ny:.5e} {nz:.5e}\n    outer loop\n")
                    for k in (a, b, c):
                        fh.write(f"      vertex {pos[k]:.5e} {pos[k + 1]:.5e} {pos[k + 2]:.5e}\n")
                    fh.write("    endloop\n  endfacet\n")
            fh.write(f"endsolid L{i:04d}_{row['tag']}\n")
    return path


# --------------------------------------------------------------------------
# OBJ + manifest
# --------------------------------------------------------------------------
def write_obj(mesh: Mesh, path: Path, name: str = "meshforge") -> Path:
    pos, idx = mesh.positions, mesh.indices
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="ascii") as fh:
        fh.write(f"# MeshForge 1000-layer forge\n# {name}\no {name}\n")
        for k in range(0, len(pos), 3):
            fh.write(f"v {pos[k]:.5f} {pos[k + 1]:.5f} {pos[k + 2]:.5f}\n")
        fh.write(f"# {mesh.vertices} vertices / {mesh.triangles} triangles\n")
        for t in range(0, len(idx), 3):
            fh.write(f"f {idx[t] + 1} {idx[t + 1] + 1} {idx[t + 2] + 1}\n")
    return path


def write_manifest(result: ForgeResult, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result.manifest(), indent=1), encoding="utf-8")
    return path


def stamp_filename(result: ForgeResult, ext: str) -> str:
    p = result.params
    return (f"{p.family}_{p.layers}L_{p.samples}P_{p.lobes}f_"
            f"tw{p.twist:g}_{result.gid[:8]}.{ext}")
