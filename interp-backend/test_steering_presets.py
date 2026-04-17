"""Unit tests for the preset fallback — V7.1 / V7.2 / V7.3 of the plan.

We don't load a real transformer here; the tests target the pure helpers
that wire presets into :mod:`steering_backend`. The integration-level
checks (V7.4 — full end-to-end against the seeded ``happy_sad`` challenge)
run as part of the backend smoke test, not this unit suite.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import steering_presets


# --------------------------------------------------------------------------- #
# V7.1 — named preset resolution returns a preset object
# --------------------------------------------------------------------------- #


def test_v71_happy_sad_preset_is_present_and_well_formed():
    preset = steering_presets.resolve_preset("happy_sad")
    assert preset is not None
    assert preset.name == "happy_sad"
    assert preset.pooling in {"last", "mean"}
    assert preset.position in {"all", "last"}
    # At least 3 pairs so the request-time validator accepts the preset.
    assert len(preset.positive_examples) >= 3
    assert len(preset.positive_examples) == len(preset.negative_examples)
    # target_layers authored as a tight band — the exact indices are
    # clamped to the loaded model at request time.
    assert len(preset.target_layers) >= 1


def test_v71_unknown_preset_returns_none():
    assert steering_presets.resolve_preset("does-not-exist") is None
    assert steering_presets.resolve_preset("") is None
    assert steering_presets.resolve_preset(None) is None


# --------------------------------------------------------------------------- #
# V7.2 — layer clamping to the loaded model
# --------------------------------------------------------------------------- #


def _import_clamp():
    # Imported lazily so FastAPI/Supabase env checks aren't touched unless
    # a V7.2 test runs. `steering_backend` is heavy to import otherwise.
    from steering_backend import _clamp_preset_to_model

    return _clamp_preset_to_model


def test_v72_preserves_in_range_target_layers_unchanged():
    clamp = _import_clamp()
    preset = steering_presets.PRESETS["happy_sad"]
    # happy_sad authors layers [8, 9, 10, 11]. gpt2 has 12 hidden layers,
    # so this is the no-op case.
    clamped = clamp(preset, num_hidden_layers=12)
    assert clamped.target_layers == list(preset.target_layers)


def test_v72_drops_out_of_range_layers_and_keeps_remainder():
    clamp = _import_clamp()
    preset = steering_presets.PRESETS["happy_sad"]  # [8, 9, 10, 11]
    clamped = clamp(preset, num_hidden_layers=10)
    assert clamped.target_layers == [8, 9]
    # Other preset fields are preserved so the cache key is honoured.
    assert clamped.name == preset.name
    assert clamped.pooling == preset.pooling
    assert clamped.position == preset.position


def test_v72_falls_back_to_last_layer_when_all_out_of_range():
    clamp = _import_clamp()
    preset = steering_presets.PRESETS["happy_sad"]  # all >= 8
    clamped = clamp(preset, num_hidden_layers=6)
    assert clamped.target_layers == [5]


def test_v72_never_returns_negative_fallback():
    clamp = _import_clamp()
    preset = steering_presets.PRESETS["happy_sad"]
    clamped = clamp(preset, num_hidden_layers=1)
    # With a 1-layer model the only usable layer is 0.
    assert clamped.target_layers == [0]


# --------------------------------------------------------------------------- #
# V7.3 — a Supabase row wins over a preset of the same name
# --------------------------------------------------------------------------- #


def test_v73_supabase_row_short_circuits_preset_fallback():
    """When ``fetch_steering_vector`` returns a non-None row, the preset
    branch must NOT fire. We prove this by mocking the Supabase fetcher
    and asserting ``resolve_preset`` is never consulted."""
    from steering_backend import resolve_vector_with_preset_fallback, SteeringVectorRecord

    dummy_row = SteeringVectorRecord(
        id="row-id-from-db",
        name="happy_sad",
        model_name="gpt2",
        positive_examples=["a", "b", "c"],
        negative_examples=["x", "y", "z"],
        target_layers=[5, 6],  # different from the preset's [8..11]
        pooling="last",
        position="all",
        vector_payload={5: [0.0, 0.0], 6: [0.0, 0.0]},
        min_coefficient=-4.0,
        max_coefficient=4.0,
        is_active=True,
        visibility="public",
        source="db",
    )

    with patch("steering_backend.fetch_steering_vector", new=AsyncMock(return_value=dummy_row)) as fetch_mock, \
         patch("steering_backend.steering_presets.resolve_preset") as resolve_preset_mock, \
         patch("steering_backend.load_model") as load_model_mock:
        result = asyncio.run(resolve_vector_with_preset_fallback("happy_sad"))

    assert result is dummy_row
    fetch_mock.assert_awaited_once_with("happy_sad")
    # The preset branch must be untouched so the DB row wins.
    resolve_preset_mock.assert_not_called()
    load_model_mock.assert_not_called()


# --------------------------------------------------------------------------- #
# Sanity — list_preset_summaries exposes the catalogue
# --------------------------------------------------------------------------- #


def test_list_preset_summaries_includes_happy_sad():
    names = {entry["name"] for entry in steering_presets.list_preset_summaries()}
    assert "happy_sad" in names
