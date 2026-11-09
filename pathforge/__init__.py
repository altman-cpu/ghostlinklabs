"""OLVR PathForge — prompt in, one continuous printable toolpath out.

The second OLVR module, built on the same contract as MeshForge:

    prompt -> artifact -> audit (with a control that must fail) -> tests

    from meshforge.prompts import parse_prompt
    from meshforge.layerstack import forge
    from pathforge import forge_path, write_gcode

    path = forge_path(forge(parse_prompt("Helix, 1000 layers")))
    path.audit["pass"]          # True: no seams, no travel, monotone Z
    path.audit["control"]       # the ring-per-layer build, which must fail
"""
from .core import (PathParams, ToolPath, audit_path, forge_path, layered_path,
                   spiral_path, wall_radii)
from .exporters import (gcode_text, stamp_filename, svg_text, write_csv,
                        write_gcode, write_manifest, write_svg)

__version__ = "1.0.0"
__brand__ = "OLVR"

__all__ = [
    "PathParams", "ToolPath", "audit_path", "forge_path", "layered_path",
    "spiral_path", "wall_radii", "gcode_text", "stamp_filename", "svg_text",
    "write_csv", "write_gcode", "write_manifest", "write_svg",
    "__version__", "__brand__",
]
