"""Natural-language prompt → Params.

Plain structural words, no API required. Examples::

    "Helix, 3-fold twist, hollow"
    "Ghost teardrop tower 400 mm tall, fine layers"
    "Geometric waves — petal 5, dense mesh"
"""
from __future__ import annotations

import re
from typing import Iterable, List

from .fields import FAMILIES, Params, default_params

_NUM = r"(\d+(?:\.\d+)?)"

_RULES = [
    # layers
    (re.compile(_NUM + r"\s*(?:layers?|slices?|layers?\b)", re.I), "layers"),
    (re.compile(r"(\d{2,4})\s*l\b", re.I), "layers"),
    # samples
    (re.compile(_NUM + r"\s*(?:samples?|points?|segments?|resolution|res)\b", re.I), "samples"),
    # lobes
    (re.compile(_NUM + r"\s*(?:lobes?|petals?|folds?|flutes?|fins?|arms?)\b", re.I), "lobes"),
    (re.compile(_NUM + r"\s*-?\s*fold", re.I), "lobes"),
    # twist
    (re.compile(_NUM + r"\s*(?:turns?|twists?|rotations?)\b", re.I), "twist"),
    (re.compile(r"twist\s*(?:of\s*)?" + _NUM, re.I), "twist"),
    # depth / amplitude
    (re.compile(_NUM + r"\s*(?:depth|amplitude|relief|bulge)\b", re.I), "amplitude"),
    # differentiation coupling
    (re.compile(_NUM + r"\s*(?:differentiation|diff|derivative)\b", re.I), "differentiation"),
    # bore / relief / differentiation — number before or after the keyword
    (re.compile(_NUM + r"\s*(?:bore|hollow|inner)\b", re.I), "bore"),
    (re.compile(r"\b(?:bore|hollow)\s*(?:of\s*|:\s*)?" + _NUM, re.I), "bore"),
    (re.compile(r"\brelief\s*(?:of\s*|:\s*)?" + _NUM, re.I), "amplitude"),
    (re.compile(r"\b(?:differentiation|diff(?:erentiate)?)\s*(?:of\s*|:\s*)?" + _NUM, re.I),
     "differentiation"),
    # radius / diameter / height
    (re.compile(_NUM + r"\s*mm\s*(?:diameter|dia|wide|across)\b", re.I), "diameter"),
    (re.compile(r"(?:diameter|dia)\s*(?:of\s*)?" + _NUM, re.I), "diameter"),
    (re.compile(_NUM + r"\s*mm\s*(?:radius|r)\b", re.I), "radius"),
    (re.compile(_NUM + r"\s*mm\s*(?:tall|high|height)\b", re.I), "height"),
    (re.compile(r"height\s*(?:of\s*)?" + _NUM + r"\s*mm", re.I), "height"),
]

_LAYER_HINTS = [
    (re.compile(r"\b(ultra\s*fine|hairline|jewell?ery|micro)\b", re.I), 0.06),
    (re.compile(r"\b(fine|dense|smooth|delicate)\b", re.I), 0.10),
    (re.compile(r"\b(standard|normal|default)\b", re.I), 0.20),
    (re.compile(r"\b(coarse|chunky|bold|rough|fast)\b", re.I), 0.32),
]

_HOLLOW = re.compile(r"\b(hollow|tube|pipe|sleeve|shell|open\s*center)\b", re.I)


def _find_family(text: str) -> str:
    low = text.lower()
    best, best_len = None, 0
    for fam in FAMILIES.values():
        for alias in (fam.key, *fam.aliases):
            if alias in low and len(alias) > best_len:
                best, best_len = fam.key, len(alias)
    return best or "helix"


def parse_prompt(text: str) -> Params:
    low = (text or "").strip()
    fam = _find_family(low)
    p = default_params(fam)

    for rx, key in _RULES:
        m = rx.search(low)
        if not m:
            continue
        try:
            val = float(m.group(1))
        except (TypeError, ValueError):
            continue
        if key == "layers":
            p.layers = int(val)
        elif key == "samples":
            p.samples = int(val)
        elif key == "lobes":
            p.lobes = int(val)
        elif key == "twist":
            p.twist = val
        elif key == "amplitude":
            p.amplitude = val / 100.0 if val > 1.0 else val
        elif key == "differentiation":
            p.differentiation = val / 100.0 if val > 1.6 else val
        elif key == "bore":
            p.bore = val / 100.0 if val > 1.0 else val
        elif key == "diameter":
            p.radius_mm = val / 2.0
        elif key == "radius":
            p.radius_mm = val
        elif key == "height":
            p.layer_height_mm = val / max(p.layers, 1)

    for rx, lh in _LAYER_HINTS:
        if rx.search(low):
            p.layer_height_mm = lh
            break

    if _HOLLOW.search(low) and p.bore < 0.12:
        p.bore = 0.46

    # natural nudges
    if re.search(r"\b(mirror|invert|flip)\b", low):
        p.twist = -p.twist
    if re.search(r"\b(left[-\s]?handed|reverse)\b", low):
        p.lobes = max(2, p.lobes)  # phase direction handled by twist sign
        p.twist = -abs(p.twist)
    if re.search(r"\b(tight|steep)\b", low):
        p.twist = abs(p.twist) * 1.6
    if re.search(r"\b(open|loose|gentle)\b", low):
        p.twist = abs(p.twist) * 0.55
    if re.search(r"\b(shell|hollow)\b", low) and p.bore == 0.0:
        p.bore = 0.5
    return p


def describe(p: Params) -> str:
    fam = FAMILIES.get(p.family)
    bits: List[str] = [fam.label if fam else p.family]
    bits.append(f"{p.layers}L × {p.samples}P")
    bits.append(f"{p.lobes}-fold")
    bits.append(f"twist {p.twist:g}×")
    if p.bore:
        bits.append(f"bore {int(round(p.bore * 100))}%")
    bits.append(f"{round(p.height_mm, 1)} mm tall")
    return " · ".join(bits)
