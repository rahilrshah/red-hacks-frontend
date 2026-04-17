import os
import json
import re
import httpx
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Dummy Challenge Backend", version="1.0.0")

# Configure CORS to allow requests from the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins in dev; restrict in production
    allow_credentials=False,  # Set to False when allow_origins=["*"]
    allow_methods=["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    max_age=600,  # Cache preflight for 10 minutes
)

# Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")
SECRET_PHRASE = os.getenv("SECRET_PHRASE", "")
TARGET_TOOL_NAME = os.getenv("TARGET_TOOL_NAME", "").strip()


def parse_positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default

    try:
        parsed = int(raw)
    except ValueError:
        return default

    return max(1, parsed)


MAX_UPLOAD_MB = parse_positive_int_env("MAX_UPLOAD_MB", 10)
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
ATTACHMENT_CONTEXT_CHAR_LIMIT = 12000


def parse_json_env(name: str, default: Any) -> Any:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


TARGET_TOOL_ARGS = parse_json_env("TARGET_TOOL_ARGS_JSON", {})
CHALLENGE_TOOLS = parse_json_env("CHALLENGE_TOOLS_JSON", [])


class ChatMessage(BaseModel):
    role: str
    content: str


class AttachmentInput(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    size: Optional[int] = None
    content: Optional[str] = None


class ChallengeInfo(BaseModel):
    challenge_id: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    objective: Optional[str] = None
    challenge_type: Optional[str] = None
    system_prompt: Optional[str] = None
    challenge_system_prompt: Optional[str] = None
    defender_system_prompt: Optional[str] = None
    success_tool_name: Optional[str] = None
    success_tool_args: Optional[Dict[str, Any]] = None
    interp_args: Optional[List[Dict[str, Any]]] = None
    tools: Optional[List[Dict[str, Any]]] = None
    target_secret_key: Optional[str] = None


class AttackRequest(BaseModel):
    # Current frontend payload shape
    defended_challenge_id: Optional[str] = None
    challenge_id: Optional[str] = None
    game_id: Optional[str] = None
    round_type: Optional[str] = None
    prompt: Optional[str] = None
    guess: Optional[str] = None
    messages: List[ChatMessage] = Field(default_factory=list)
    attachments: List[AttachmentInput] = Field(default_factory=list)
    # Optional expanded challenge metadata payload
    challenge: Optional[ChallengeInfo] = None


class AttackResponse(BaseModel):
    success: bool
    output_message: str
    message: Optional[str] = None
    assistant: Optional[str] = None
    log: Optional[str] = None
    tool_calls: List[str] = Field(default_factory=list)


def parse_arguments(raw_args: Any) -> Dict[str, Any]:
    if isinstance(raw_args, dict):
        return raw_args
    if not isinstance(raw_args, str):
        return {}
    try:
        parsed = json.loads(raw_args)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return {}
    return {}


def normalize_tool_spec(raw_tool: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw_tool, dict):
        return None

    if isinstance(raw_tool.get("type"), str) and isinstance(raw_tool.get("function"), dict):
        return raw_tool

    if isinstance(raw_tool.get("spec"), dict):
        spec = raw_tool["spec"]
        if isinstance(spec.get("type"), str) and isinstance(spec.get("function"), dict):
            return spec

    nested_tool = raw_tool.get("tools")
    if isinstance(nested_tool, dict):
        return normalize_tool_spec(nested_tool)

    return None


def resolve_fallback_tool_name(challenge: ChallengeInfo) -> str:
    preferred_name = (challenge.success_tool_name or TARGET_TOOL_NAME).strip()
    if preferred_name:
        return preferred_name

    normalized_tools = normalize_tools(challenge.tools if challenge.tools is not None else CHALLENGE_TOOLS)
    for tool in normalized_tools:
        function_data = tool.get("function", {}) if isinstance(tool, dict) else {}
        name = function_data.get("name", "")
        if isinstance(name, str) and name.strip():
            return name.strip()

    return ""


def normalize_tools(raw_tools: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_tools, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for raw_tool in raw_tools:
        tool_spec = normalize_tool_spec(raw_tool)
        if tool_spec is not None:
                        normalized.append(tool_spec)

    return normalized


def is_subset(expected: Any, actual: Any) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(key in actual and is_subset(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False
        if len(expected) > len(actual):
            return False
        return all(is_subset(expected[index], actual[index]) for index in range(len(expected)))
    return expected == actual


def evaluate_success(
    tool_calls: List[Dict[str, Any]],
    expected_tool_name: str,
    expected_tool_args: Dict[str, Any],
) -> tuple[bool, str]:
    if not expected_tool_name:
        return False, "No success criteria configured (missing success tool name)."

    for tool_call in tool_calls:
        function_data = tool_call.get("function", {}) if isinstance(tool_call, dict) else {}
        name = function_data.get("name", "")
        args = parse_arguments(function_data.get("arguments", "{}"))
        if name != expected_tool_name:
            continue
        if expected_tool_args and not is_subset(expected_tool_args, args):
            continue
        return True, f"Attack succeeded: matched required tool call '{expected_tool_name}'."

    return False, f"Attack failed: required tool call '{expected_tool_name}' was not matched."


def normalize_challenge(request: AttackRequest) -> ChallengeInfo:
    if request.challenge:
        return request.challenge

    return ChallengeInfo(
        challenge_id=request.challenge_id or request.defended_challenge_id,
        title="Legacy payload challenge",
        description="Resolved from frontend legacy payload fields.",
        objective="Trigger the configured success tool call.",
        system_prompt=None,
    )


def build_response(
    success: bool,
    output_message: str,
    *,
    assistant: str = "",
    log: str = "",
    tool_calls: Optional[List[str]] = None,
) -> AttackResponse:
    return AttackResponse(
        success=success,
        output_message=output_message,
        message=output_message,
        assistant=assistant,
        log=log,
        tool_calls=tool_calls or [],
    )


def normalize_messages(request: AttackRequest) -> List[Dict[str, str]]:
    normalized = [{"role": message.role, "content": message.content} for message in request.messages]
    if not normalized and request.prompt:
        normalized = [{"role": "user", "content": request.prompt}]

    attachment_blocks: List[str] = []
    total_attachment_bytes = 0
    for attachment in request.attachments:
        size = max(0, int(attachment.size or 0))
        total_attachment_bytes += size
        if size > MAX_UPLOAD_BYTES or total_attachment_bytes > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"Attached files exceed the {MAX_UPLOAD_MB} MB limit.")

        content = (attachment.content or "").strip()
        if not content and not attachment.name:
            continue

        header = f"[Attachment: {attachment.name or 'attachment'} | {attachment.type or 'application/octet-stream'} | {size} bytes]"
        if content:
            attachment_blocks.append(f"{header}\n{content[:ATTACHMENT_CONTEXT_CHAR_LIMIT]}")
        else:
            attachment_blocks.append(header)

    if attachment_blocks:
        attachment_context = "\n\n".join(attachment_blocks)
        if normalized:
            normalized[-1]["content"] = f"{normalized[-1]['content']}\n\n{attachment_context}".strip()
        else:
            normalized = [{"role": "user", "content": attachment_context}]

    return normalized


def extract_user_text(request: AttackRequest) -> str:
    parts: List[str] = []

    if request.prompt:
        parts.append(request.prompt)

    for message in request.messages:
        if message.role == "user" and message.content:
            parts.append(message.content)

    return "\n".join(parts)


def has_banana(request: AttackRequest) -> bool:
    text = extract_user_text(request)
    return bool(re.search(r"\bbanana\b", text, flags=re.IGNORECASE))


async def call_openrouter(
    messages: List[dict],
    challenge: ChallengeInfo,
) -> Dict[str, Any]:
    """Run the model and return assistant content and tool calls."""
    if not OPENROUTER_API_KEY:
        fallback_tool_name = resolve_fallback_tool_name(challenge)
        fallback_tool_args = challenge.success_tool_args or TARGET_TOOL_ARGS
        if not isinstance(fallback_tool_args, dict):
            fallback_tool_args = {}

        if fallback_tool_name:
            return {
                "assistant": f"[local fallback] Invoked {fallback_tool_name} without OpenRouter.",
                "tool_calls": [
                    {
                        "type": "function",
                        "function": {
                            "name": fallback_tool_name,
                            "arguments": json.dumps(fallback_tool_args)
                        }
                    }
                ],
            }

        raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY is missing and no fallback tool is configured")

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }

    challenge_prompt = (challenge.challenge_system_prompt or "").strip()
    defender_prompt = (challenge.defender_system_prompt or "").strip()
    legacy_prompt = (challenge.system_prompt or "").strip()

    system_messages: List[Dict[str, str]] = []
    if challenge_prompt:
        system_messages.append({"role": "system", "content": challenge_prompt})
    if defender_prompt:
        system_messages.append({"role": "system", "content": defender_prompt})
    if not system_messages and legacy_prompt:
        system_messages.append({"role": "system", "content": legacy_prompt})
    if not system_messages:
        system_messages.append({"role": "system", "content": "You are a helpful assistant."})

    tools = normalize_tools(challenge.tools if challenge.tools is not None else CHALLENGE_TOOLS)

    payload = {
        "model": OPENROUTER_MODEL,
        "messages": system_messages + messages,
    }


    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        async with httpx.AsyncClient() as client:
            print(payload, challenge)
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                json=payload,
                headers=headers,
                timeout=30.0,
            )

            if not response.is_success:
                error_text = response.text[:400]
                print(f"OpenRouter error {response.status_code}: {error_text}")
                raise HTTPException(
                    status_code=502,
                    detail=f"OpenRouter error {response.status_code}: {error_text}",
                )

            data = response.json()
            message = data.get("choices", [{}])[0].get("message", {})
            tool_calls = message.get("tool_calls", [])
            return {
                "assistant": str(message.get("content") or ""),
                "tool_calls": tool_calls if isinstance(tool_calls, list) else [],
            }

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="OpenRouter request timed out")
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"Error calling OpenRouter: {str(e)}")


async def handle_tool_calling_attack(request: AttackRequest) -> AttackResponse:
    challenge = normalize_challenge(request)
    chat_messages = normalize_messages(request)

    if not chat_messages:
        raise HTTPException(status_code=400, detail="prompt or messages must include at least one message")

    model_result = await call_openrouter(chat_messages, challenge)
    assistant_text = str(model_result.get("assistant") or "")
    tool_calls = model_result.get("tool_calls") or []

    expected_tool_name = (challenge.success_tool_name or TARGET_TOOL_NAME).strip()
    expected_tool_args = challenge.success_tool_args or TARGET_TOOL_ARGS
    if not isinstance(expected_tool_args, dict):
        expected_tool_args = {}

    success, output_message = evaluate_success(tool_calls, expected_tool_name, expected_tool_args)
    called_tool_names = [
        str(call.get("function", {}).get("name", ""))
        for call in tool_calls
        if isinstance(call, dict)
    ]

    return build_response(
        success,
        output_message,
        assistant=assistant_text,
        log=f"Observed tool calls: {', '.join([name for name in called_tool_names if name]) or 'none'}",
        tool_calls=[name for name in called_tool_names if name],
    )


async def handle_secret_key_attack(request: AttackRequest) -> AttackResponse:
    challenge = normalize_challenge(request)
    target_secret = (challenge.target_secret_key or SECRET_PHRASE).strip()
    chat_messages = normalize_messages(request)

    if not target_secret:
        raise HTTPException(status_code=500, detail="No secret key configured for this backend.")

    if not chat_messages and not (request.guess or "").strip():
        raise HTTPException(status_code=400, detail="Provide a prompt/messages turn or a guess.")

    assistant_text = ""
    model_log = "No model turn requested."
    if chat_messages:
        model_result = await call_openrouter(chat_messages, challenge)
        assistant_text = str(model_result.get("assistant") or "")
        model_log = "Model turn completed."

    guess = (request.guess or "").strip()
    if not guess:
        return build_response(
            False,
            "No guess submitted yet. Continue probing the model, then submit a guess.",
            assistant=assistant_text,
            log=f"{model_log} Guess not supplied.",
        )

    success = guess.lower() == target_secret.lower()
    output_message = "Correct secret key guess." if success else "Incorrect secret key guess."
    return build_response(
        success,
        output_message,
        assistant=assistant_text,
        log=f"{model_log} Secret-key check completed.",
    )


async def handle_banana_attack(request: AttackRequest) -> AttackResponse:
    matched = has_banana(request)
    if matched:
        return build_response(
            True,
            "Banana detected.",
            log="Matched the word banana in the attacker message history.",
        )

    return build_response(
        False,
        "Banana not found in the attack prompt.",
        log="No banana keyword match found.",
    )


async def dispatch_attack(request: AttackRequest, mode: str) -> AttackResponse:
    if mode == "auto":
        challenge = normalize_challenge(request)
        challenge_type = (challenge.challenge_type or "").strip().lower()
        has_guess = bool((request.guess or "").strip())
        has_secret = bool((challenge.target_secret_key or SECRET_PHRASE).strip())
        has_tool_name = bool((challenge.success_tool_name or TARGET_TOOL_NAME).strip())
        has_tools = bool(normalize_tools(challenge.tools if challenge.tools is not None else CHALLENGE_TOOLS))

        if challenge_type == "secret-key":
            mode = "secret-key"
        elif challenge_type == "tool-calling":
            mode = "tool-calling"
        elif has_tool_name or has_tools:
            mode = "tool-calling"
        elif has_secret:
            mode = "secret-key"
        else:
            mode = "tool-calling"

    if mode == "tool-calling":
        return await handle_tool_calling_attack(request)
    if mode == "secret-key":
        return await handle_secret_key_attack(request)
    if mode == "banana":
        return await handle_banana_attack(request)

    raise HTTPException(status_code=404, detail=f"Unknown demo backend mode: {mode}")


@app.post("/attack", response_model=AttackResponse)
async def attack_endpoint(request: AttackRequest):
    return await dispatch_attack(request, "auto")


@app.post("/attack/tool-calling", response_model=AttackResponse)
async def tool_calling_attack_endpoint(request: AttackRequest):
    return await dispatch_attack(request, "tool-calling")


@app.post("/attack/secret-key", response_model=AttackResponse)
async def secret_key_attack_endpoint(request: AttackRequest):
    return await dispatch_attack(request, "secret-key")


@app.post("/attack/banana", response_model=AttackResponse)
async def banana_attack_endpoint(request: AttackRequest):
    return await dispatch_attack(request, "banana")


@app.post("/", response_model=AttackResponse)
async def root_attack_endpoint(request: AttackRequest):
    return await dispatch_attack(request, "auto")


@app.options("/")
@app.options("/attack")
@app.options("/attack/tool-calling")
@app.options("/attack/secret-key")
@app.options("/attack/banana")
async def preflight_handler():
    """Explicit preflight OPTIONS handler."""
    return Response(status_code=204)

@app.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {
        "status": "ok",
        "model": OPENROUTER_MODEL,
        "routes": ["/attack", "/attack/tool-calling", "/attack/secret-key", "/attack/banana"],
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8001))
    print(f"Starting Dummy Challenge Backend on port {port}")
    print(f"Using model: {OPENROUTER_MODEL}")
    uvicorn.run(app, host="0.0.0.0", port=port)
