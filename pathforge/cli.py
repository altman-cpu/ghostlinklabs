"""PathForge command line.

    python3 -m pathforge export "Helix, 1000 layers, bore 46%" -o out/
    python3 -m pathforge audit "Ghost, 1000 layers"
    python3 -m pathforge preview "Geometric waves" -o /tmp/waves.gcode
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from meshforge.layerstack import forge
from meshforge.prompts import parse_prompt

from .core import PathParams, forge_path
from .exporters import (stamp_filename, svg_text, write_csv, write_gcode,
                        write_manifest, write_svg)


def _build(prompt: str, extra: argparse.Namespace) -> tuple:
    params = parse_prompt(prompt)
    if extra.layers:
        params.layers = extra.layers
    if extra.samples:
        params.samples = extra.samples
    result = forge(params)
    pp = PathParams(
        nozzle_mm=extra.nozzle,
        width_mm=extra.width if extra.width else extra.nozzle * 1.125,
        feedrate_mm_min=extra.feed,
    )
    return result, forge_path(result, pp)


def cmd_export(args: argparse.Namespace) -> int:
    result, path = _build(args.prompt, args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    base = out / stamp_filename(path, "gcode").replace(".gcode", "")

    gcode = write_gcode(path, Path(str(base) + ".gcode"), decimate=args.decimate)
    manifest = write_manifest(path, Path(str(base) + ".json"))
    csv = write_csv(path, Path(str(base) + ".csv"))
    written = [gcode, manifest, csv]
    if not args.no_svg:
        written.append(write_svg(path, Path(str(base) + ".svg")))

    a, st = path.audit, path.stats
    print(f"prompt      : {args.prompt}")
    print(f"source      : MeshForge {st['family']} {st['layers']}L x "
          f"{st['samples']}P  gid {result.gid[:12]}")
    print(f"mesh audit  : {result.audit['unique']}/{st['layers']} unique layers, "
          f"{result.audit['congruent_pairs']} congruent")
    print(f"path        : {st['points']} points, {st['path_length_m']} m of bead, "
          f"{a['turns']} turns")
    print(f"continuity  : seams={a['seams']} travel_moves={a['travel_moves']} "
          f"monotonic_z={a['monotonic_z']} "
          f"layers={a['layers_traversed']}/{st['layers']}")
    if a.get("control"):
        c = a["control"]
        print(f"control     : ring-per-layer -> seams={c['seams']} "
              f"travel_moves={c['travel_moves']} pass={c['pass']}  (must be False)")
    print(f"material    : {st['filament_m']} m filament, {st['grams']} g, "
          f"~{st['est_minutes']} min")
    print(f"verdict     : {'CONTINUOUS BEAD' if a['pass'] else 'FAILED'}")
    for w in written:
        print(f"  wrote {w}  ({w.stat().st_size:,} bytes)")
    return 0 if a["pass"] else 1


def cmd_audit(args: argparse.Namespace) -> int:
    result, path = _build(args.prompt, args)
    a = path.audit
    print(f"{'rule':<14}: one continuous bead, all layers, no travel")
    print(f"{'source':<14}: {path.source['family']} "
          f"{path.stats['layers']}L x {path.stats['samples']}P")
    for key in ("points", "seams", "travel_moves", "continuous", "monotonic_z",
                "layers_traversed", "turns", "z_span_mm", "step_max_mm"):
        print(f"{key:<14}: {a[key]}")
    if a.get("control"):
        print("control (ring-per-layer):")
        for k, v in a["control"].items():
            if k != "note":
                print(f"  {k:<12}: {v}")
    print(f"verdict     : {'PASS' if a['pass'] else 'FAIL'}")
    return 0 if a["pass"] else 1


def cmd_preview(args: argparse.Namespace) -> int:
    """Print an SVG proof sheet to stdout (or a file)."""
    _, path = _build(args.prompt, args)
    text = svg_text(path, width=args.svg_width, height=args.svg_height)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(text)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="pathforge",
                                 description="OLVR PathForge — spiral toolpaths")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("prompt", help='e.g. "Helix, 1000 layers, bore 46%"')
        p.add_argument("--layers", type=int, default=0)
        p.add_argument("--samples", type=int, default=0)
        p.add_argument("--nozzle", type=float, default=0.4)
        p.add_argument("--width", type=float, default=0.0,
                       help="extrusion width (default 1.125 x nozzle)")
        p.add_argument("--feed", type=float, default=900.0)

    e = sub.add_parser("export", help="forge a mesh and cut its toolpath")
    common(e)
    e.add_argument("-o", "--out", default="out")
    e.add_argument("--decimate", type=int, default=1,
                   help="emit every Nth move (audit still runs on the full path)")
    e.add_argument("--no-svg", action="store_true")
    e.set_defaults(func=cmd_export)

    a = sub.add_parser("audit", help="print the continuity audit (+ control)")
    common(a)
    a.set_defaults(func=cmd_audit)

    v = sub.add_parser("preview", help="SVG proof sheet")
    common(v)
    v.add_argument("-o", "--out", default="")
    v.add_argument("--svg-width", type=int, default=1200)
    v.add_argument("--svg-height", type=int, default=560)
    v.set_defaults(func=cmd_preview)
    return ap


def main(argv: list | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
