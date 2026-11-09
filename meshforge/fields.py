"""Continuous radial field families.

A family is a function ``F(u, theta) -> radius`` where ``u`` runs 0..1 up the
stack and ``theta`` runs around the cross-section. Radii are expressed as a
fraction of the unit build radius so the same field can be scaled to any
print envelope.

The point of a *family* (instead of a fixed shape) is that layers can be
sampled and differentiated along ``u``: the stack is the discretisation of a
continuous object, never a pile of copies.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

TAU = math.tau


# --------------------------------------------------------------------------
# parameters
# --------------------------------------------------------------------------
@dataclass
class Params:
    """All knobs for a forged stack."""

    family: str = "helix"
    layers: int = 1000
    samples: int = 128          # profile points per layer
    lobes: int = 3              # angular frequency
    amplitude: float = 0.30     # fraction of base radius
    twist: float = 1.0          # turns across the full height
    differentiation: float = 0.55  # coupling of dF/du into each layer
    bore: float = 0.0           # inner radius fraction (0 = solid)
    radius_mm: float = 30.0     # outer build radius
    layer_height_mm: float = 0.2
    seed: int = 0

    # ---- derived -------------------------------------------------------
    @property
    def height_mm(self) -> float:
        """Printed height: every layer contributes one layer height."""
        return self.layers * self.layer_height_mm

    @property
    def pitch_mm(self) -> float:
        """Ring-to-ring spacing. Ring 0 sits at z=0 and ring n-1 at height_mm,
        so the surface spans exactly ``layers * layer_height``."""
        return self.height_mm / max(self.layers - 1, 1)

    def ring_z(self, i: int) -> float:
        return i * self.pitch_mm

    @property
    def profile(self) -> str:
        return f"{self.layers}L/{self.samples}P"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["height_mm"] = round(self.height_mm, 3)
        return d


@dataclass(frozen=True)
class Family:
    key: str
    label: str
    hint: str
    outer: Callable[[float, float, Params], float]
    bore: Callable[[float, float, Params], float] = lambda u, t, p: 0.0
    aliases: Sequence[str] = ()
    lobes: int = 3
    amplitude: float = 0.30
    twist: float = 1.0
    bore_ratio: float = 0.0


def _sat(x: float) -> float:
    """Smooth saturation to [-1, 1] — used for crisp structural ribs."""
    return math.tanh(2.2 * x) / math.tanh(2.2)


def _soft_bore(u: float, theta: float, p: Params, lobes: int, twist: float) -> float:
    return p.bore * (1.0 + 0.34 * math.cos(lobes * theta - TAU * twist * u + 0.6))


# --------------------------------------------------------------------------
# families
# --------------------------------------------------------------------------
def _helix_outer(u: float, theta: float, p: Params) -> float:
    """Rotating lobed strand — the classic 1000-layer helix tower."""
    a = p.amplitude
    k = float(p.lobes)
    phi = TAU * p.twist * u
    primary = math.cos(k * (theta + phi))
    secondary = math.cos(2.0 * k * (theta - 0.5 * phi))
    # sharpen the strands so the silhouette reads as separate flutes
    strand = _sat(primary * 1.9) * 0.62 + primary * 0.38
    return 1.0 + a * (0.86 * strand + 0.14 * secondary) - 0.09 * a * math.cos(phi * 2.0)


def _waves_outer(u: float, theta: float, p: Params) -> float:
    """Superposed standing waves with drifting phase and sharpened crests."""
    a = p.amplitude
    k = float(p.lobes) + 1.0
    w1 = math.cos(k * theta + 3.1 * TAU * 0.12 * p.twist * u)
    w2 = math.cos((k + 3.0) * theta - 2.2 * TAU * 0.12 * p.twist * u)
    w3 = math.cos((k + 6.0) * theta + 1.3 * TAU * 0.05 * u)
    base = 0.58 * w1 + 0.28 * w2 + 0.14 * w3
    crest = _sat(base * 1.35) * 0.86 + base * 0.14
    return 1.0 + a * crest


def _spiral_outer(u: float, theta: float, p: Params) -> float:
    """Archimedean sweep: lobe count fixed, radius envelope drifts outward."""
    k = float(p.lobes)
    phase = k * theta + TAU * 1.6 * p.twist * u
    envelope = 0.62 + 0.38 * (1.0 - u) ** 1.4
    return 1.0 + p.amplitude * envelope * math.sin(phase) - 0.05 * p.amplitude * u


def _lattice_outer(u: float, theta: float, p: Params) -> float:
    """Six-fold gear with alternating notches and a slow counter-rotation."""
    k = float(max(p.lobes, 4))
    phase = k * theta - TAU * 0.35 * p.twist * u
    tooth = _sat(math.sin(phase) * 2.4)
    notch = 0.18 * math.cos(2.0 * phase + 0.9)
    return 1.0 + p.amplitude * (0.82 * tooth + notch)


def _ghost_outer(u: float, theta: float, p: Params) -> float:
    """Haunted bell: a narrow crown, a swelling drape, and echo lobes that fade."""
    a = p.amplitude
    k = float(p.lobes)
    # silhouette: wide hem, pinched waist, narrow crown
    bell = 0.74 + 0.42 * math.sin(math.pi * min(u * 1.06, 1.0)) ** 1.5 + 0.16 * (1.0 - u) ** 2
    # the lobes rotate slowly and lose contrast as they rise
    drape = _sat(math.cos(k * theta + TAU * 1.25 * p.twist * u + 0.6) * 1.5) * 0.72
    drape += 0.28 * math.cos(2.0 * k * theta - TAU * 0.9 * p.twist * u + 1.2)
    echo = 0.5 * math.cos(5.0 * theta + 5.0 * u) * math.exp(-1.6 * u)
    lean = 1.0 + 0.13 * math.cos(theta - (0.7 + 1.5 * u))
    return (bell + a * 0.9 * drape * (0.55 + 0.45 * (1.0 - u)) + 0.3 * a * echo) * lean


def _vortex_outer(u: float, theta: float, p: Params) -> float:
    """Fluted outer wall for the hollow vortex family."""
    k = float(p.lobes)
    return 1.0 + p.amplitude * math.cos(k * theta - TAU * p.twist * u)


def _mountain_outer(u: float, theta: float, p: Params) -> float:
    """Ridge crest: five octaves of sharpened absolute cosines."""
    a = p.amplitude
    total = 0.0
    amp = 1.0
    k = float(p.lobes)
    for octave in range(5):
        ridge = 1.0 - abs(math.cos(k * theta * 0.5 + 1.7 * octave + u * (1.1 + 0.4 * octave)))
        total += amp * (ridge ** 1.55)
        amp *= 0.55
        k *= 1.85
    # three summits rising out of a broad base
    swell = 0.58 + 0.42 * math.sin(math.pi * min(u, 1.0)) ** 0.6
    return 1.0 + a * 1.06 * (total - 0.55) * swell


def _seed_outer(u: float, theta: float, p: Params) -> float:
    """Phyllotaxis: golden-angle grains packed around a smooth core."""
    golden = 0.6180339887498949
    phase = theta * 18.0 + TAU * golden * 21.0 * u
    grain = 0.5 + 0.5 * math.cos(phase)
    # rows of grains climbing in a spiral, over a rounded pod body
    row = 0.5 + 0.5 * math.cos(float(p.lobes) * theta + TAU * 2.4 * p.twist * u)
    pod = 0.9 + 0.1 * math.sin(math.pi * min(u * 1.1, 1.0))
    return pod + p.amplitude * 1.25 * (0.55 * row + 0.45 * grain - 0.45)


FAMILIES: Dict[str, Family] = {
    "helix": Family(
        "helix", "Helix", "Triple-strand tower, rotating as it rises",
        _helix_outer, aliases=("helix", "helical", "strand", "螺"),
        lobes=3, amplitude=0.30, twist=1.0,
    ),
    "waves": Family(
        "waves", "Geometric waves", "Standing waves with sharpened crests",
        _waves_outer, aliases=("wave", "waves", "geometric", "ripple", "ocean"),
        lobes=3, amplitude=0.26, twist=0.8,
    ),
    "spiral": Family(
        "spiral", "Spiral", "Archimedean sweep, widening as it climbs",
        _spiral_outer, aliases=("spiral", "vortex-sweep", "swirl", "coil"),
        lobes=2, amplitude=0.34, twist=1.6,
    ),
    "lattice": Family(
        "lattice", "Lattice", "Six-fold gear with alternating notches",
        _lattice_outer, aliases=("lattice", "gear", "cog", "truss", "grid"),
        lobes=6, amplitude=0.22, twist=0.4,
    ),
    "ghost": Family(
        "ghost", "Ghost", "Teardrop with decaying echo lobes",
        _ghost_outer, aliases=("ghost", "haunt", "teardrop", "phantom"),
        lobes=5, amplitude=0.28, twist=0.7,
    ),
    "vortex": Family(
        "vortex", "Vortex", "Hollow fluted column with a spiralling bore",
        _vortex_outer, _soft_bore, aliases=("vortex", "flute", "fluted", "chimney"),
        lobes=5, amplitude=0.24, twist=1.2, bore_ratio=0.46,
    ),
    "mountain": Family(
        "mountain", "Mountain", "Five-octave ridge crest, rising into peaks",
        _mountain_outer, aliases=("mountain", "ridge", "peak", "terrain", "range"),
        lobes=3, amplitude=0.30, twist=0.2,
    ),
    "seed": Family(
        "seed", "Seed", "Golden-angle grains on a smooth shell",
        _seed_outer, aliases=("seed", "phyllotaxis", "grain", "pod", "fibonacci"),
        lobes=7, amplitude=0.20, twist=2.4,
    ),
}


def list_families() -> List[dict]:
    return [
        {"key": f.key, "label": f.label, "hint": f.hint, "lobes": f.lobes}
        for f in FAMILIES.values()
    ]


def field_spec(p: Params) -> Family:
    return FAMILIES.get(p.family, FAMILIES["helix"])


def sample_field(p: Params) -> Tuple[Callable[[float, float], float], Callable[[float, float], float]]:
    """Return (outer, bore) closures for a parameter set."""
    fam = field_spec(p)
    outer = lambda u, t: fam.outer(u, t, p)
    bore = lambda u, t: fam.bore(u, t, p)
    return outer, bore


def default_params(family: str) -> Params:
    fam = FAMILIES.get(family, FAMILIES["helix"])
    return Params(
        family=fam.key,
        lobes=fam.lobes,
        amplitude=fam.amplitude,
        twist=fam.twist,
        bore=fam.bore_ratio,
    )


def clamp_params(p: Params) -> Params:
    p.layers = int(max(2, min(4000, p.layers)))
    p.samples = int(max(24, min(512, p.samples)))
    p.lobes = int(max(2, min(24, p.lobes)))
    p.amplitude = float(max(0.0, min(0.55, p.amplitude)))
    p.twist = float(max(-6.0, min(6.0, p.twist)))
    p.differentiation = float(max(0.0, min(1.6, p.differentiation)))
    p.bore = float(max(0.0, min(0.72, p.bore)))
    p.radius_mm = float(max(4.0, min(240.0, p.radius_mm)))
    p.layer_height_mm = float(max(0.02, min(1.2, p.layer_height_mm)))
    return p


def tokenize(text: Iterable[str]) -> List[str]:
    return [t.lower() for t in text if t]
