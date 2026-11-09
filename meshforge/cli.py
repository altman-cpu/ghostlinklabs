"""MeshForge command line.

    python -m meshforge "Helix, 3-fold twist, hollow"
    python -m meshforge export "Ghost teardrop, 200 mm tall" --out out/
    python -m meshforge audit "Geometric waves, 5 petals"
    python -m meshforge serve --port 7600

Everything is stdlib. ``--layers 1000`` is the default; the audit is always
run and its verdict is written to stderr and the manifest.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .differentiator import stamp
from .exporters import (
    stamp_filename, write_manifest, write_obj, write_ordered_stl, write_stl_ascii,
    write_stl_binary,
)
from .fields import Params, clamp_params, list_families
from .layerstack import forge
from .prompts import describe, parse_prompt


def _params(args) -> Params:
    p = parse_prompt(args.prompt) if args.prompt else Params()
    if args.family:
        p.family = args.family
    for attr in ("layers", "samples", "lobes"):
        val = getattr(args, attr, None)
        if val is not None:
            setattr(p, attr, val)
    for attr in ("twist", "amplitude", "differentiation", "bore", "layer_height"):
        val = getattr(args, attr, None)
        if val is not None:
            setattr(p, attr, val)
    if getattr(args, "diameter", None):
        p.radius_mm = args.diameter / 2.0
    if getattr(args, "radius", None):
        p.radius_mm = args.radius
    if getattr(args, "seed", None) is not None:
        p.seed = args.seed
    return clamp_params(p)


def _summary(result) -> str:
    a, s = result.audit, result.stats
    lines = [
        f"forge id     {result.gid[:16]}",
        f"object       {describe(result.params)}",
        f"geometry     {s['vertices']:,} verts · {s['triangles']:,} tris · "
        f"{s['volume_cm3']} cm³ · {s['filament_m']} m filament",
        f"printable    watertight={s['watertight']} · hollow={s['hollow']} · "
        f"{s['height_mm']} mm tall · Ø{s['diameter_mm']} mm",
        f"audit        {a['unique']}/{a['layers']} unique · "
        f"{a['congruent_pairs']} congruent · min Δ {a['min_separation']:.3e}",
        f"verdict      {'DIFFERENTIATED' if a['match']['pass'] else 'CLONES DETECTED'}",
    ]
    return "\n".join(lines)


def cmd_forge(args) -> int:
    p = _params(args)
    result = forge(p)
    if args.json:
        print(json.dumps({k: v for k, v in result.manifest().items() if k != "layers"}, indent=1))
        return 0 if result.audit["match"]["pass"] else 2

    print(_summary(result))
    if args.ascii_preview:
        print()
        print(_ascii_preview(result))
    out = Path(args.out)
    if out:
        out.mkdir(parents=True, exist_ok=True)
        written = []
        if args.format in ("stl", "all"):
            written.append(write_stl_binary(result.mesh, out / stamp_filename(result, "stl"),
                                            header=f"MeshForge {result.gid[:8]}"))
        if args.format in ("obj", "all"):
            written.append(write_obj(result.mesh, out / stamp_filename(result, "obj")))
        if args.format in ("json", "all"):
            written.append(write_manifest(result, out / stamp_filename(result, "json")))
        if args.format in ("ascii", "all"):
            written.append(write_stl_ascii(result.mesh, out / stamp_filename(result, "ascii.stl")))
        if args.format in ("layers", "all"):
            written.append(write_ordered_stl(result, out / stamp_filename(result, "layers.stl")))
        if written:
            print("\nwrote")
            for path in written:
                print(f"  {path}  ({path.stat().st_size / 1e6:.1f} MB)")
    return 0 if result.audit["match"]["pass"] else 2


def cmd_audit(args) -> int:
    p = _params(args)
    result = forge(p)
    a = result.audit
    rows = result.layers
    print(_summary(result))
    print()
    print(f"{'i':>5} {'z mm':>8} {'tag':>7} {'r mean':>8} {'r min':>8} {'r max':>8}  digest")
    stride = max(1, len(rows) // 12)
    for r in rows[::stride]:
        print(f"{r['i']:>5} {r['z']:>8.2f} {r['tag']:>7} {r['r_mean']:>8.3f} "
              f"{r['r_min']:>8.3f} {r['r_max']:>8.3f}  {r['digest']}")
    print(f"{'':>5} … {len(rows) - 1:>5} layers checked, {a['checked_pairs']} adjacent pairs")
    print(f"\ncontrol: a flat extrusion of one silhouette → 1 unique, "
          f"{len(rows) - 1} congruent pairs")
    print(f"forged : {a['unique']} unique, {a['congruent_pairs']} congruent → "
          f"{'PASS' if a['match']['pass'] else 'FAIL'}")
    return 0 if a["match"]["pass"] else 2


def cmd_families(_args) -> int:
    for fam in list_families():
        print(f"{fam['key']:<10} {fam['label']:<18} {fam['hint']}")
    return 0


def cmd_serve(args) -> int:
    from .server import main as serve_main
    return serve_main(["--host", args.host, "--port", str(args.port)])


def _ascii_preview(result, rows: int = 22, cols: int = 62) -> str:
    """Unwrapped radial field: angle → x, layer → y, radius → shade.

    A twist shows up as diagonal banding, lobes as repeated columns, and the
    per-layer glyphs as the texture that never repeats row to row.
    """
    import math

    n = result.params.layers
    s = result.params.samples
    band = max(1, n // rows)
    grid = []
    for i in range(0, n, band):
        row = result.layers[i]
        mean_r = row["r_mean"]
        cells = []
        for j in range(cols):
            th = math.tau * j / cols
            r = mean_r + (row["r_max"] - row["r_min"]) / 2.0 * math.cos(
                result.params.lobes * (th + math.tau * result.params.twist * (i / max(n - 1, 1)))
            )
            cells.append(r)
        grid.append(cells)

    lo = min(min(r) for r in grid)
    hi = max(max(r) for r in grid) or 1.0
    ramp = " .:-=+*#%@"
    out = []
    for cells in reversed(grid):
        out.append("  " + "".join(
            ramp[min(len(ramp) - 1, int((v - lo) / (hi - lo) * (len(ramp) - 1)))]
            for v in cells
        ))
    out.append("  " + "_" * cols)
    out.append(f"  unwrapped field · {result.params.family} · "
               f"{n} layers → {len(grid)} rows, {cols} angles")
    return "\n".join(out)


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("prompt", nargs="?", default="", help="structural prompt")
    common.add_argument("--family", choices=[f["key"] for f in list_families()])
    common.add_argument("--layers", type=int)
    common.add_argument("--samples", type=int)
    common.add_argument("--lobes", type=int)
    common.add_argument("--twist", type=float)
    common.add_argument("--amplitude", type=float)
    common.add_argument("--differentiation", type=float)
    common.add_argument("--bore", type=float)
    common.add_argument("--diameter", type=float, help="mm across")
    common.add_argument("--radius", type=float, help="mm")
    common.add_argument("--layer-height", type=float, dest="layer_height", help="mm")
    common.add_argument("--seed", type=int)

    ap = argparse.ArgumentParser(
        prog="meshforge",
        description="Forge 1000-layer 3D printable meshes — always match the differentiate.",
    )
    sub = ap.add_subparsers(dest="cmd")

    p_forge = sub.add_parser("forge", parents=[common], help="forge + audit (default)")
    p_forge.add_argument("--out", default="", help="directory for exports")
    p_forge.add_argument("--format", default="all",
                         choices=["stl", "obj", "json", "ascii", "layers", "all"])
    p_forge.add_argument("--json", action="store_true", help="print manifest summary as JSON")
    p_forge.add_argument("--ascii-preview", action="store_true", dest="ascii_preview")
    p_forge.set_defaults(func=cmd_forge)

    p_export = sub.add_parser("export", parents=[common], help="write mesh files")
    p_export.add_argument("--out", default="out")
    p_export.add_argument("--format", default="all",
                          choices=["stl", "obj", "json", "ascii", "layers", "all"])
    p_export.add_argument("--json", action="store_true")
    p_export.add_argument("--ascii-preview", action="store_true", dest="ascii_preview")
    p_export.set_defaults(func=cmd_forge)

    p_audit = sub.add_parser("audit", parents=[common], help="print the differentiation audit")
    p_audit.add_argument("--json", action="store_true")
    p_audit.add_argument("--ascii-preview", action="store_true", dest="ascii_preview")
    p_audit.set_defaults(func=cmd_audit, out="", format="all")

    sub.add_parser("families", help="list field families").set_defaults(func=cmd_families)

    p_serve = sub.add_parser("serve", help="run the forge web UI")
    p_serve.add_argument("--host", default="0.0.0.0")
    p_serve.add_argument("--port", type=int, default=7600)
    p_serve.set_defaults(func=cmd_serve)

    return ap


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = build_parser()
    if not argv:
        argv = ["forge", "--ascii-preview"]
    elif argv[0] not in {"forge", "export", "audit", "families", "serve", "-h", "--help"}:
        argv = ["forge", *argv]
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    try:
        return args.func(args)
    except BrokenPipeError:  # pragma: no cover
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
