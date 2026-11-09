"""OLVR — provable generative manufacturing.

Modules ship as top-level packages so each can be run directly:

    python3 -m meshforge export "Helix, 1000 layers" -o out/
    python3 -m pathforge export "Helix, 1000 layers" -o out/

The contract every OLVR module keeps: one command produces the artifact, the
artifact ships with an audit, the audit can fail (and a control must fail it),
and tests prove both.
"""
from __future__ import annotations

__version__ = "0.2.0"
__brand__ = "OLVR"
__rule__ = "always match the differentiate"

MODULES = {
    "meshforge": "prompt -> 1000-layer printable mesh + differentiation audit",
    "pathforge": "forged mesh -> continuous toolpath + continuity audit",
}


def modules() -> dict:
    return dict(MODULES)


def describe() -> str:
    lines = [f"OLVR {__version__} — {__brand__}", f"rule: {__rule__}", ""]
    for name, what in MODULES.items():
        lines.append(f"  {name:<10} {what}")
    return "\n".join(lines)


__all__ = ["MODULES", "modules", "describe", "__version__", "__brand__", "__rule__"]
