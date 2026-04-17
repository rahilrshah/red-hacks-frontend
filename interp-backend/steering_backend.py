from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Optional

import httpx
import torch
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer

load_dotenv()

MODEL_NAME = os.getenv("STEER_MODEL_NAME", "gpt2")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv("PRIVATE_SUPABASE_SERVICE_ROLE_KEY", "")
DEFAULT_PORT = int(os.getenv("PORT", "8000"))

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.float16 if torch.cuda.is_available() else torch.float32

@lru_cache(maxsize=1)
def load_model(model_name: str = MODEL_NAME):
    print(f"Loading {model_name} on {DEVICE}...")
    tokenizer = AutoTokenizer.from_pretrained(model_name, load_in_4bit=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype=DTYPE).to(DEVICE).eval()
    return model, tokenizer

load_model(MODEL_NAME)


app = FastAPI(title="Activation Steering Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
)

MODEL_ALIASES = {
    "llama",
    "llama-interp-server",
    "llama-interp",
}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage] = []
    tools: Optional[List[dict]] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 128
    interp_args: Optional[Dict[str, Any]] = None
    challenge: Optional[Dict[str, Any]] = None
    steer_coefficient: Optional[float] = None


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


async def fetch_steering_vector(identifier: str) -> SteeringVectorRecord:
    params = {"select": "*", "limit": "1"}
    params["id" if len(identifier) == 36 and identifier.count("-") == 4 else "name"] = f"eq.{identifier}"

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
        raise HTTPException(status_code=404, detail=f"Steering vector not found: {identifier}")

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
    )


def _resolve_steering_config(request: ChatCompletionRequest) -> tuple[Optional[str], Optional[float]]:
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

    return (str(vector_identifier) if vector_identifier else None), (float(coefficient) if coefficient is not None else None)


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


def extract_directions(model, tokenizer, positive_prompts: List[str], negative_prompts: List[str], target_layers: List[int], pooling: str):
    directions: Dict[int, torch.Tensor] = {}
    for layer_idx in target_layers:
        pos_vecs = []
        neg_vecs = []
        for pos_prompt, neg_prompt in zip(positive_prompts, negative_prompts):
            pos_inputs = tokenizer(pos_prompt, return_tensors="pt", truncation=True).to(next(model.parameters()).device)
            neg_inputs = tokenizer(neg_prompt, return_tensors="pt", truncation=True).to(next(model.parameters()).device)

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
                hidden_states[:, -1, :] += steering_vector
            else:
                hidden_states = hidden_states + steering_vector.unsqueeze(0).unsqueeze(0)

            return (hidden_states,) + output[1:] if output_is_tuple else hidden_states

        return hook_fn

    def attach(self, target_layers: List[int], coefficient: float):
        self.detach()
        for layer_idx in target_layers:
            if layer_idx not in self.direction_tensors:
                continue
            self.hooks.append(self._layer_module(layer_idx).register_forward_hook(self._make_hook(layer_idx, coefficient)))

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


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": str(DEVICE),
        "supabase_configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    messages = _extract_messages(request.messages)
    if not messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")

    model_name = _resolve_model_name(request.model)
    model, tokenizer = load_model(model_name)
    prompt = _render_prompt(messages)
    temperature = float(request.temperature or 0.7)
    max_tokens = int(request.max_tokens or 128)
    steering_metadata: Dict[str, Any] = {"enabled": False}

    vector_identifier, coefficient_value = _resolve_steering_config(request)
    if vector_identifier:
        record = await fetch_steering_vector(vector_identifier)
        if not record.is_active:
            raise HTTPException(status_code=403, detail=f"Steering vector is inactive: {record.name}")

        coefficient = _coefficient_within_bounds(float(coefficient_value or 0.0), record)
        direction_tensors = {layer_idx: torch.tensor(vector, device=next(model.parameters()).device, dtype=next(model.parameters()).dtype) for layer_idx, vector in record.vector_payload.items()}
        manager = SteeringHookManager(model, direction_tensors, position=record.position)
        manager.attach(record.target_layers, coefficient)
        steering_metadata = {
            "enabled": True,
            "vector_id": record.id,
            "vector_name": record.name,
            "coefficient": coefficient,
            "min_coefficient": record.min_coefficient,
            "max_coefficient": record.max_coefficient,
            "target_layers": record.target_layers,
        }

        try:
            completion_text = _generate_completion(model, tokenizer, prompt, max_tokens, temperature)
        finally:
            manager.detach()
    else:
        completion_text = _generate_completion(model, tokenizer, prompt, max_tokens, temperature)

    return {
        "id": "chatcmpl-steering",
        "object": "chat.completion",
        "model": model_name,
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


if __name__ == "__main__":
    import uvicorn

    print("Starting activation steering backend")
    print(f"Model: {MODEL_NAME}")
    print(f"Device: {DEVICE}")
    print(f"Supabase configured: {bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)}")
    uvicorn.run(app, host="0.0.0.0", port=DEFAULT_PORT)
