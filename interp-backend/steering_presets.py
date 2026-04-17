"""Named activation-steering presets and cache helpers.

Presets are intentionally small and explicit so the backend can precompute
their directions once and reuse the saved vectors on later requests.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


@dataclass(frozen=True)
class SteeringPreset:
    name: str
    description: str
    positive_examples: List[str]
    negative_examples: List[str]
    target_layers: List[int]
    pooling: str = "last"
    position: str = "all"


def _parse_int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _parse_float_env(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


STEER_MIN_COEFFICIENT = _parse_float_env("STEER_MIN_COEFFICIENT", -12.0)
STEER_MAX_COEFFICIENT = _parse_float_env("STEER_MAX_COEFFICIENT", 12.0)
STEER_CACHE_DIR = Path(os.getenv("STEER_CACHE_DIR", Path(__file__).with_name(".steering_cache")))
STEER_CACHE_DIR.mkdir(parents=True, exist_ok=True)


PRESETS: Dict[str, SteeringPreset] = {
    "happy_sad": SteeringPreset(
        name="happy_sad",
        description="Push the model toward warmer, more hopeful language.",
        positive_examples=[
            "The morning light feels like a fresh start full of endless possibilities.",
            "I am genuinely thrilled to see how much progress we have made together.",
            "I feel a deep sense of peace and excitement for what the future holds.",
            "There is so much beauty in the small, everyday moments if you look for it.",
        ],
        negative_examples=[
            "The gray sky feels like a heavy blanket that will never lift.",
            "I am deeply discouraged by how everything keeps falling apart.",
            "I feel a profound sense of dread when I think about what lies ahead.",
            "The world feels cold, hollow, and drained of any real meaning.",
        ],
        target_layers=[8, 9, 10, 11],
        pooling="last",
        position="all",
    ),
    "helpful_vague": SteeringPreset(
        name="helpful_vague",
        description="Encourage short, direct, and useful answers.",
        positive_examples=[
            "Absolutely, here is the direct answer you asked for.",
            "I can help with that right away in a clear way.",
            "The simplest approach is the one that works reliably.",
        ],
        negative_examples=[
            "There are many possible directions, each with a complicated nuance.",
            "The issue is multifaceted and requires a long contextual preface.",
            "Before answering, let us enumerate several abstract considerations.",
        ],
        target_layers=[8, 9, 10, 11],
        pooling="mean",
        position="all",
    ),
}


def clamp_coefficient(value: float) -> float:
    return max(STEER_MIN_COEFFICIENT, min(STEER_MAX_COEFFICIENT, value))


def resolve_preset(name: str | None) -> Optional[SteeringPreset]:
    if not name:
        return None
    return PRESETS.get(name)


def preset_cache_path(model_name: str, preset_name: str) -> Path:
    safe_model = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in model_name)
    safe_preset = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in preset_name)
    return STEER_CACHE_DIR / f"{safe_model}__{safe_preset}.json"


def load_cached_vectors(model_name: str, preset_name: str) -> Dict[int, List[float]]:
    path = preset_cache_path(model_name, preset_name)
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return {}

    vectors: Dict[int, List[float]] = {}
    if not isinstance(raw, dict):
        return vectors

    for key, value in raw.items():
        try:
            layer = int(key)
        except Exception:
            continue
        if isinstance(value, list) and all(isinstance(item, (int, float)) for item in value):
            vectors[layer] = [float(item) for item in value]

    return vectors


def save_cached_vectors(model_name: str, preset_name: str, vectors: Dict[int, Iterable[float]]) -> None:
    path = preset_cache_path(model_name, preset_name)
    serializable = {str(layer): [float(value) for value in vector] for layer, vector in vectors.items()}
    path.write_text(json.dumps(serializable, indent=2, sort_keys=True))


def list_preset_summaries() -> List[Dict[str, Any]]:
    return [
        {
            "name": preset.name,
            "description": preset.description,
            "target_layers": preset.target_layers,
            "pooling": preset.pooling,
            "position": preset.position,
            "positive_examples": len(preset.positive_examples),
            "negative_examples": len(preset.negative_examples),
        }
        for preset in PRESETS.values()
    ]