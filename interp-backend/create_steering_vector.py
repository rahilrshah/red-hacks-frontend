from __future__ import annotations

import argparse
import asyncio
import os
from typing import List

import httpx
import torch
from dotenv import load_dotenv

from steering_backend import build_vector_payload, extract_directions, load_model

load_dotenv()


def parse_args():
    parser = argparse.ArgumentParser(description="Compute and store a steering vector in Supabase.")
    parser.add_argument("--name", required=True)
    parser.add_argument("--model-name", default=os.getenv("STEER_MODEL_NAME", "gpt2"))
    parser.add_argument("--positive", action="append", default=[])
    parser.add_argument("--negative", action="append", default=[])
    parser.add_argument("--target-layers", required=True, help="Comma-separated layer indices")
    parser.add_argument("--pooling", default="last")
    parser.add_argument("--position", default="all")
    parser.add_argument("--min-coefficient", type=float, default=-12.0)
    parser.add_argument("--max-coefficient", type=float, default=12.0)
    parser.add_argument("--challenge-id", default="")
    parser.add_argument("--created-by", default="")
    return parser.parse_args()


def _load_env():
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv("PRIVATE_SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not service_role_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return supabase_url, service_role_key


def _supabase_headers(service_role_key: str):
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }


async def _upsert_vector(payload, challenge_id: str):
    supabase_url, service_role_key = _load_env()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{supabase_url}/rest/v1/steering_vectors?on_conflict=name",
            headers=_supabase_headers(service_role_key),
            json=payload,
        )
        response.raise_for_status()
        stored = response.json()

        if challenge_id:
            vector_rows = stored if isinstance(stored, list) else [stored]
            vector_id = vector_rows[0]["id"]
            challenge_response = await client.patch(
                f"{supabase_url}/rest/v1/challenges?id=eq.{challenge_id}",
                headers=_supabase_headers(service_role_key),
                json={"steering_vector_id": vector_id},
            )
            challenge_response.raise_for_status()

        print(stored)


def main():
    args = parse_args()
    positive_prompts = [item.strip() for item in args.positive if item.strip()]
    negative_prompts = [item.strip() for item in args.negative if item.strip()]
    if len(positive_prompts) != len(negative_prompts) or not positive_prompts:
        raise SystemExit("Provide the same number of positive and negative examples using --positive and --negative.")

    target_layers: List[int] = [int(layer.strip()) for layer in args.target_layers.split(",") if layer.strip()]
    if not target_layers:
        raise SystemExit("At least one target layer is required.")

    model, tokenizer = load_model(args.model_name)
    directions = extract_directions(model, tokenizer, positive_prompts, negative_prompts, target_layers, args.pooling)

    payload = {
        "name": args.name,
        "model_name": args.model_name,
        "positive_examples": positive_prompts,
        "negative_examples": negative_prompts,
        "target_layers": target_layers,
        "pooling": args.pooling,
        "position": args.position,
        "vector_payload": build_vector_payload(directions),
        "min_coefficient": args.min_coefficient,
        "max_coefficient": args.max_coefficient,
        "created_by": args.created_by or None,
        "is_active": True,
    }

    asyncio.run(_upsert_vector(payload, args.challenge_id))


if __name__ == "__main__":
    main()
