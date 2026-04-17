"""Auto layer-selection via difference-of-means probe accuracy + cosine
sparsification.

This module is the production port of the probe logic that used to live only
in ``activation-steering-challenge/extract_directions.ipynb``. The public
entry point is :func:`select_layers_by_probe`.

Usage::

    layers = select_layers_by_probe(
        model=model,
        tokenizer=tokenizer,
        positive=["...", ...],
        negative=["...", ...],
        max_layers=3,
    )

The algorithm:

1. For each eligible layer (the second half of the model), extract mean-pooled
   hidden states for the positive and negative examples.
2. Compute the difference-of-means direction for that layer; project every
   example onto it; score accuracy by the sign of the projection.
3. Greedily pick layers in descending order of accuracy, skipping any layer
   whose direction has cosine similarity above ``(1 - min_cosine_distance)``
   with a layer that was already picked. This avoids stacking
   near-duplicate directions.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import torch


def _eligible_layers(num_hidden_layers: int, restrict_second_half: bool = True) -> List[int]:
    """Return the candidate layer indices we consider for auto-selection.

    By default we restrict to the second half of the model; early layers tend
    to encode shallow lexical features and rarely produce useful steering
    directions.
    """

    if num_hidden_layers <= 0:
        return []
    start = num_hidden_layers // 2 if restrict_second_half else 0
    return list(range(start, num_hidden_layers))


def _mean_pooled_hidden(
    model,
    tokenizer,
    texts: List[str],
    layer_indices: List[int],
) -> Dict[int, torch.Tensor]:
    """Return a dict ``{layer_idx: [N, H] float32 tensor on CPU}``."""

    device = next(model.parameters()).device
    accumulators: Dict[int, List[torch.Tensor]] = {i: [] for i in layer_indices}
    for text in texts:
        inputs = tokenizer(text, return_tensors="pt", truncation=True).to(device)
        with torch.no_grad():
            outputs = model(**inputs, output_hidden_states=True)
        for layer_idx in layer_indices:
            # +1 because hidden_states[0] is the embedding layer.
            hs = outputs.hidden_states[layer_idx + 1][0]
            accumulators[layer_idx].append(hs.mean(dim=0).detach().cpu().float())
    return {i: torch.stack(vs) for i, vs in accumulators.items() if vs}


def _diff_of_means_direction(pos: torch.Tensor, neg: torch.Tensor) -> torch.Tensor:
    """Return the unit-norm difference-of-means direction."""
    raw = pos.mean(dim=0) - neg.mean(dim=0)
    norm = raw.norm()
    if norm == 0:
        return raw
    return raw / norm


def _probe_accuracy(pos: torch.Tensor, neg: torch.Tensor, direction: torch.Tensor) -> float:
    """Fraction of labelled examples that land on the expected side of the
    difference-of-means direction. Expected: positives > 0, negatives < 0.
    """
    if direction.norm() == 0 or pos.numel() == 0 or neg.numel() == 0:
        return 0.0
    pos_proj = pos @ direction
    neg_proj = neg @ direction
    correct = (pos_proj > 0).sum().item() + (neg_proj < 0).sum().item()
    total = pos_proj.numel() + neg_proj.numel()
    return correct / total if total else 0.0


def select_layers_by_probe(
    model,
    tokenizer,
    positive: List[str],
    negative: List[str],
    max_layers: int = 3,
    min_cosine_distance: float = 0.05,
    restrict_second_half: bool = True,
) -> Tuple[List[int], Dict[int, float]]:
    """Pick ``max_layers`` layers most likely to produce useful directions.

    Returns ``(selected_layers, per_layer_accuracy)``. ``per_layer_accuracy``
    covers every layer that was evaluated — not only the selected ones — so the
    caller can surface diagnostic information.

    Raises ``ValueError`` if fewer than two positive/negative pairs are given.
    """

    if len(positive) < 2 or len(negative) < 2:
        raise ValueError("Auto layer-selection needs at least 2 positive and 2 negative examples.")
    if len(positive) != len(negative):
        raise ValueError("positive and negative example lists must be the same length.")
    if max_layers < 1:
        raise ValueError("max_layers must be >= 1")

    num_hidden_layers = getattr(getattr(model, "config", None), "num_hidden_layers", None)
    if num_hidden_layers is None:
        raise RuntimeError("model.config.num_hidden_layers is unavailable")

    layer_candidates = _eligible_layers(num_hidden_layers, restrict_second_half)
    if not layer_candidates:
        return [], {}

    pos_feats = _mean_pooled_hidden(model, tokenizer, positive, layer_candidates)
    neg_feats = _mean_pooled_hidden(model, tokenizer, negative, layer_candidates)

    directions: Dict[int, torch.Tensor] = {}
    accuracies: Dict[int, float] = {}
    for layer_idx in layer_candidates:
        pos = pos_feats[layer_idx]
        neg = neg_feats[layer_idx]
        direction = _diff_of_means_direction(pos, neg)
        directions[layer_idx] = direction
        accuracies[layer_idx] = _probe_accuracy(pos, neg, direction)

    ranked = sorted(layer_candidates, key=lambda i: accuracies[i], reverse=True)

    # Greedy cosine-sparsification.
    selected: List[int] = []
    selected_dirs: List[torch.Tensor] = []
    cos_threshold = 1.0 - float(min_cosine_distance)
    for candidate in ranked:
        if len(selected) >= max_layers:
            break
        d = directions[candidate]
        if d.norm() == 0:
            continue
        duplicate = False
        for prev in selected_dirs:
            if prev.norm() == 0:
                continue
            cosine = torch.dot(d, prev) / (d.norm() * prev.norm())
            if cosine.item() >= cos_threshold:
                duplicate = True
                break
        if not duplicate:
            selected.append(candidate)
            selected_dirs.append(d)

    if not selected and ranked:
        selected = [ranked[0]]

    selected.sort()
    return selected, accuracies


__all__ = ["select_layers_by_probe"]
