"""Unit tests for :mod:`layer_selection`.

These use a fake transformer model whose hidden states are engineered to
make the diff-of-means direction obvious for some layers and near-duplicate
for others. They exercise V6.1/V6.2 of the steering-vectors plan:

    V6.1 — auto-select returns ``<= 3`` layers, all in the second half of
           the model.
    V6.2 — cosine-sparsification kicks in: any two selected layers have
           pairwise direction cosine < ``1 - min_cosine_distance``.

Run locally with::

    python -m pytest interp-backend/test_layer_selection.py -q
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import torch

from layer_selection import select_layers_by_probe


# --------------------------------------------------------------------------- #
# Fake model scaffolding
# --------------------------------------------------------------------------- #


@dataclass
class _FakeConfig:
    num_hidden_layers: int
    hidden_size: int = 8


class _FakeOutputs:
    def __init__(self, hidden_states: List[torch.Tensor]):
        # Expected shape of each element: [batch=1, seq_len, hidden]
        self.hidden_states = hidden_states


class _FakeTokenizer:
    """Tokenizes every example to a single-token id equal to its index in the
    list of inputs the model was called with. We track which text we saw most
    recently so the fake model can return the corresponding hidden-state set.
    """

    def __init__(self, text_to_index: dict):
        self._text_to_index = text_to_index

    def __call__(self, text, return_tensors=None, truncation=None):
        idx = self._text_to_index[text]
        # Return a dict-like object that has .to() so the model code can do
        # ``tokenizer(...).to(device)``.
        return _FakeEncodedInput(idx)


class _FakeEncodedInput(dict):
    def __init__(self, idx: int):
        super().__init__()
        self["input_ids"] = torch.tensor([[idx]])
        self.idx = idx

    def to(self, _device):
        return self


class _FakeModel:
    """A model whose ``forward`` returns caller-configured hidden states.

    ``per_example_hiddens[i][layer]`` is a tensor of shape ``[seq_len, hidden]``
    used when example ``i`` is the input.
    """

    def __init__(
        self,
        num_hidden_layers: int,
        per_example_hiddens: List[List[torch.Tensor]],
        hidden_size: int = 8,
    ):
        self.config = _FakeConfig(num_hidden_layers=num_hidden_layers, hidden_size=hidden_size)
        self._per_example = per_example_hiddens
        # Used by `next(model.parameters()).device` — return a zero-param
        # nn.Parameter on CPU so the real code's device lookup works.
        self._param = torch.nn.Parameter(torch.zeros(1))

    def parameters(self):
        yield self._param

    def __call__(self, input_ids=None, output_hidden_states=False, **_):
        assert output_hidden_states
        # input_ids[0, 0] is the example index we encoded above.
        idx = int(input_ids[0, 0].item())
        # The model returns (num_hidden_layers + 1) hidden states — the first
        # is the embedding, then one per layer.
        layer_hiddens = self._per_example[idx]
        embedding = torch.zeros_like(layer_hiddens[0])
        return _FakeOutputs([embedding] + layer_hiddens)


# --------------------------------------------------------------------------- #
# Helpers to build synthetic layer hidden-states
# --------------------------------------------------------------------------- #


def _build_toy_inputs(num_layers: int, hidden_size: int = 8, pairs: int = 5):
    """Construct positive/negative texts and a per-example hidden-state table.

    Layer design (hidden_size=8):
      * Layers 0 .. num_layers//2 - 1  → noise only (first-half layers).
      * Layers num_layers//2 .. num_layers-4 → directions along basis[0].
      * Layers num_layers-3 .. num_layers-2 → directions along basis[1]
        (to check sparsification beats a near-duplicate basis-0 layer).
      * Layer num_layers-1 → direction identical to the basis[0] layers
        (must be dropped for cosine-sparsification).

    Positive examples get +signal; negative get -signal; every layer gets
    the same scale so probe accuracy is perfect where signal exists and
    chance where it isn't. We inject tiny per-example noise so the early
    layers aren't exactly zero.
    """
    assert hidden_size >= 2
    torch.manual_seed(0)

    e0 = torch.zeros(hidden_size)
    e0[0] = 1.0
    e1 = torch.zeros(hidden_size)
    e1[1] = 1.0

    first_half_end = num_layers // 2
    basis_a_layers = list(range(first_half_end, num_layers - 3))
    basis_b_layers = [num_layers - 3, num_layers - 2]
    duplicate_layer = num_layers - 1

    positive_texts = [f"pos_{i}" for i in range(pairs)]
    negative_texts = [f"neg_{i}" for i in range(pairs)]

    texts = positive_texts + negative_texts
    text_to_index = {t: i for i, t in enumerate(texts)}

    # Each per_example[i][layer] is shaped [batch=1, seq_len=1, hidden] —
    # matching HuggingFace's ``outputs.hidden_states[layer]`` convention,
    # where the production code indexes ``[0]`` to drop the batch dim.
    per_example = []
    for i, text in enumerate(texts):
        sign = 1.0 if text.startswith("pos_") else -1.0
        layer_hiddens: List[torch.Tensor] = []
        for layer_idx in range(num_layers):
            noise = 0.01 * torch.randn(1, 1, hidden_size)
            if layer_idx < first_half_end:
                # First-half layers: noise only. Will score ~chance.
                layer_hidden = noise
            elif layer_idx in basis_a_layers:
                layer_hidden = sign * e0.view(1, 1, -1) + noise
            elif layer_idx in basis_b_layers:
                layer_hidden = sign * e1.view(1, 1, -1) + noise
            elif layer_idx == duplicate_layer:
                # Same direction as basis_a → should be pruned.
                layer_hidden = sign * e0.view(1, 1, -1) + noise
            else:  # pragma: no cover
                layer_hidden = noise
            layer_hiddens.append(layer_hidden)
        per_example.append(layer_hiddens)

    return positive_texts, negative_texts, text_to_index, per_example


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def _cosine(a: torch.Tensor, b: torch.Tensor) -> float:
    na = a.norm()
    nb = b.norm()
    if na == 0 or nb == 0:
        return 0.0
    return float(torch.dot(a, b) / (na * nb))


def _direction_for(layer_idx: int, per_example, num_pos: int):
    # Compute the same diff-of-means direction the algorithm uses, so our
    # assertion about cosine is independent of the private helper.
    # per_example[i][layer] has shape [1, seq_len=1, hidden]; match the
    # production pipeline: drop batch (``[0]``), mean over seq (``mean(0)``).
    pos = torch.stack(
        [per_example[i][layer_idx][0].mean(dim=0) for i in range(num_pos)]
    )
    neg = torch.stack(
        [per_example[i][layer_idx][0].mean(dim=0) for i in range(num_pos, 2 * num_pos)]
    )
    raw = pos.mean(dim=0) - neg.mean(dim=0)
    norm = raw.norm()
    return raw / norm if norm > 0 else raw


def test_v61_selected_layers_are_at_most_three_and_in_second_half():
    num_layers = 12
    positive, negative, text_to_index, per_example = _build_toy_inputs(num_layers)
    model = _FakeModel(num_layers, per_example)
    tokenizer = _FakeTokenizer(text_to_index)

    layers, _ = select_layers_by_probe(
        model=model,
        tokenizer=tokenizer,
        positive=positive,
        negative=negative,
        max_layers=3,
    )

    assert 1 <= len(layers) <= 3, layers
    half = num_layers // 2
    for layer_idx in layers:
        assert layer_idx >= half, (layer_idx, half, layers)


def test_v62_pairwise_cosine_below_sparsification_threshold():
    num_layers = 12
    positive, negative, text_to_index, per_example = _build_toy_inputs(num_layers)
    model = _FakeModel(num_layers, per_example)
    tokenizer = _FakeTokenizer(text_to_index)

    layers, _ = select_layers_by_probe(
        model=model,
        tokenizer=tokenizer,
        positive=positive,
        negative=negative,
        max_layers=3,
        min_cosine_distance=0.05,
    )

    threshold = 1.0 - 0.05
    for i, la in enumerate(layers):
        for lb in layers[i + 1 :]:
            cos = _cosine(
                _direction_for(la, per_example, len(positive)),
                _direction_for(lb, per_example, len(positive)),
            )
            assert cos < threshold, (la, lb, cos, layers)


def test_duplicate_direction_is_pruned_even_when_accurate():
    """The last layer in our fixture has the *same* direction as earlier
    basis-0 layers. With max_layers=3, cosine-sparsification should skip
    it in favour of the orthogonal basis-1 layers."""
    num_layers = 12
    positive, negative, text_to_index, per_example = _build_toy_inputs(num_layers)
    model = _FakeModel(num_layers, per_example)
    tokenizer = _FakeTokenizer(text_to_index)

    layers, _ = select_layers_by_probe(
        model=model,
        tokenizer=tokenizer,
        positive=positive,
        negative=negative,
        max_layers=3,
        min_cosine_distance=0.05,
    )

    # The selected set must include at least one basis-1 layer (not just
    # three near-duplicate basis-0 layers).
    basis_b_layers = {num_layers - 3, num_layers - 2}
    assert any(l in basis_b_layers for l in layers), layers


def test_first_half_layers_are_never_selected_by_default():
    num_layers = 10
    positive, negative, text_to_index, per_example = _build_toy_inputs(num_layers)
    model = _FakeModel(num_layers, per_example)
    tokenizer = _FakeTokenizer(text_to_index)

    layers, accuracies = select_layers_by_probe(
        model=model,
        tokenizer=tokenizer,
        positive=positive,
        negative=negative,
        max_layers=3,
    )
    for l in layers:
        assert l >= num_layers // 2

    # The accuracies dict is restricted to candidate (second-half) layers.
    for l in accuracies:
        assert l >= num_layers // 2


def test_raises_when_example_counts_mismatch():
    num_layers = 6
    _p, _n, text_to_index, per_example = _build_toy_inputs(num_layers)
    model = _FakeModel(num_layers, per_example)
    tokenizer = _FakeTokenizer(text_to_index)

    try:
        select_layers_by_probe(
            model=model, tokenizer=tokenizer, positive=["pos_0", "pos_1"], negative=["neg_0"]
        )
    except ValueError:
        return
    raise AssertionError("expected ValueError when positive/negative lengths differ")
