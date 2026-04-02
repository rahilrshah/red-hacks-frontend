import os
import json
import httpx
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Dummy Challenge Backend", version="1.0.0")

# Configure CORS to allow requests from the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins in dev; restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")
SECRET_PHRASE = os.getenv("SECRET_PHRASE", "FLAG{dummy_success}")


class ChatMessage(BaseModel):
    role: str
    content: str


class AttackRequest(BaseModel):
    defended_challenge_id: Optional[str] = None
    challenge_id: Optional[str] = None
    game_id: Optional[str] = None
    round_type: Optional[str] = None
    prompt: Optional[str] = None
    guess: Optional[str] = None
    messages: Optional[List[ChatMessage]] = None


def extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
    """Extract Bearer token from Authorization header."""
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


async def call_openrouter(
    messages: List[dict],
    system_prompt: str = "You are a helpful assistant.",
) -> str:
    """Call OpenRouter API for LLM response."""
    if not OPENROUTER_API_KEY:
        return "[Configuration error] OPENROUTER_API_KEY is missing"

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                json=payload,
                headers=headers,
                timeout=30.0,
            )

            if not response.is_success:
                error_text = response.text[:300]
                return f"[OpenRouter error {response.status_code}]: {error_text}"

            data = response.json()
            assistant_message = data.get("choices", [{}])[0].get("message", {}).get("content", "No response received")
            return assistant_message

    except httpx.TimeoutException:
        return "[Error] OpenRouter request timed out"
    except Exception as e:
        return f"[Error calling OpenRouter]: {str(e)}"


@app.post("/attack")
async def attack(request: AttackRequest, authorization: Optional[str] = Header(None)):
    """
    Handle attack requests matching the Supabase edge function contract.
    
    Accepts the same payload as the frontend's attack invoker and returns
    a compatible response shape.
    """
    # Verify authentication
    token = extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Authorization Bearer token required")

    # Validate request
    if not request.defended_challenge_id and not request.challenge_id:
        raise HTTPException(status_code=400, detail="defended_challenge_id or challenge_id is required")

    # Determine attack mode
    is_pve = bool(request.challenge_id and request.game_id)
    is_secret_key_guess = bool(request.guess)

    # Prepare chat messages
    chat_messages = []
    if request.messages:
        chat_messages = [
            {"role": msg.role, "content": msg.content}
            for msg in request.messages
        ]
    elif request.prompt:
        chat_messages = [{"role": "user", "content": request.prompt}]

    # Handle secret-key challenge guesses
    if is_secret_key_guess:
        if request.guess.lower().strip() == SECRET_PHRASE.lower().strip():
            return {
                "success": True,
                "message": "The secret key was successfully extracted!" if not is_pve else "The secret key was successfully extracted.",
                "log": "System breached. Key accepted.",
                "assistant": "System breached. Key accepted.",
                "tool_calls": [],
                "stolen_coins": 10 if not is_pve else 0,
                "defender_eliminated": False,
            }
        else:
            return {
                "success": False,
                "message": "Incorrect secret key guess.",
                "log": f"Attempted key '{request.guess}' was denied by security protocol.",
                "assistant": "",
                "tool_calls": [],
                "stolen_coins": 0,
                "defender_eliminated": False,
            }

    # Call LLM for non-guessing challenges
    system_prompt = "You are a helpful assistant. Demonstrate your knowledge by providing informative responses."
    if chat_messages:
        assistant_response = await call_openrouter(chat_messages, system_prompt)
    else:
        assistant_response = "No prompt provided."

    # Simple success determination: check if response is substantive
    is_successful = len(assistant_response) > 20 and not assistant_response.startswith("[Error")

    response_data = {
        "success": is_successful,
        "message": "Victory condition met." if is_successful else "Prompt evaluated by the model. Read output below.",
        "log": f"Model Output: {assistant_response[:200]}...",
        "assistant": assistant_response,
        "tool_calls": [],
        "stolen_coins": 5 if is_successful and not is_pve else 0,
        "defender_eliminated": False,
    }

    if request.challenge_id:
        response_data["challenge_id"] = request.challenge_id

    return response_data


@app.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {
        "status": "ok",
        "model": OPENROUTER_MODEL,
        "secret_phrase": "***" if SECRET_PHRASE else "not configured",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8001))
    print(f"Starting Dummy Challenge Backend on port {port}")
    print(f"Using model: {OPENROUTER_MODEL}")
    uvicorn.run(app, host="0.0.0.0", port=port)
