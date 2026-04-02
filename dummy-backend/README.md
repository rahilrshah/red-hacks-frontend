# Dummy Challenge Backend

A minimal FastAPI backend demonstrating how to implement a custom challenge evaluator for Red Hacks. This backend can be directly invoked by the frontend when a challenge has a `challenge_url` configured.

## What It Does

- **Accepts attack requests** from the frontend with the same payload contract as the Supabase attack edge function
- **Calls OpenRouter** to generate LLM responses for non-guessing challenges
- **Validates secret key guesses** against a configured secret phrase
- **Returns compatible responses** that the frontend already knows how to render

## Setup

### 1. Install Dependencies

```bash
cd dummy-backend
pip install -r requirements.txt
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your OpenRouter API key:

```bash
cp .env.example .env
```

Edit `.env`:
```
OPENROUTER_API_KEY=sk-...  # Your OpenRouter key
OPENROUTER_MODEL=openai/gpt-4o-mini
SECRET_PHRASE=FLAG{dummy_success}
PORT=8001
```

### 3. Run the Server

```bash
python main.py
```

The backend will start on `http://localhost:8001`

## Usage

### Health Check

```bash
curl http://localhost:8001/health
```

### Attack Endpoint

The frontend posts to `/attack` with this structure:

```json
{
  "defended_challenge_id": "uuid-here",
  "challenge_id": "uuid-here",
  "game_id": "uuid-here",
  "round_type": "pvp",
  "prompt": "first user message",
  "guess": "optional secret guess",
  "messages": [
    {"role": "user", "content": "message 1"},
    {"role": "assistant", "content": "response 1"}
  ]
}
```

**Authentication**: Include `Authorization: Bearer <jwt-token>` in the request header.

### Response Format

The backend returns this structure (compatible with the frontend):

```json
{
  "success": true,
  "message": "Victory condition met.",
  "log": "Model Output: ...",
  "assistant": "Full assistant response text",
  "tool_calls": [],
  "stolen_coins": 5,
  "defender_eliminated": false,
  "challenge_id": "uuid-here"
}
```

## Challenge Types Supported

### Secret-Key Challenges

When `guess` is provided with a `SECRET_PHRASE` match:
- Returns `success: true` and a victory message
- Does not call OpenRouter

### Default Challenges

For standard prompts without a guess:
- Sends `messages` to OpenRouter
- Determines success based on response quality (length > 20 chars, no errors)
- Awards coins on success

## Integration with Red Hacks

To use this backend with a challenge in the game:

1. **Get the backend URL** (e.g., `http://localhost:8001/attack` or your hosted URL)
2. **Add it to a challenge** via the Admin panel
3. **Field**: Challenge Backend URL
4. **Value**: Paste the backend URL
5. When players attack that challenge, the frontend will call your backend directly instead of the Supabase edge function

## Testing Locally

### Example: Secret Key Guess

```bash
curl -X POST http://localhost:8001/attack \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "defended_challenge_id": "test-123",
    "guess": "FLAG{dummy_success}"
  }'
```

### Example: Chat-Based Challenge

```bash
curl -X POST http://localhost:8001/attack \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "challenge_id": "test-456",
    "game_id": "game-123",
    "round_type": "pve",
    "prompt": "What is the capital of France?",
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

## Development Notes

- **CORS**: Currently allows all origins for convenience; restrict in production
- **Auth**: Expects Bearer tokens but does not validate them (assumes frontend/gateway handles auth)
- **Error Handling**: Returns graceful error messages instead of crashing
- **Partial Responses**: If OpenRouter is unavailable, returns an error message that the UI can display

## Next Steps

You can extend this backend to:
- Implement custom evaluation logic beyond simple rules
- Call specialized APIs or tools
- Store challenge-specific metadata
- Add more sophisticated success conditions
- Implement rate limiting and request validation
