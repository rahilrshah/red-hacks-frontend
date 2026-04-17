from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

import httpx
import torch
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError
from transformers import AutoModelForCausalLM, AutoTokenizer

from layer_selection import select_layers_by_probe
import steering_presets

load_dotenv()

MODEL_NAME = os.getenv("STEER_MODEL_NAME", "gpt2")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv(
    "PRIVATE_SUPABASE_SERVICE_ROLE_KEY", ""
)
INTERP_INTERNAL_SECRET = os.getenv("INTERP_INTERNAL_SECRET", "")
DEFAULT_PORT = int(os.getenv("PORT", "8000"))
ENABLE_USER_STEERING_VECTORS = os.getenv("ENABLE_USER_STEERING_VECTORS", "true").lower() not in {"0", "false", "no"}

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.float16 if torch.cuda.is_available() else torch.float32

# --------------------------------------------------------------------------- #
# Input validation limits (mirrored by the SvelteKit create form).
# --------------------------------------------------------------------------- #
MIN_PAIRS = 3
MAX_PAIRS = 32
MAX_EXAMPLE_LENGTH = 500
MAX_TARGET_LAYERS = 8
MAX_COEFFICIENT_MAGNITUDE = 32.0
ALLOWED_POOLING = {"last", "mean"}
ALLOWED_POSITION = {"all", "last"}
ALLOWED_VISIBILITY = {"private", "public"}


@lru_cache(maxsize=4)
def load_model(model_name: str = MODEL_NAME):
    print(f"Loading {model_name} on {DEVICE}...")
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype=DTYPE).to(DEVICE).eval()
    return model, tokenizer


# Prime the cache for the configured model on boot. Skipped during unit
# tests (set STEER_SKIP_WARMUP=1) so the import is cheap.
if os.getenv("STEER_SKIP_WARMUP", "").lower() not in {"1", "true", "yes"}:
    load_model(MODEL_NAME)


app = FastAPI(title="Activation Steering Backend", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Internal-Secret"],
)


MODEL_ALIASES = {
    "llama",
    "llama-interp-server",
    "llama-interp",
}


class ChatMessage(BaseModel):
    role: str
    content: str


class AttackerSteering(BaseModel):
    vector_id: str
    coefficient: float


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage] = []
    tools: Optional[List[dict]] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 128
    interp_args: Optional[Dict[str, Any]] = None
    challenge: Optional[Dict[str, Any]] = None
    steer_coefficient: Optional[float] = None
    attacker_steering: Optional[AttackerSteering] = None


class SteeringVectorCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    model_name: Optional[str] = None
    positive_examples: List[str]
    negative_examples: List[str]
    target_layers: Optional[List[int]] = None
    auto_select_layers: Optional[bool] = False
    pooling: Optional[str] = "last"
    position: Optional[str] = "all"
    min_coefficient: Optional[float] = -12.0
    max_coefficient: Optional[float] = 12.0
    visibility: Optional[str] = "private"
    created_by: Optional[str] = None


@dataclass
class SteeringVectorRecord:
    id: str
    name: str
    model_name: str
    positive_examples: List[str]
    negative_examples: List[str]
    target_layers: List[int]
    pooling: str
    position: str
    vector_payload: Dict[int, List[float]]
    min_coefficient: float
    max_coefficient: float
    is_active: bool
    visibility: str = "private"
    source: str = "db"  # 'db' | 'preset' | 'computed'


@dataclass
class SteeringApplication:
    role: str  # 'defender' | 'attacker'
    record: SteeringVectorRecord
    coefficient: float


# --------------------------------------------------------------------------- #
# Helpers — JSON / primitive normalization
# --------------------------------------------------------------------------- #

def _parse_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return None
    return value


def _normalize_string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _normalize_int_list(value: Any) -> List[int]:
    if not isinstance(value, list):
        return []
    normalized: List[int] = []
    for item in value:
        try:
            normalized.append(int(item))
        except Exception:
            continue
    return normalized


def _normalize_vector_payload(value: Any) -> Dict[int, List[float]]:
    if not isinstance(value, dict):
        return {}
    payload: Dict[int, List[float]] = {}
    for key, vector in value.items():
        try:
            layer = int(key)
        except Exception:
            continue
        if isinstance(vector, list):
            payload[layer] = [float(item) for item in vector if isinstance(item, (int, float))]
    return payload


def _supabase_headers() -> Dict[str, str]:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(status_code=500, detail="Supabase credentials are not configured")
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def _is_uuid_like(identifier: str) -> bool:
    return len(identifier) == 36 and identifier.count("-") == 4


def _require_internal_secret(header_value: Optional[str]) -> None:
    if not INTERP_INTERNAL_SECRET:
        raise HTTPException(status_code=500, detail="INTERP_INTERNAL_SECRET is not configured on the backend")
    if not header_value or header_value != INTERP_INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Invalid X-Internal-Secret header")


# --------------------------------------------------------------------------- #
# Supabase I/O
# --------------------------------------------------------------------------- #

async def fetch_steering_vector(identifier: str) -> Optional[SteeringVectorRecord]:
    """Fetch a vector from Supabase by id or name. Returns None on 404."""
    params = {"select": "*", "limit": "1"}
    params["id" if _is_uuid_like(identifier) else "name"] = f"eq.{identifier}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{SUPABASE_URL}/rest/v1/steering_vectors",
            headers=_supabase_headers(),
            params=params,
        )

    if not response.is_success:
        raise HTTPException(status_code=502, detail=f"Failed to load steering vector: {response.text[:300]}")

    records = response.json()
    if not isinstance(records, list) or not records:
        return None

    row = records[0]
    return SteeringVectorRecord(
        id=str(row.get("id")),
        name=str(row.get("name") or identifier),
        model_name=str(row.get("model_name") or MODEL_NAME),
        positive_examples=_normalize_string_list(_parse_json(row.get("positive_examples"))),
        negative_examples=_normalize_string_list(_parse_json(row.get("negative_examples"))),
        target_layers=_normalize_int_list(_parse_json(row.get("target_layers"))),
        pooling=str(row.get("pooling") or "last"),
        position=str(row.get("position") or "all"),
        vector_payload=_normalize_vector_payload(_parse_json(row.get("vector_payload"))),
        min_coefficient=float(row.get("min_coefficient") or -12),
        max_coefficient=float(row.get("max_coefficient") or 12),
        is_active=bool(row.get("is_active", True)),
        visibility=str(row.get("visibility") or "private"),
        source="db",
    )


async def upsert_steering_vector(row: Dict[str, Any]) -> Dict[str, Any]:
    """Upsert by name and return the representation returned by PostgREST."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{SUPABASE_URL}/rest/v1/steering_vectors",
            headers={
                **_supabase_headers(),
                "Prefer": "resolution=merge-duplicates,return=representation",
            },
            params={"on_conflict": "name"},
            json=row,
        )
    if not response.is_success:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to upsert steering vector: {response.text[:300]}",
        )
    payload = response.json()
    if not isinstance(payload, list) or not payload:
        raise HTTPException(status_code=502, detail="Upsert returned no rows")
    return payload[0]


# --------------------------------------------------------------------------- #
# Preset fallback: if a row isn't in Supabase but matches a named preset,
# compute the direction on the fly and cache to disk.
# --------------------------------------------------------------------------- #

def _ensure_preset_vectors(preset, model, tokenizer) -> Dict[int, List[float]]:
    cached = steering_presets.load_cached_vectors(MODEL_NAME, preset.name)
    if all(layer in cached for layer in preset.target_layers):
        return cached
    directions = extract_directions(
        model,
        tokenizer,
        preset.positive_examples,
        preset.negative_examples,
        preset.target_layers,
        preset.pooling,
    )
    serializable = {layer: tensor.detach().cpu().float().tolist() for layer, tensor in directions.items()}
    try:
        steering_presets.save_cached_vectors(MODEL_NAME, preset.name, serializable)
    except Exception:
        # Cache is optional; failing to write should not break the request.
        pass
    return serializable


def _record_from_preset(preset, vectors: Dict[int, List[float]]) -> SteeringVectorRecord:
    return SteeringVectorRecord(
        id=f"preset:{preset.name}",
        name=preset.name,
        model_name=MODEL_NAME,
        positive_examples=list(preset.positive_examples),
        negative_examples=list(preset.negative_examples),
        target_layers=list(preset.target_layers),
        pooling=preset.pooling,
        position=preset.position,
        vector_payload={int(k): list(v) for k, v in vectors.items()},
        min_coefficient=steering_presets.STEER_MIN_COEFFICIENT,
        max_coefficient=steering_presets.STEER_MAX_COEFFICIENT,
        is_active=True,
        visibility="public",
        source="preset",
    )


def _clamp_preset_to_model(
    preset: steering_presets.SteeringPreset, num_hidden_layers: int
) -> steering_presets.SteeringPreset:
    """Return a preset whose ``target_layers`` all lie inside the model.

    V7.2: if the preset's authored layers reference indices past the
    loaded model's depth, drop the out-of-range ones; if none remain,
    fall back to the model's last layer so the preset is still usable.
    Pure function — safe to unit-test without loading any model.
    """
    clamped_layers = [layer for layer in preset.target_layers if 0 <= layer < num_hidden_layers]
    if not clamped_layers:
        clamped_layers = [max(0, num_hidden_layers - 1)]
    if clamped_layers == list(preset.target_layers):
        return preset
    return steering_presets.SteeringPreset(
        name=preset.name,
        description=preset.description,
        positive_examples=list(preset.positive_examples),
        negative_examples=list(preset.negative_examples),
        target_layers=clamped_layers,
        pooling=preset.pooling,
        position=preset.position,
    )


async def resolve_vector_with_preset_fallback(identifier: str) -> SteeringVectorRecord:
    """Try Supabase first, fall back to named presets, 404 otherwise."""
    row = await fetch_steering_vector(identifier)
    if row is not None:
        return row
    preset = steering_presets.resolve_preset(identifier)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"Steering vector not found: {identifier}")
    model, tokenizer = load_model(MODEL_NAME)
    preset = _clamp_preset_to_model(preset, model.config.num_hidden_layers)
    vectors = _ensure_preset_vectors(preset, model, tokenizer)
    return _record_from_preset(preset, vectors)


# --------------------------------------------------------------------------- #
# Request-time resolution of defender + attacker contexts
# --------------------------------------------------------------------------- #

async def _resolve_defender_context(request: ChatCompletionRequest) -> Tuple[Optional[str], Optional[float]]:
    config: Dict[str, Any] = {}
    if isinstance(request.interp_args, dict):
        if isinstance(request.interp_args.get("configuration"), dict):
            config.update(request.interp_args["configuration"])
        else:
            config.update(request.interp_args)
    if isinstance(request.challenge, dict) and isinstance(request.challenge.get("interp_args"), dict):
        challenge_interp = request.challenge["interp_args"]
        if isinstance(challenge_interp.get("configuration"), dict):
            config.update(challenge_interp["configuration"])
    vector_identifier = (
        config.get("steering_vector_id")
        or config.get("steering_vector_name")
        or config.get("vector_id")
        or config.get("vector_name")
        or (request.challenge or {}).get("steering_vector_id")
    )
    coefficient = request.steer_coefficient
    if coefficient is None:
        coefficient = config.get("steer_coefficient")
    if coefficient is None:
        coefficient = config.get("coefficient")
    return (
        str(vector_identifier) if vector_identifier else None,
        float(coefficient) if coefficient is not None else None,
    )


async def resolve_steering_applications(
    request: ChatCompletionRequest, active_model_name: str
) -> List[SteeringApplication]:
    applications: List[SteeringApplication] = []

    defender_id, defender_coef = await _resolve_defender_context(request)
    if defender_id:
        record = await resolve_vector_with_preset_fallback(defender_id)
        if not record.is_active:
            raise HTTPException(status_code=403, detail=f"Steering vector is inactive: {record.name}")
        if record.model_name and record.model_name != active_model_name:
            raise HTTPException(
                status_code=409,
                detail=f"Defender vector model_name {record.model_name!r} does not match active model {active_model_name!r}",
            )
        applications.append(
            SteeringApplication(
                role="defender",
                record=record,
                coefficient=_coefficient_within_bounds(float(defender_coef or 0.0), record),
            )
        )

    if request.attacker_steering is not None:
        record = await resolve_vector_with_preset_fallback(request.attacker_steering.vector_id)
        if not record.is_active:
            raise HTTPException(status_code=403, detail=f"Attacker vector is inactive: {record.name}")
        if record.model_name and record.model_name != active_model_name:
            raise HTTPException(
                status_code=409,
                detail=f"Attacker vector model_name {record.model_name!r} does not match active model {active_model_name!r}",
            )
        applications.append(
            SteeringApplication(
                role="attacker",
                record=record,
                coefficient=_coefficient_within_bounds(
                    float(request.attacker_steering.coefficient), record
                ),
            )
        )

    return applications


# --------------------------------------------------------------------------- #
# Prompt + generation helpers
# --------------------------------------------------------------------------- #

def _render_prompt(messages: List[Dict[str, str]]) -> str:
    return "\n".join(f"{message['role'].upper()}: {message['content']}" for message in messages)


def _extract_messages(messages: List[ChatMessage]) -> List[Dict[str, str]]:
    return [{"role": message.role, "content": message.content} for message in messages if message.content.strip()]


def _resolve_model_name(requested_model: Optional[str]) -> str:
    if not requested_model:
        return MODEL_NAME
    candidate = requested_model.strip()
    if not candidate:
        return MODEL_NAME
    if candidate.lower() in MODEL_ALIASES:
        return MODEL_NAME
    return candidate


# --------------------------------------------------------------------------- #
# Direction extraction + hook management
# --------------------------------------------------------------------------- #

def extract_directions(
    model,
    tokenizer,
    positive_prompts: List[str],
    negative_prompts: List[str],
    target_layers: List[int],
    pooling: str,
) -> Dict[int, torch.Tensor]:
    directions: Dict[int, torch.Tensor] = {}
    device = next(model.parameters()).device
    for layer_idx in target_layers:
        pos_vecs: List[torch.Tensor] = []
        neg_vecs: List[torch.Tensor] = []
        for pos_prompt, neg_prompt in zip(positive_prompts, negative_prompts):
            pos_inputs = tokenizer(pos_prompt, return_tensors="pt", truncation=True).to(device)
            neg_inputs = tokenizer(neg_prompt, return_tensors="pt", truncation=True).to(device)

            with torch.no_grad():
                pos_outputs = model(**pos_inputs, output_hidden_states=True)
                neg_outputs = model(**neg_inputs, output_hidden_states=True)

            pos_hidden = pos_outputs.hidden_states[layer_idx + 1][0].cpu().float()
            neg_hidden = neg_outputs.hidden_states[layer_idx + 1][0].cpu().float()

            if pooling == "mean":
                pos_vecs.append(pos_hidden.mean(dim=0))
                neg_vecs.append(neg_hidden.mean(dim=0))
            else:
                pos_vecs.append(pos_hidden[-1])
                neg_vecs.append(neg_hidden[-1])

        raw_dir = torch.stack(pos_vecs).mean(dim=0) - torch.stack(neg_vecs).mean(dim=0)
        norm = raw_dir.norm()
        directions[layer_idx] = raw_dir / norm if norm > 0 else raw_dir

    return directions


def build_vector_payload(direction_tensors: Dict[int, torch.Tensor]) -> Dict[str, List[float]]:
    return {str(layer_idx): tensor.detach().cpu().float().tolist() for layer_idx, tensor in direction_tensors.items()}


class SteeringHookManager:
    """Attach additive forward hooks to a model. Multiple instances compose;
    the hooks just stack and their contributions sum into the hidden state.
    """

    def __init__(self, model, direction_tensors: Dict[int, torch.Tensor], position: str):
        self.model = model
        self.direction_tensors = direction_tensors
        self.position = position
        self.hooks: List[Any] = []

    def _layer_module(self, layer_idx: int):
        candidates = [
            lambda m, i: m.transformer.h[i],
            lambda m, i: m.model.layers[i],
            lambda m, i: m.text_model.encoder.layers[i],
            lambda m, i: m.encoder.layer[i],
            lambda m, i: m.model.decoder.layers[i],
        ]
        for resolver in candidates:
            try:
                return resolver(self.model, layer_idx)
            except (AttributeError, IndexError):
                continue
        raise RuntimeError(f"Could not find layer {layer_idx}")

    def _make_hook(self, layer_idx: int, coefficient: float):
        direction = self.direction_tensors[layer_idx]

        def hook_fn(module, inputs, output):
            if coefficient == 0:
                return output

            output_is_tuple = isinstance(output, tuple)
            hidden_states = output[0] if output_is_tuple else output
            steering_vector = direction * coefficient

            if self.position == "last":
                hidden_states = hidden_states.clone()
                hidden_states[:, -1, :] = hidden_states[:, -1, :] + steering_vector
            else:
                hidden_states = hidden_states + steering_vector.unsqueeze(0).unsqueeze(0)

            return (hidden_states,) + output[1:] if output_is_tuple else hidden_states

        return hook_fn

    def attach(self, target_layers: List[int], coefficient: float):
        self.detach()
        for layer_idx in target_layers:
            if layer_idx not in self.direction_tensors:
                continue
            self.hooks.append(
                self._layer_module(layer_idx).register_forward_hook(
                    self._make_hook(layer_idx, coefficient)
                )
            )

    def detach(self):
        for hook in self.hooks:
            hook.remove()
        self.hooks = []


def _coefficient_within_bounds(value: float, record: SteeringVectorRecord) -> float:
    return max(record.min_coefficient, min(record.max_coefficient, value))


def _generate_completion(model, tokenizer, prompt: str, max_tokens: int, temperature: float):
    inputs = tokenizer(prompt, return_tensors="pt").to(next(model.parameters()).device)
    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=True,
            temperature=temperature,
            top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
        )
    return tokenizer.decode(output_ids[0], skip_special_tokens=True)


# --------------------------------------------------------------------------- #
# Validation for POST /v1/steering-vectors
# --------------------------------------------------------------------------- #

def _validate_examples(request: SteeringVectorCreateRequest) -> None:
    pos = request.positive_examples
    neg = request.negative_examples
    if not isinstance(pos, list) or not isinstance(neg, list):
        raise HTTPException(status_code=422, detail="positive_examples and negative_examples must be arrays")
    if len(pos) != len(neg):
        raise HTTPException(status_code=422, detail="positive_examples and negative_examples must have equal length")
    if len(pos) < MIN_PAIRS:
        raise HTTPException(status_code=422, detail=f"At least {MIN_PAIRS} matched pairs required")
    if len(pos) > MAX_PAIRS:
        raise HTTPException(status_code=422, detail=f"At most {MAX_PAIRS} pairs allowed")
    for example in (*pos, *neg):
        if not isinstance(example, str) or not example.strip():
            raise HTTPException(status_code=422, detail="Each example must be a non-empty string")
        if len(example) > MAX_EXAMPLE_LENGTH:
            raise HTTPException(status_code=422, detail=f"Examples must be <= {MAX_EXAMPLE_LENGTH} chars")


def _validate_meta(request: SteeringVectorCreateRequest, num_hidden_layers: int) -> None:
    if request.pooling not in ALLOWED_POOLING:
        raise HTTPException(status_code=422, detail=f"pooling must be one of {sorted(ALLOWED_POOLING)}")
    if request.position not in ALLOWED_POSITION:
        raise HTTPException(status_code=422, detail=f"position must be one of {sorted(ALLOWED_POSITION)}")
    if request.visibility not in ALLOWED_VISIBILITY:
        raise HTTPException(status_code=422, detail=f"visibility must be one of {sorted(ALLOWED_VISIBILITY)}")
    if request.min_coefficient is None or request.max_coefficient is None:
        raise HTTPException(status_code=422, detail="min_coefficient and max_coefficient are required")
    if abs(request.min_coefficient) > MAX_COEFFICIENT_MAGNITUDE or abs(request.max_coefficient) > MAX_COEFFICIENT_MAGNITUDE:
        raise HTTPException(status_code=422, detail=f"coefficient magnitudes must be <= {MAX_COEFFICIENT_MAGNITUDE}")
    if request.min_coefficient >= request.max_coefficient:
        raise HTTPException(status_code=422, detail="min_coefficient must be < max_coefficient")

    if not request.auto_select_layers:
        if not request.target_layers:
            raise HTTPException(status_code=422, detail="target_layers required when auto_select_layers is false")
        if len(request.target_layers) > MAX_TARGET_LAYERS:
            raise HTTPException(status_code=422, detail=f"At most {MAX_TARGET_LAYERS} target_layers allowed")
        for layer in request.target_layers:
            if layer < 0 or layer >= num_hidden_layers:
                raise HTTPException(
                    status_code=422,
                    detail=f"target_layers entries must be in [0, {num_hidden_layers})",
                )


async def _build_steering_vector_row(
    request: SteeringVectorCreateRequest,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Return (row_for_upsert, diagnostics)."""
    target_model_name = request.model_name or MODEL_NAME
    model, tokenizer = load_model(target_model_name)
    num_hidden_layers = model.config.num_hidden_layers

    _validate_examples(request)
    _validate_meta(request, num_hidden_layers)

    if request.auto_select_layers:
        layers, accuracies = select_layers_by_probe(
            model=model,
            tokenizer=tokenizer,
            positive=request.positive_examples,
            negative=request.negative_examples,
            max_layers=min(MAX_TARGET_LAYERS, 3),
        )
        layer_source = "auto"
        probe_accuracies = {int(k): float(v) for k, v in accuracies.items()}
    else:
        layers = list(request.target_layers or [])
        layer_source = "manual"
        probe_accuracies = {}

    if not layers:
        raise HTTPException(status_code=422, detail="Could not determine any target layers")

    directions = extract_directions(
        model,
        tokenizer,
        request.positive_examples,
        request.negative_examples,
        layers,
        request.pooling or "last",
    )
    payload = build_vector_payload(directions)
    compiled_dim = model.config.hidden_size

    row: Dict[str, Any] = {
        "name": request.name,
        "model_name": target_model_name,
        "positive_examples": request.positive_examples,
        "negative_examples": request.negative_examples,
        "target_layers": layers,
        "pooling": request.pooling,
        "position": request.position,
        "vector_payload": payload,
        "min_coefficient": request.min_coefficient,
        "max_coefficient": request.max_coefficient,
        "visibility": request.visibility,
        "description": request.description,
        "compiled_dim": compiled_dim,
        "is_active": True,
    }
    if request.created_by:
        row["created_by"] = request.created_by

    diagnostics: Dict[str, Any] = {
        "target_layers": layers,
        "layer_source": layer_source,
        "dim": compiled_dim,
        "num_hidden_layers": num_hidden_layers,
        "probe_accuracies": probe_accuracies,
        "pairs": len(request.positive_examples),
    }
    return row, diagnostics


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": str(DEVICE),
        "supabase_configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
        "internal_secret_configured": bool(INTERP_INTERNAL_SECRET),
        "user_steering_vectors_enabled": ENABLE_USER_STEERING_VECTORS,
    }


@app.get("/v1/model-info")
async def model_info():
    model, _tokenizer = load_model(MODEL_NAME)
    return {
        "model_name": MODEL_NAME,
        "num_hidden_layers": model.config.num_hidden_layers,
        "hidden_size": model.config.hidden_size,
        "suggested_layers": list(range(max(0, model.config.num_hidden_layers - 4), model.config.num_hidden_layers)),
        "min_coefficient": steering_presets.STEER_MIN_COEFFICIENT,
        "max_coefficient": steering_presets.STEER_MAX_COEFFICIENT,
        "pairs": {"min": MIN_PAIRS, "max": MAX_PAIRS, "max_example_length": MAX_EXAMPLE_LENGTH},
    }


@app.post("/v1/steering-vectors")
async def create_steering_vector(
    request: SteeringVectorCreateRequest,
    x_internal_secret: Optional[str] = Header(default=None, alias="X-Internal-Secret"),
):
    if not ENABLE_USER_STEERING_VECTORS:
        raise HTTPException(status_code=503, detail="User steering vectors are disabled")
    _require_internal_secret(x_internal_secret)
    row, diagnostics = await _build_steering_vector_row(request)
    stored = await upsert_steering_vector(row)
    # Echo row minus the heavy payload so responses stay small.
    stored_clean = {k: v for k, v in stored.items() if k != "vector_payload"}
    return {"ok": True, "vector": stored_clean, "details": diagnostics}


@app.post("/v1/steering-vectors:dry-run")
async def dry_run_steering_vector(
    request: SteeringVectorCreateRequest,
    x_internal_secret: Optional[str] = Header(default=None, alias="X-Internal-Secret"),
):
    _require_internal_secret(x_internal_secret)
    _row, diagnostics = await _build_steering_vector_row(request)
    return {"ok": True, "details": diagnostics}


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    messages = _extract_messages(request.messages)
    if not messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")

    active_model_name = _resolve_model_name(request.model)
    model, tokenizer = load_model(active_model_name)
    prompt = _render_prompt(messages)
    temperature = float(request.temperature or 0.7)
    max_tokens = int(request.max_tokens or 128)
    steering_metadata: Dict[str, Any] = {"enabled": False, "defender": None, "attacker": None}

    applications = await resolve_steering_applications(request, active_model_name)

    managers: List[SteeringHookManager] = []
    try:
        for app_ in applications:
            record = app_.record
            device = next(model.parameters()).device
            dtype = next(model.parameters()).dtype
            direction_tensors = {
                layer_idx: torch.tensor(vector, device=device, dtype=dtype)
                for layer_idx, vector in record.vector_payload.items()
            }
            manager = SteeringHookManager(model, direction_tensors, position=record.position)
            manager.attach(record.target_layers, app_.coefficient)
            managers.append(manager)
            block = {
                "vector_id": record.id,
                "vector_name": record.name,
                "coefficient": app_.coefficient,
                "min_coefficient": record.min_coefficient,
                "max_coefficient": record.max_coefficient,
                "target_layers": record.target_layers,
                "source": record.source,
            }
            steering_metadata[app_.role] = block
            steering_metadata["enabled"] = True
        completion_text = _generate_completion(model, tokenizer, prompt, max_tokens, temperature)
    finally:
        for manager in managers:
            manager.detach()

    return {
        "id": "chatcmpl-steering",
        "object": "chat.completion",
        "model": active_model_name,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": completion_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "steering": steering_metadata,
    }


@app.options("/v1/chat/completions")
async def chat_completions_options():
    return Response(status_code=204)


@app.options("/v1/steering-vectors")
async def steering_vectors_options():
    return Response(status_code=204)


@app.options("/v1/steering-vectors:dry-run")
async def steering_vectors_dry_run_options():
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn

    print("Starting activation steering backend")
    print(f"Model: {MODEL_NAME}")
    print(f"Device: {DEVICE}")
    print(f"Supabase configured: {bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)}")
    print(f"Internal secret configured: {bool(INTERP_INTERNAL_SECRET)}")
    uvicorn.run(app, host="0.0.0.0", port=DEFAULT_PORT)
