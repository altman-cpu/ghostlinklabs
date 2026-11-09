"""MeshForge — 1000-layer structural mesh generator.

Every layer in a forged stack is a *differentiated* slice of a continuous
radial field: layer ``i`` is the field sampled at height ``u_i`` and dressed
with the field's own derivative along ``u``, weighted by a per-layer glyph.
No two layers are congruent; the stack proves it with a digest audit.

Public surface::

    from meshforge import forge
    result = forge("Helix, 3-fold twist, hollow")
    result.mesh        # Mesh (positions / indices)
    result.manifest    # per-layer differentiation records
    result.audit       # congruence proof
"""
from __future__ import annotations

from .differentiator import audit_layers, glyph
from .fields import FAMILIES, Params, field_spec, list_families
from .layerstack import ForgeResult, forge
from .prompts import parse_prompt

__all__ = [
    "FAMILIES",
    "ForgeResult",
    "Params",
    "audit_layers",
    "field_spec",
    "forge",
    "glyph",
    "list_families",
    "parse_prompt",
]

__version__ = "1.0.0"
