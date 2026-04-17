# Local Pre-Deploy Test Runbook — Steering Vectors

Stand up the full stack locally, then walk through 5 layers of verification
before pushing anything to a shared environment. Each layer depends on the
previous one; do not skip ahead.

Prereqs on your Mac: `supabase` CLI, `python3` (3.10+), `node` (18+), `npm`,
and Docker running (Supabase CLI uses it). Install Supabase CLI with
`brew install supabase/tap/supabase` if you don't have it.

### Dev-mode note for slow machines

The default `STEER_MODEL_NAME` is `gpt2` (12 layers). On CPU-only Macs, each
extract-direction call does 6+ forward passes and can take 20–60 seconds the
first time the model loads. If you're only testing logic (not benchmarking
layer selection quality), set `STEER_MODEL_NAME=distilgpt2` in
`interp-backend/.env` — it has 6 layers and roughly 2x the throughput.

Swap the file, restart uvicorn, and confirm via:

```bash
curl -s http://127.0.0.1:8000/v1/model-info | jq '{model_name, num_hidden_layers}'
# { "model_name": "distilgpt2", "num_hidden_layers": 6 }
```

If you switch to distilgpt2, translate the hardcoded layer indices in the
curl examples below (`[8,9,10]` becomes `[3,4,5]`; auto-select's "second half"
check becomes layers ≥ 3 instead of ≥ 6).

---

## 0. One-shot bootstrap

From `red-hacks-frontend/`:

```bash
bash scripts/setup-local-steering.sh
```

This starts Supabase, generates `INTERP_INTERNAL_SECRET`, writes both `.env`
files, installs Python deps into `interp-backend/.venv`, and runs `npm ci`
if needed. It's idempotent — safe to re-run.

When it finishes, it prints the two terminal commands to start each service.
Open two more terminals and run them:

```bash
# Terminal 1
cd interp-backend && source .venv/bin/activate && uvicorn steering_backend:app --reload --port 8000

# Terminal 2
npm run dev
```

The first backend boot downloads gpt2 (~500 MB) and loads it — you'll see
"Loading gpt2 on cpu…" in that terminal. Wait for `Application startup
complete` before moving on.

---

## Layer 1 — Unit tests (fast, local only)

```bash
# Frontend
npm run test                                   # expect 114/114
npm run check                                  # expect 0 errors

# Backend (in interp-backend/, with .venv active)
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 STEER_SKIP_WARMUP=1 \
  python -m pytest test_layer_selection.py test_steering_presets.py -v
# expect 13/13
```

If pytest isn't installed in the venv (`No module named pytest`), run:

```bash
pip install pytest pytest-asyncio
```

These are in `requirements.txt`, but on older venvs created before that line
was added they're missing — install them once and carry on.

Both env flags matter:
- `STEER_SKIP_WARMUP=1` prevents `steering_backend.py` from downloading the
  GPT-2 weights at import time (otherwise pytest hangs at collection).
- `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` dodges `pytest_postgresql`, which tries
  to load libpq and fails on fresh macOS boxes.

If any of these fail, stop. Nothing downstream will pass.

---

## Layer 2 — Supabase migration + RLS

Confirm the steering migrations applied cleanly and RLS policies are wired.

### 2a. Migration smoke

```bash
supabase db reset             # reapplies every migration + seeds
supabase db diff -f /tmp/diff.sql
cat /tmp/diff.sql             # expect empty — schema matches migrations
```

### 2b. Create two test users

Sign up two users via the running frontend (http://localhost:5173). Their
confirmation emails land in Inbucket (http://127.0.0.1:54324) — click the
magic links to finish signup.

Call them `alice@test.local` and `bob@test.local`. Grab their UIDs from
Studio → Authentication → Users.

### 2c. RLS spot-checks

Open Supabase Studio's SQL editor (http://127.0.0.1:54323 → SQL Editor).
Run each block and compare against Expected:

```sql
-- Simulate Alice
SELECT set_config('request.jwt.claims', json_build_object(
    'sub', '<alice-uid>', 'role', 'authenticated'
)::text, true);

-- Insert a private vector as Alice (via the backend is easier — use the UI
-- to create one, then come back here). For now, verify what exists:
SELECT id, name, visibility, created_by FROM public.steering_vectors;
```

| Test | Expected |
|---|---|
| As Alice: `SELECT …` where `created_by = alice` | her rows visible |
| As Bob: `SELECT …` where `created_by = alice` and `visibility='private'` | 0 rows |
| As Bob: `SELECT …` where `created_by = alice` and `visibility='public'`  | 1 row  |
| As Alice: `INSERT (…, created_by = bob)` | error code 42501 |
| 26th insert as same user | `Steering vector limit reached (25 per user).` |

For the 25-vector quota, script it:

```sql
SELECT set_config('request.jwt.claims', json_build_object(
    'sub', '<alice-uid>', 'role', 'authenticated')::text, true);
DO $$
DECLARE i INTEGER;
BEGIN
  FOR i IN 1..26 LOOP
    INSERT INTO public.steering_vectors(name, model_name, pooling, position,
      target_layers, vector_payload, min_coefficient, max_coefficient,
      created_by, visibility)
    VALUES ('quota-'||i, 'gpt2', 'last', 'all', '[8]'::jsonb,
      '{"8":[0]}'::jsonb, -4, 4, '<alice-uid>', 'private');
  END LOOP;
END $$;
-- The 26th insert raises: "Steering vector limit reached (25 per user)."
```

Clean up: `DELETE FROM public.steering_vectors WHERE name LIKE 'quota-%';`

---

## Layer 3 — Backend smoke (direct HTTP)

Everything here uses `INTERP_INTERNAL_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`
from your `.env` files. Load them into the shell first:

```bash
set -a; source .env; source interp-backend/.env; set +a
```

If that doesn't work (or you restarted the terminal and just want the one
variable), anchor the grep so you don't accidentally match the comment line
in the frontend `.env`:

```bash
export SECRET=$(grep '^INTERP_INTERNAL_SECRET=' interp-backend/.env | cut -d= -f2)
echo "secret length: ${#SECRET}"   # expect 64
```

Every `curl` below assumes `${SECRET}` is populated. A 401 means it's empty.

Also: every dry-run payload **must have ≥ 3 pos/neg pairs** — the backend
rejects fewer with `{"detail":"At least 3 matched pairs required"}` (HTTP
422) before running any layer-selection logic. The `MIN_PAIRS` constant
lives in `steering_backend.py`.

### 3.1 Health + model info

```bash
curl -s http://127.0.0.1:8000/health | jq
# {status: "ok", model: "gpt2", supabase_configured: true,
#  internal_secret_configured: true, user_steering_vectors_enabled: true}

curl -s http://127.0.0.1:8000/v1/model-info | jq
# {model_name: "gpt2", num_hidden_layers: 12, hidden_size: 768, ...}
```

### 3.2 Dry-run (auto + manual)

```bash
# Auto-select layers (V6.1, V6.5)
curl -s -X POST http://127.0.0.1:8000/v1/steering-vectors:dry-run \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: ${INTERP_INTERNAL_SECRET}" \
  -d '{
    "name": "smoke-auto",
    "positive_examples": ["I am overjoyed.","What a wonderful day.","Life is beautiful.","I could not be happier.","Pure bliss."],
    "negative_examples": ["I am devastated.","What a terrible day.","Life is bleak.","I could not be sadder.","Pure misery."],
    "auto_select_layers": true,
    "pooling": "last", "position": "all",
    "min_coefficient": -4, "max_coefficient": 4,
    "visibility": "private"
  }' | jq '.details | {target_layers, layer_source}'
# target_layers all >= 6, layer_source "auto"

# Manual layers (V6.5)
curl -s -X POST http://127.0.0.1:8000/v1/steering-vectors:dry-run \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: ${INTERP_INTERNAL_SECRET}" \
  -d '{"name":"smoke-manual","positive_examples":["a","b","c"],"negative_examples":["x","y","z"],"auto_select_layers":false,"target_layers":[8,9,10,11],"pooling":"last","position":"all","min_coefficient":-4,"max_coefficient":4,"visibility":"private"}' \
  | jq '.details.layer_source'
# "manual"
```

### 3.3 Preset fallback (V7.1)

```bash
# No row in Supabase for "happy_sad" yet — preset fallback should fire.
curl -s -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"Describe today."}],
    "challenge":{"interp_args":{"configuration":{
      "steering_vector_name":"happy_sad","steer_coefficient":3.0
    }}}
  }' | jq '.steering.defender | {vector_name, coefficient, source}'
# { vector_name: "happy_sad", coefficient: 3, source: "preset" }
```

### 3.4 Coefficient clamp (V4.3 at the backend)

Same as above but coefficient: 999 — response shows the coefficient clamped
to `max_coefficient` (12.0 by default for presets).

---

## Layer 4 — UI walkthrough

Two users, two browser profiles / private windows.

**Attacker (Alice)**

1. Sign in → navigate to `/steering/vectors/new`.
2. Fill 5+ pos/neg pairs with clearly-opposite sentiment.
3. Leave "Auto-select layers" **ON** (the default). Submit.
   - Expect redirect to `/steering/vectors` with the new vector listed.
4. Click "Edit" on the vector.
   - Expect manual picker is **hidden** (auto-select still ON).
5. Toggle auto-select **OFF**.
   - Expect manual picker appears, starts **empty**.
   - `data-testid="manual-layer-picker"` is visible.
6. Toggle **back ON**.
   - Expect picker hides, selection clears. Submit succeeds.
7. Navigate to `/game/<id>/attack/<interp-challenge-id>`
   (the seeded "interp-steering-demo" challenge — any llama-interp-server
   challenge works).
   - Expect the fuchsia "Attacker steering" panel renders with your vector
     in the dropdown.
8. Pick a non-interp challenge (e.g. gpt-4o-mini-backed).
   - Expect the panel is **not rendered** (V4.1).
9. Back on the interp challenge: select vector, set coefficient to 2.5, attack.
   - Expect the result card shows both:
     - "Defender steering: \`<name>\` @ 3.00 (layers …)"
     - "Your steering: \`<your name>\` @ 2.50 (layers …)"

**Defender-side DB check**

In Studio SQL:
```sql
SELECT log -> 'steering' FROM public.attacks
ORDER BY created_at DESC LIMIT 1;
-- Expect a JSONB object with defender + attacker blocks.
```

**Backwards-compat**

10. Attack a non-interp challenge without any steering.
    - Expect `steering` key absent from both the response AND the log row
      (V5.4, V4.6).

---

## Layer 5 — Hostile-client probes

Use `curl` with Alice's JWT (grab it from Studio → Auth → Users → Generate
access token, or from browser devtools after sign-in).

```bash
ALICE_JWT="eyJhbGci..."   # Alice's access token
ATTACK_EP="http://localhost:5173/game/<game-id>/attack"
```

### 5.1 Steal another user's private vector

```bash
# bob-private-id is a private vector Bob owns.
curl -s -X POST "${ATTACK_EP}" \
  -H "Authorization: Bearer ${ALICE_JWT}" \
  -H "Content-Type: application/json" \
  -d '{"defended_challenge_id":"<any>","prompt":"hi",
       "attacker_steering":{"vector_id":"<bob-private-id>","coefficient":1}}'
# Expect: HTTP 403. The SvelteKit resolver queries steering_vectors under
# Alice's JWT, RLS returns no row, we reject.
```

### 5.2 Out-of-bounds coefficient

```bash
# alice-vector-id has max_coefficient=4.
curl -s -X POST "${ATTACK_EP}" \
  -H "Authorization: Bearer ${ALICE_JWT}" -H "Content-Type: application/json" \
  -d '{"defended_challenge_id":"<any>","prompt":"hi",
       "attacker_steering":{"vector_id":"<alice-vector-id>","coefficient":999}}'
# Expect: HTTP 422.
```

### 5.3 Non-finite coefficient

```bash
curl -s -X POST "${ATTACK_EP}" \
  -H "Authorization: Bearer ${ALICE_JWT}" -H "Content-Type: application/json" \
  -d '{"defended_challenge_id":"<any>","prompt":"hi",
       "attacker_steering":{"vector_id":"<alice-vector-id>","coefficient":"NaN"}}'
# Expect: HTTP 400.
```

### 5.4 created_by spoof

```bash
# Try to create a vector claiming it's owned by Bob.
curl -s -X POST "http://localhost:5173/api/steering-vectors" \
  -H "Authorization: Bearer ${ALICE_JWT}" -H "Content-Type: application/json" \
  -d '{
    "name":"alice-trying-to-spoof","visibility":"private",
    "positive_examples":["a","b","c"],"negative_examples":["x","y","z"],
    "auto_select_layers":true,"target_layers":[],
    "pooling":"last","position":"all",
    "min_coefficient":-4,"max_coefficient":4,
    "created_by":"<bob-uid>"
  }' | jq '.vector | {created_by}'
# Expect: created_by resolves to Alice's uid, not Bob's. (The SvelteKit
# route injects created_by from the JWT, overriding anything in the body.)
```

### 5.5 Steering against non-interp model

Attack any non-interp challenge (`model_name != 'llama-interp-server'`) with
an `attacker_steering` payload set:

```bash
curl -s -X POST "${ATTACK_EP}" \
  -H "Authorization: Bearer ${ALICE_JWT}" -H "Content-Type: application/json" \
  -d '{"defended_challenge_id":"<non-interp-challenge-id>","prompt":"hi",
       "attacker_steering":{"vector_id":"<alice-vector-id>","coefficient":1}}'
# Expect: HTTP 200 success. The edge function drops attacker_steering
# before calling OpenRouter so the payload is harmless. Double-check:
# select log -> 'steering' from attacks order by created_at desc limit 1;
# → NULL (V5.4).
```

---

## If a gate fails

| Gate | Most likely cause |
|---|---|
| Layer 1 unit tests | Regression in recent code. Git log + rerun. |
| Layer 2 migration diff non-empty | Someone edited a migration file after it was applied. Fix the migration, `supabase db reset`. |
| Layer 3 dry-run 401 | `INTERP_INTERNAL_SECRET` mismatch between the two `.env` files, or `${SECRET}` is empty in your shell. `echo "${#SECRET}"` should print 64. |
| Layer 3 dry-run 422 "At least 3 matched pairs required" | Payload has < 3 pos/neg pairs — that's the `MIN_PAIRS` gate, not a layer-selection bug. |
| Layer 3 dry-run returns `null` for every field under `.details` | Request hit an error path and the `.details` key isn't in the response. Drop the `jq` filter and inspect the raw JSON — it'll contain `{"detail": "…"}`. |
| Layer 3 dry-run hangs | First request after backend boot — GPT-2 loads on first use (~15–30s on CPU). Retry after you see `Application startup complete` in the uvicorn log *and* the first extract completes once. Consider `STEER_MODEL_NAME=distilgpt2` for faster iteration. |
| Bootstrap script fails with `failed to parse environment file: .env` | A prior run wrote a malformed `.env`. The current script auto-quarantines, but if it trips the check, manually `rm -f .env interp-backend/.env` and re-run. |
| Layer 3 preset 404 | `STEER_MODEL_NAME` isn't gpt2 (preset is gpt2-authored — distilgpt2 has different hidden-size-per-layer shape). |
| Layer 4 panel missing | Target challenge's `model_name` isn't in `STEERING_CAPABLE_MODELS`. Seed the `interp-steering-demo` challenge or swap to an interp challenge. |
| Layer 5.1 returns 200 | RLS policy regression. `supabase db reset` and re-check the 20260418 migration applied. |
| Layer 5.2 returns 400 or 200 | `normalizeAttackerSteering` out-of-bounds path broken — re-run `npm run test`. |

Once all five layers pass, the branch is safe to ship.

---

## Handoff checklist

Before passing this runbook to the next person:

- [ ] Share this file plus the two `.env.example` files.
- [ ] Note which `STEER_MODEL_NAME` you used — `gpt2` for production-parity,
      `distilgpt2` for fast iteration on CPU-only machines.
- [ ] Snapshot the pytest + vitest counts from Layer 1 so the next runner can
      detect a regression by mismatch.
- [ ] If you created test users (Alice, Bob), either clean them up or
      document their UUIDs for reuse in Layer 5.
- [ ] If any gate failed and you silenced it, file an issue — don't
      telephone-game the reason into the next person's head.
