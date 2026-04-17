# Quick Smoke — Steering Vectors

A five-minute sanity check for when you only need to confirm the steering
stack is alive (after a pull, a restart, or an env change) — not a
ship-readiness gate. For the full pre-deploy pass, use
[`steering-local-test.md`](./steering-local-test.md).

Use this doc when you want to answer "is it working right now?" without
spinning up two browsers, creating test users, or walking the 5-probe
hostile-client battery.

---

## What this covers

| Check | What it proves |
|---|---|
| 1. Services up | Supabase, interp-backend, and SvelteKit are all reachable. |
| 2. Auth gate | The `INTERP_INTERNAL_SECRET` header is enforced. |
| 3. End-to-end extract | Backend can load the model, run forward passes, pick layers, return a valid direction. |

It skips: RLS spot-checks, 25-vector quota, UI walkthrough, hostile-client
probes, per-user visibility. If any of those could have regressed, switch to
the full runbook.

---

## Prereqs

`setup-local-steering.sh` has been run at least once on this machine, all
three services are booted, and you're in `red-hacks-frontend/` with the
backend venv active. If not, follow the bootstrap section of the full
runbook first.

---

## 1. Services up (30 seconds)

```bash
# Supabase
supabase status | head -5
# Expect "API URL: http://127.0.0.1:54321" + the rest of the stack green.

# Interp backend
curl -s http://127.0.0.1:8000/health | jq
# Expect: status "ok", supabase_configured true, internal_secret_configured
# true, user_steering_vectors_enabled true.

# Frontend
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173
# Expect: 200 (or 3xx redirect).
```

If any line fails, restart the affected service and re-check before moving
on. A 401/403/5xx here means the rest of this doc will not produce useful
signal.

---

## 2. Load the secret + model shape (15 seconds)

```bash
export SECRET=$(grep '^INTERP_INTERNAL_SECRET=' interp-backend/.env | cut -d= -f2)
echo "secret length: ${#SECRET}"
# Expect: 64. If 0, the backend terminal closed or the grep picked the
# wrong line — re-source the venv and retry.

curl -s http://127.0.0.1:8000/v1/model-info \
  | jq '{model_name, num_hidden_layers, hidden_size}'
# Expect: gpt2 → 12 layers, 768 hidden. distilgpt2 → 6 layers, 768 hidden.
```

Note whichever `num_hidden_layers` the backend reports — you'll need it for
step 3.

---

## 3. Auth gate + end-to-end extract (one call each)

**Auth gate — expect 401:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "http://127.0.0.1:8000/v1/steering-vectors:dry-run" \
  -H "Content-Type: application/json" \
  -d '{"name":"probe","positive_examples":["a","b","c"],"negative_examples":["x","y","z"]}'
```

If this returns 200 instead of 401, the backend is running without a secret
— stop and fix `interp-backend/.env` before doing anything else.

**End-to-end extract — expect layers + dim 768:**

```bash
curl -s -X POST "http://127.0.0.1:8000/v1/steering-vectors:dry-run" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: ${SECRET}" \
  -d '{
    "name": "smoke",
    "positive_examples": ["I feel wonderful today", "Life is amazing", "Such a joyful moment"],
    "negative_examples": ["I feel terrible", "Life is miserable", "Such a sad moment"],
    "auto_select_layers": true
  }' | jq '.details | {target_layers, layer_source, dim, pairs}'
```

Expected response:

- `target_layers` is a list of 1–3 integers.
- Every integer is in the **second half** of the model's layers (≥ 6 on
  gpt2, ≥ 3 on distilgpt2).
- `layer_source` is `"auto"`.
- `dim` is `768`.
- `pairs` is `3`.

First run after a fresh backend boot may take 20–60s on CPU while GPT-2
loads. Subsequent runs are seconds.

---

## Pass / fail

**Pass:** all three checks returned the expected values. The stack is
healthy enough to do manual UI work or continue development.

**Fail:** one check regressed from what you expected. Don't try to patch in
place — switch to the full runbook and run it from Layer 1. The full
runbook's troubleshooting table covers every failure mode we've hit so far.

---

## Common false alarms

| Symptom | Not a bug |
|---|---|
| `null` for every `.details` field | Your `jq` filter is on an error response. Drop `jq` and read the raw JSON — it'll say `{"detail": "…"}`. |
| 422 "At least 3 matched pairs required" | You modified the payload to have fewer than 3 pos/neg pairs. That's the `MIN_PAIRS` gate, not a broken extractor. |
| Dry-run "hangs" for ~30s | First call after backend boot loads the model. Normal. |
| `secret length: 0` after `export SECRET=…` | You opened a fresh terminal or the grep pattern matched a comment line. Re-run the export with the `^INTERP_INTERNAL_SECRET=` anchor. |
