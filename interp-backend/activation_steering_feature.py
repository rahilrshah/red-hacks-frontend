"""
Activation Steering Pipeline — Self-contained demo

Demonstrates the full activation steering pipeline using GPT-2 (small, no GPU needed).
Swap MODEL_NAME to any HuggingFace causal LM (e.g. "mistralai/Mistral-7B-v0.1").

Methods implemented:
  1. Contrastive prompts (concept-present vs concept-absent), then difference-in-means

Future ideas:
  2. PCA on concept-related activations
  3. Linear probes trained to distinguish concept vs non-concept
  4. Compare stock vs erased encoder representations
"""

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

# ── Configuration ─────────────────────────────────────────────────────────────

MODEL_NAME = "gpt2"  # Small and fast. Swap to "mistralai/Mistral-7B-v0.1" etc.
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.float32  # use float16 for larger models on GPU


# ── Model loading ─────────────────────────────────────────────────────────────

def load_model(model_name=MODEL_NAME):
    """Load a HuggingFace causal LM and its tokenizer."""
    print(f"Loading {model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        model_name, torch_dtype=DTYPE
    ).to(DEVICE).eval()

    n_layers = model.config.num_hidden_layers
    hidden_dim = model.config.hidden_size
    print(f"  {n_layers} layers, hidden_dim={hidden_dim}, device={DEVICE}")
    return model, tokenizer


# ── Hidden state extraction ───────────────────────────────────────────────────

def get_hidden_states(model, tokenizer, prompt, layers):
    """Get hidden states from specific layers for a prompt.

    Args:
        model: any HuggingFace model that supports output_hidden_states
        tokenizer: matching tokenizer
        prompt: input string
        layers: list of layer indices (0-based, up to num_hidden_layers-1)

    Returns:
        dict: {layer_idx: tensor of shape (seq_len, hidden_dim)}
    """
    device = next(model.parameters()).device
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True).to(device)

    with torch.no_grad():
        outputs = model(**inputs, output_hidden_states=True)

    # hidden_states[0] = embedding output, hidden_states[i+1] = layer i output
    result = {}
    for layer in layers:
        result[layer] = outputs.hidden_states[layer + 1][0].cpu().float()
    return result


def get_last_token_pos(tokenizer, prompt):
    """Get the position of the last real token (before padding)."""
    ids = tokenizer(prompt, return_tensors="pt").input_ids[0]
    if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in ids.tolist():
        return ids.tolist().index(tokenizer.eos_token_id)
    return len(ids) - 1


# ── Direction extraction ──────────────────────────────────────────────────────

def extract_directions(model, tokenizer, positive_prompts, negative_prompts,
                       target_layers, pooling="last"):
    """Extract concept directions via contrastive difference-in-means.

    Args:
        model: HuggingFace model
        tokenizer: matching tokenizer
        positive_prompts: list of prompts containing the concept
        negative_prompts: list of matched prompts without the concept
        target_layers: list of layer indices to extract directions for
        pooling: "last" (last token) or "mean" (mean over all tokens)

    Returns:
        dict: {layer_idx: unit direction vector of shape (hidden_dim,)}
    """
    assert len(positive_prompts) == len(negative_prompts), \
        "Need equal number of positive and negative prompts"

    directions = {}

    for layer in target_layers:
        pos_vecs = []
        neg_vecs = []

        for pos_p, neg_p in zip(positive_prompts, negative_prompts):
            pos_h = get_hidden_states(model, tokenizer, pos_p, [layer])
            neg_h = get_hidden_states(model, tokenizer, neg_p, [layer])

            if pooling == "last":
                pos_pos = get_last_token_pos(tokenizer, pos_p)
                neg_pos = get_last_token_pos(tokenizer, neg_p)
                pos_vecs.append(pos_h[layer][pos_pos])
                neg_vecs.append(neg_h[layer][neg_pos])
            elif pooling == "mean":
                pos_vecs.append(pos_h[layer].mean(dim=0))
                neg_vecs.append(neg_h[layer].mean(dim=0))
            else:
                raise ValueError(f"Unknown pooling mode: {pooling}")

        pos_mean = torch.stack(pos_vecs).mean(dim=0)
        neg_mean = torch.stack(neg_vecs).mean(dim=0)
        raw_dir = pos_mean - neg_mean
        norm = raw_dir.norm()
        directions[layer] = raw_dir / norm
        print(f"  Layer {layer}: direction norm = {norm:.4f}")

    return directions


# ── Layer path detection ──────────────────────────────────────────────────────

def _get_layer_module(model, layer_idx):
    """Auto-detect the layer module path for common architectures.

    Supports: GPT-2, LLaMA/Mistral, CLIP, BERT, and others.
    """
    # Try common architecture paths
    paths = [
        lambda m, i: m.transformer.h[i],                    # GPT-2, GPT-Neo
        lambda m, i: m.model.layers[i],                     # LLaMA, Mistral, Qwen
        lambda m, i: m.text_model.encoder.layers[i],        # CLIP text encoder
        lambda m, i: m.encoder.layer[i],                    # BERT, RoBERTa
        lambda m, i: m.model.decoder.layers[i],             # OPT, BART decoder
    ]
    for path_fn in paths:
        try:
            return path_fn(model, layer_idx)
        except (AttributeError, IndexError):
            continue

    raise RuntimeError(
        f"Could not find layer {layer_idx}. Inspect your model with:\n"
        f"  for name, _ in model.named_modules(): print(name)"
    )


# ── Activation steerer ───────────────────────────────────────────────────────

class TextEncoderSteerer:
    """Manages forward-pass hooks for activation steering on any HF model.

    Usage:
        steerer = TextEncoderSteerer(model, directions)
        steerer.set_magnitudes({10: 5.0, 11: 3.0})
        steerer.attach_hooks()
        # ... run model forward pass ...
        steerer.remove_hooks()
    """

    def __init__(self, model, directions, position="all"):
        """
        Args:
            model: any HuggingFace model
            directions: dict {layer_idx: unit direction vector}
            position: "all" (steer every token) or "last" (steer last token only)
        """
        self.model = model
        self.directions = directions
        self.position = position
        self.magnitudes = {}  # {layer_idx: float}
        self.hooks = []

    def set_magnitudes(self, magnitudes: dict):
        """Set per-layer steering magnitudes. {layer_idx: float}"""
        self.magnitudes = magnitudes

    def _make_hook(self, layer_idx):
        """Create a hook function for a specific layer."""
        device = next(self.model.parameters()).device
        dtype = next(self.model.parameters()).dtype
        direction = self.directions[layer_idx].to(device).to(dtype)

        def hook_fn(module, input, output):
            # Handle both tuple and bare tensor outputs.
            # GPT-2 layers return a tuple; CLIP layers may return bare tensor.
            output_is_tuple = isinstance(output, tuple)
            hidden_states = output[0] if output_is_tuple else output

            mag = self.magnitudes.get(layer_idx, 0.0)
            if mag == 0.0:
                return output

            steering_vec = direction * mag

            if self.position == "all":
                hidden_states = hidden_states + steering_vec.unsqueeze(0).unsqueeze(0)
            elif self.position == "last":
                hidden_states = hidden_states.clone()
                hidden_states[:, -1, :] += steering_vec
            else:
                raise ValueError(f"Unknown position mode: {self.position}")

            if output_is_tuple:
                return (hidden_states,) + output[1:]
            else:
                return hidden_states

        return hook_fn

    def attach_hooks(self):
        """Register forward hooks on model layers."""
        self.remove_hooks()

        for layer_idx in self.magnitudes:
            if layer_idx not in self.directions:
                print(f"Warning: no direction for layer {layer_idx}, skipping")
                continue

            layer_module = _get_layer_module(self.model, layer_idx)
            hook = layer_module.register_forward_hook(self._make_hook(layer_idx))
            self.hooks.append(hook)

        print(f"Attached {len(self.hooks)} steering hooks")

    def remove_hooks(self):
        """Remove all registered hooks."""
        for hook in self.hooks:
            hook.remove()
        self.hooks = []


# ── Text generation helper ────────────────────────────────────────────────────

def generate_text(model, tokenizer, prompt, max_new_tokens=50):
    """Generate text from a causal LM."""
    inputs = tokenizer(prompt, return_tensors="pt").to(next(model.parameters()).device)
    with torch.no_grad():
        output_ids = model.generate(
            **inputs, max_new_tokens=max_new_tokens,
            do_sample=True, temperature=0.7, top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
        )
    return tokenizer.decode(output_ids[0], skip_special_tokens=True)


# ── Main demo ─────────────────────────────────────────────────────────────────

def main():
    model, tokenizer = load_model()
    n_layers = model.config.num_hidden_layers

    # --- Contrastive prompts: happy vs sad ---
    positive_prompts = [
        "The morning light feels like a fresh start full of endless possibilities.",
        "I am genuinely thrilled to see how much progress we’ve made together.",
        "It is such a gift to be surrounded by people who inspire and uplift me.",
        "Every challenge is just a stepping stone toward something even better.",
        "The world is vibrating with color and the simple joy of being alive.",
        "I feel a deep sense of peace and excitement for what the future holds.",
        "There is so much beauty in the small, everyday moments if you look for it.",
        "I’m overflowing with gratitude for the kindness I’ve encountered today.",
        "Let’s celebrate this achievement; it’s a testament to our hard work!",
        "I feel very hopeful for the idea. It will work."
    ]
    negative_prompts = [
        "The gray sky feels like a heavy blanket that will never lift.",
        "I am deeply discouraged by how everything keeps falling apart.",
        "It is exhausting to be constantly let down by everyone around me.",
        "Every attempt at progress feels like a futile struggle against the inevitable.",
        "The world feels cold, hollow, and drained of any real meaning.",
        "I feel a profound sense of dread when I think about what lies ahead.",
        "The small moments of life are just distractions from the underlying sadness.",
        "I am weighed down by the constant disappointments and missed chances.",
        "Why bother celebrating when everything is eventually going to fail anyway?",
        "I feel heavy, depleted, and utterly trapped in this cycle of misery."    
    ]

    # Target the last few layers (typically most effective)
    target_layers = list(range(max(0, n_layers - 4), n_layers))
    print(f"\nExtracting happy/sad directions from layers {target_layers}...")
    directions = extract_directions(
        model, tokenizer, positive_prompts, negative_prompts, target_layers
    )

    # --- Generate with steering ---
    test_prompt = "Today I woke up and"
    print(f"\n{'='*60}")
    print(f"Test prompt: \"{test_prompt}\"")
    print(f"{'='*60}")

    # Baseline (no steering)
    print(f"\n[Baseline — no steering]")
    print(generate_text(model, tokenizer, test_prompt))

    # Positive steering (push toward happy)
    steerer = TextEncoderSteerer(model, directions)
    magnitudes = {layer: 10.0 for layer in target_layers}
    steerer.set_magnitudes(magnitudes)
    steerer.attach_hooks()
    print(f"\n[Steered +10.0 — toward happy]")
    print(generate_text(model, tokenizer, test_prompt))
    steerer.remove_hooks()

    # Negative steering (push toward sad)
    neg_magnitudes = {layer: -10.0 for layer in target_layers}
    steerer.set_magnitudes(neg_magnitudes)
    steerer.attach_hooks()
    print(f"\n[Steered -10.0 — toward sad]")
    print(generate_text(model, tokenizer, test_prompt))
    steerer.remove_hooks()

    # --- Save directions ---
    save_path = "directions_happy_sad_demo.pt"
    torch.save(directions, save_path)
    print(f"\nSaved directions to {save_path}")
    print("Done!")


if __name__ == "__main__":
    main()
