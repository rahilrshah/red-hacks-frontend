# Custom Steering Vectors — Implementation Plan

This plan wires `interp-backend`'s activation-steering capability (contrastive
direction extraction + forward-hook injection, no image generation) into the
website so any authenticated user can author a vector and use it offensively
against another team's defense.

## 1. Feature summary

- **Actor:** any authenticated user (scoped to their own user_id).
- **Use case:** attacker authors one or more steering vectors in a personal
  library, then selects a vector + coefficient when attacking another team's
  `defended_challenge`. The vector is applied via forward hooks on top of (or
  in addition to) whatever steering the defender has configured, giving the
  attacker an interpretability-based tool for bypassing prompt-level defenses.
- **Feature kind:** activation steering on a text causal LM (`gpt2` by default,
  `STEER_MODEL_NAME` overrides). Not image generation.
- **Compute path:** a new `POST /v1/steering-vectors` endpoint on
  `interp-backend` computes the contrastive difference-in-means direction,
  normalizes it, and upserts into Supabase `steering_vectors`. The SvelteKit
  server calls this endpoint with a shared secret and the authenticated user's
  `profiles.id` as `created_by`.
- **Constraints the UI must enforce:**
  - `len(positive_examples) == len(negative_examples)` and both ≥ 3.
  - At least one `target_layers` entry, all `0 ≤ layer < num_hidden_layers`.
  - `pooling ∈ {"last", "mean"}`, `position ∈ {"all", "last"}`.
  - `min_coefficient < max_coefficient`, suggested range `[-12, 12]`.

## 2. Gameplay model — attacker uses steering offensively

Today, `challenges.steering_vector_id` (or `interp_args.configuration`) is the
defender's side. After this feature, the attack payload carries a second,
orthogonal context:

```
attacker_steering: {
  vector_id: uuid,
  coefficient: number  // clamped to vector's min/max
}
```

Both defender and attacker vectors are applied inside the same forward pass
(stacked hooks compose additively through `hidden_states + direction * coef`).
This turns the attack into an activation-level negotiation: the defender pins
the model toward refusal/secrecy; the attacker can pull it toward compliance.

Eligibility: attacker-side steering only takes effect when the target
challenge's `model_name` resolves to `MODEL_ALIASES` (`llama`,
`llama-interp-server`, `llama-interp`). For any other model, the UI disables
the "attach vector" control with an explanatory tooltip. The frontend guard
reuses the `INTERNAL_MODELS` set pattern introduced in
`src/routes/admin/challenges/+page.svelte` — see §5.6.

## 3. Data model changes

New migration: `supabase/migrations/20260418120000_user_steering_vectors.sql`.

```sql
-- Ownership / visibility for user-authored vectors
ALTER TABLE steering_vectors
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS compiled_dim INTEGER;  -- stored for UI display

ALTER TABLE steering_vectors
  ADD CONSTRAINT steering_vectors_visibility_chk
  CHECK (visibility IN ('private', 'public'));

-- Replace admin-only policies with owner-aware ones
DROP POLICY IF EXISTS "Admins can read steering vectors" ON steering_vectors;
DROP POLICY IF EXISTS "Admins can modify steering vectors" ON steering_vectors;

CREATE POLICY "Users can read own or public steering vectors"
ON steering_vectors FOR SELECT TO authenticated
USING (
  created_by = auth.uid()
  OR visibility = 'public'
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

CREATE POLICY "Users can insert own steering vectors"
ON steering_vectors FOR INSERT TO authenticated
WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can update own steering vectors"
ON steering_vectors FOR UPDATE TO authenticated
USING (created_by = auth.uid())
WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can delete own steering vectors"
ON steering_vectors FOR DELETE TO authenticated
USING (created_by = auth.uid());

CREATE POLICY "Admins override steering vectors"
ON steering_vectors FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- Per-user quota trigger (soft cap; tune later)
CREATE OR REPLACE FUNCTION enforce_steering_vector_quota() RETURNS TRIGGER AS $$
DECLARE
  vec_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO vec_count FROM steering_vectors WHERE created_by = NEW.created_by;
  IF vec_count >= 25 THEN
    RAISE EXCEPTION 'Steering vector limit reached (25 per user).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER steering_vector_quota
  BEFORE INSERT ON steering_vectors
  FOR EACH ROW EXECUTE FUNCTION enforce_steering_vector_quota();
```

No changes to `challenges.steering_vector_id` — that stays as the defender side.

## 4. Interp-backend changes — `steering_backend.py`

### 4.1 New endpoint: `POST /v1/steering-vectors`

- Auth: require header `X-Internal-Secret` equal to env
  `INTERP_INTERNAL_SECRET`. Only the SvelteKit server will have this value —
  browsers never call the endpoint directly.
- Body:
  ```ts
  {
    name: string,
    description?: string,
    model_name?: string,            // defaults to STEER_MODEL_NAME
    positive_examples: string[],
    negative_examples: string[],
    target_layers: number[],        // optional if auto_select_layers = true
    auto_select_layers?: boolean,   // see 4.2
    pooling?: "last" | "mean",
    position?: "all" | "last",
    min_coefficient?: number,
    max_coefficient?: number,
    visibility?: "private" | "public",
    created_by: string              // uuid, provided by SvelteKit server
  }
  ```
- Validation (all 422 on failure):
  - Equal-length positive/negative arrays, each ≥ 3.
  - Max 32 example pairs, each ≤ 500 chars.
  - Layer indices in `[0, num_hidden_layers)`; ≤ 8 layers.
  - `min_coefficient < max_coefficient`; absolute values ≤ 32.
  - Visibility in `{private, public}`.
- Flow:
  1. Resolve model via `_resolve_model_name` + `load_model` (cached).
  2. If `auto_select_layers`, invoke `select_layers_by_probe()` (see 4.2); else
     use the supplied `target_layers`.
  3. Call existing `extract_directions(...)` → `build_vector_payload(...)`.
  4. POST to Supabase `/rest/v1/steering_vectors?on_conflict=name` with
     `Prefer: resolution=merge-duplicates,return=representation`, using the
     service-role key the backend already holds.
  5. Respond with the stored row *minus* `vector_payload` (to keep payloads
     small) plus `dim`, `num_layers_effective`, and the selected layer list.

### 4.2 Optional: auto layer selection (probe + cosine)

Port the logic from
`activation-steering-challenge/extract_directions.ipynb` into a new module
`interp-backend/layer_selection.py` and expose it behind
`auto_select_layers: true`. Inputs: the same positive/negative examples the
user provided. Output: a ranked list of layers by simple logistic-regression
probe accuracy on mean-pooled hidden states, then a sparsification pass that
drops layers whose direction is highly correlated (cosine ≥ 0.95) with an
already-chosen layer. Default output size: top-3 layers clipped to the last
half of the model.

Exposed helper:
```python
def select_layers_by_probe(
    model, tokenizer,
    positive: list[str], negative: list[str],
    max_layers: int = 3,
    min_cosine_distance: float = 0.05,
) -> list[int]:
    ...
```

This is additive; existing manual-`target_layers` callers are unchanged.

### 4.3 Chat-completion schema changes

Add optional field to `ChatCompletionRequest`:

```python
class AttackerSteering(BaseModel):
    vector_id: str
    coefficient: float

class ChatCompletionRequest(BaseModel):
    ...
    attacker_steering: Optional[AttackerSteering] = None
```

Update `_resolve_steering_config` to return a list of
`(SteeringVectorRecord, coefficient)` pairs rather than a single tuple:
- Defender context from the existing resolution paths.
- Attacker context from `request.attacker_steering` if present — fetched via
  the same `fetch_steering_vector` helper, with `is_active` and
  `model_name` compatibility checks. Compatibility: attacker vector's
  `model_name` must equal the loaded model; otherwise 409 with a clear error.

Update `/v1/chat/completions`:
- Build one `SteeringHookManager` per record and `attach(...)` them in
  sequence. Forward hooks compose, so both sets of directions get added to
  `hidden_states` in one forward pass.
- In the response, surface both contexts:
  ```json
  "steering": {
    "enabled": true,
    "defender": { "vector_id": ..., "vector_name": ..., "coefficient": ..., "target_layers": [...] },
    "attacker": { "vector_id": ..., "vector_name": ..., "coefficient": ..., "target_layers": [...] } // null if not used
  }
  ```

### 4.4 Health/model-info endpoint for UI

Add `GET /v1/model-info`:
```json
{
  "model_name": "gpt2",
  "num_hidden_layers": 12,
  "hidden_size": 768,
  "suggested_layers": [8, 9, 10, 11],
  "min_coefficient": -12,
  "max_coefficient": 12
}
```

The UI uses `num_hidden_layers` to render the layer picker bounds.

## 5. Frontend changes — SvelteKit

### 5.1 New library page: `src/routes/steering/vectors/+page.svelte`

Personal library of the current user's vectors. Columns: name, model,
target_layers, coefficient range, visibility, `is_active`, created_at,
actions (edit, delete, duplicate).

### 5.2 New create form: `src/routes/steering/vectors/new/+page.svelte`

Top-of-form guidance block (rendered above the inputs):

> **What this does.** A steering vector nudges the model's hidden state in a
> chosen direction. You teach it the direction by giving it matched *pairs* of
> examples that differ only in the behavior you want to control.
>
> **Rules of thumb:**
> - Provide at least **3 pairs**. Each positive example is matched to one
>   negative example at the same index. Both lists must have the **same
>   length**.
> - Make each pair a minimal contrast: same topic and grammar, opposite
>   attitude (e.g. "I will help you with that right away." ↔ "I refuse to
>   help with that.").
> - Short, concrete sentences work better than long paragraphs.
> - Target layers near the end of the model (e.g. last quarter) usually
>   generalize best. If unsure, tick **Auto-select layers** and we'll pick
>   for you using probe accuracy.
> - Coefficient at attack time scales the direction; positive values push
>   toward the positives, negative values toward the negatives.

Fields:

| Field                 | Control                         | Helper / placeholder                                                             |
|-----------------------|---------------------------------|----------------------------------------------------------------------------------|
| Name                  | text                            | `e.g. compliant-v1`                                                              |
| Description           | textarea                        | `Optional — what behavior does this direction represent?`                        |
| Model                 | readonly chip                   | pulled from `/v1/model-info`                                                     |
| Example pairs         | dynamic rows with add/remove    | left placeholder: `Positive example — model behaves the way you want`            |
|                       |                                 | right placeholder: `Negative example — matched opposite of the positive`         |
|                       | counter under block             | `3 pairs minimum. 8 pairs matched so far.` (live count, red below 3)             |
| Auto-select layers    | toggle                          | `Recommended — picks layers with the highest probe accuracy.`                    |
| Target layers         | multi-chip picker `0..N-1`      | hidden when auto-select is on; helper `Pick 2–4 layers near the end of the model.` |
| Pooling               | radio: `Last token`, `Mean`     | helper `'Last' captures the final hidden state; 'Mean' averages across tokens.`  |
| Position              | radio: `All tokens`, `Last`     | helper `'All' steers every token during generation; 'Last' only nudges the last.` |
| Coefficient range     | two number inputs               | helper `Bounds limit how far an attacker can push this direction (|value| ≤ 32).`|
| Visibility            | radio: `Private`, `Public`      | helper `Public vectors can be used by any player as an attack tool.`             |

Validation on submit (client-side, mirrored server-side):
- matched example counts, ≥ 3 pairs
- at least one layer chosen (unless auto-select)
- `min_coefficient < max_coefficient`

### 5.3 New server route: `src/routes/api/steering-vectors/+server.ts`

```ts
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await request.json();

  const res = await fetch(`${env.INTERP_BACKEND_URL}/v1/steering-vectors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': env.INTERP_INTERNAL_SECRET,
    },
    body: JSON.stringify({ ...body, created_by: user.id }),
  });
  // forward JSON + status
};
```

`GET` endpoint returns the current user's vectors + public ones via Supabase
(RLS handles filtering). Pagination not required in v1.

Sibling admin validator — mirrors the `admin/challenges/validate-model`
pattern introduced in the 2026-04-17 update:

- Path: `src/routes/admin/steering-vectors/validate/+server.ts`.
- Purpose: lets admins (and eventually authors pre-save) dry-run a proposed
  vector against the backend without persisting. Forwards to a new
  `POST /v1/steering-vectors:dry-run` variant of §4.1 that returns the
  selected layers, probe accuracy, dim, and a hash of the resulting direction,
  but does **not** write to Supabase.
- This matches the admin UX convention that validation-heavy writes get a
  thin `+server.ts` proxy that returns structured diagnostics before the real
  mutation. Keep response shape aligned with
  `validate-model/+server.ts` (top-level `ok: boolean`, `details: {...}`) so
  the existing admin result-card component can render it unchanged.

### 5.4 Attack-page integration

`src/routes/game/[gameId]/attack/[defendedChallengeId]/+page.svelte` gets a
collapsible "Attacker steering" panel:
- Enabled only when the target's `model_name` is in
  `STEERING_CAPABLE_MODELS` (a new sibling of `INTERNAL_MODELS` — see §5.6).
  No string-equality checks; always go through the set.
- Dropdown of the current user's vectors + public vectors, filtered to those
  where `model_name == target.challenges.model_name_resolved` and
  `is_active = true`.
- Coefficient slider bounded by the chosen vector's `[min_coefficient,
  max_coefficient]`.
- Live preview of what will be sent: vector name + coefficient.

`src/routes/game/[gameId]/attack/+server.ts`:
- Parse `attacker_steering: { vector_id, coefficient }` from the request.
- Confirm the attacker owns or has public-read access (select via Supabase
  under the user's JWT; RLS enforces).
- Pass it through `buildAttackRequestPayload` into the outbound body.

`supabase/functions/attack/index.ts`:
- When `isLlamaInterp`, forward `attacker_steering` on the payload it sends to
  `LLAMA_INTERP_URL`.

### 5.5 Response-metadata surfacing

Render the backend's `steering` metadata on the attack result card:
- "Defender steering: `happy_sad` @ 3.00 (layers 8–11)"
- "Your steering: `compliant-v1` @ 6.00 (layers 9,10,11)" — if used

Persist both into `attacks.log.steering` for replay.

## 6. Guidance surface — where the helper text lives

Three surfaces for the instructional copy:

1. **Create form header** (section 5.2) — the multi-line explainer above the
   inputs.
2. **Inline hint rows** under each field group (table in 5.2) — one-sentence
   rationales that stay visible.
3. **Placeholder text** inside each textarea — shown when the field is empty.
   For the example pairs, the placeholders model the expected structure:
   - positive: `Positive example — model behaves the way you want`
   - negative: `Negative example — matched opposite of the positive`

A single content file at `src/lib/steering/copy.ts` centralizes these strings
so they stay consistent across the create form, the edit form, and the
in-attack picker.

### 5.6 Conventions inherited from the 2026-04-17 admin update

Two patterns were introduced in the admin-side refactor that landed just
before this plan. The steering feature should adopt both so the codebase
stays coherent:

**(1) Internal-model membership via a `Set`, not string equality.**

`src/routes/admin/challenges/+page.svelte` now uses
`INTERNAL_MODELS = new Set(['llama-interp-server'])` to decide when an entry
in the model picker represents a non-OpenRouter, in-house model. Everywhere
the steering feature needs to answer "is this a steering-capable model?", it
must do so via a sibling set rather than an ad-hoc `===` check.

- Add `STEERING_CAPABLE_MODELS = new Set(['llama-interp-server', 'llama-interp', 'llama'])`
  to `src/lib/steering/types.ts` (or `copy.ts` — wherever the steering
  constants live).
- Replace the current `model_name === 'llama-interp-server'` guard on
  `src/routes/admin/challenges/+page.svelte:~548` (the `interp_arg_id`
  selector visibility) with `STEERING_CAPABLE_MODELS.has(model_name)` in
  the same pass, so adding a new internal model doesn't require touching
  the admin page.
- Use the same set to gate the attacker-steering panel in §5.4.
- Expose the set through `src/lib/steering/types.ts` so the admin page,
  the library, the create form, and the attack page all import one source
  of truth.

This mirrors how `INTERNAL_MODELS` already short-circuits OpenRouter deep-test
validation — a new model name only has to be added to the relevant set(s),
not scattered across UI files.

**(2) Validation routes follow the `admin/<resource>/validate-*/+server.ts` shape.**

`src/routes/admin/challenges/validate-model/+server.ts` establishes the
pattern: a thin SvelteKit `+server.ts` that forwards a proposed write to the
relevant backend (or OpenRouter), normalizes the response to
`{ ok: boolean, details: {...} }`, and returns structured diagnostics for
the admin page to render. The steering feature follows this pattern in two
places:

- `src/routes/admin/steering-vectors/validate/+server.ts` (§5.3 sibling
  validator) — dry-runs a vector definition through
  `POST /v1/steering-vectors:dry-run`.
- `src/routes/api/steering-vectors/+server.ts` (§5.3 main POST) — reuses
  the same error envelope shape so the create form can share a single
  error-display component with the admin validator.

Concretely: both routes return
```ts
{ ok: true, details: { ... } } | { ok: false, error: string, details?: {...} }
```
and the frontend renders them through the same
`<ValidationResult>` component the admin page already uses for
`validate-model`. When that component moves to `src/lib/components/` (it
currently lives inline in the admin page), the steering forms consume it
directly.

**Net effect on §9 file inventory:** add
`src/routes/admin/steering-vectors/validate/+server.ts` to the "New" list and
note the `+page.svelte` edit to §9 as updating the `INTERNAL_MODELS` guard to
use `STEERING_CAPABLE_MODELS.has(...)`.

## 7. Security & abuse mitigations

- Shared-secret gate (`X-Internal-Secret`) on the backend's
  `/v1/steering-vectors` so only the SvelteKit server can trigger compute
  (which is GPU-expensive).
- Supabase trigger caps users at 25 vectors (§3).
- Validation: length/count caps listed in §4.1 — enforced server-side.
- `is_active=false` toggle admins can flip to disable abusive vectors.
- `visibility='public'` requires admin approval via an `is_approved` flag (v2;
  v1 ships with public off-by-default, gated to admins until we want it open).
- Rate limit: SvelteKit route rejects >5 creates per user per hour via
  per-user Redis/Upstash counter — or Supabase RPC counter if Redis isn't
  available.

## 8. Rollout plan

Each phase ships behind a verification gate. Every listed check must pass
before starting the next phase. If a check fails, fix or roll back the phase
before proceeding — do not accumulate unverified state across phases.

### Phase 1 — Migration + RLS (§3)

**Ships:** `supabase/migrations/20260418120000_user_steering_vectors.sql`
(new columns, owner-aware RLS policies, 25-vector quota trigger).

**Verification gate (all must pass):**

- **V1.1** SQL parses under Postgres 15 without errors (apply to an
  ephemeral `supabase start` DB or a scratch `psql` database; `\d+
  steering_vectors` shows the new columns).
- **V1.2** `SELECT polname FROM pg_policy WHERE polrelid =
  'steering_vectors'::regclass` returns exactly the 5 new policies named in
  §3 (users read/insert/update/delete + admin override); **no** policy with
  "Admins can read/modify steering vectors" survives.
- **V1.3** `SELECT tgname FROM pg_trigger WHERE tgrelid =
  'steering_vectors'::regclass AND NOT tgisinternal` contains
  `steering_vector_quota`.
- **V1.4** RLS read isolation: as user A (JWT auth), `SELECT ... WHERE id =
  <vector-owned-by-B-visibility-private>` returns 0 rows; same query with
  B's vector set to `visibility='public'` returns 1 row.
- **V1.5** Quota trigger: inserting the 26th vector for a single user
  raises `Steering vector limit reached (25 per user).` and aborts the
  transaction.
- **V1.6** Schema back-compat: existing `challenges.steering_vector_id` FK
  still references `steering_vectors(id)` (no cascade changes).

### Phase 2 — Backend endpoints + stacked hooks (§4)

**Ships:** `interp-backend/steering_backend.py` edits (new endpoints,
stacked hooks, attacker-steering schema), new `interp-backend/layer_selection.py`,
`.env.example` adds `INTERP_INTERNAL_SECRET`. Guarded by
`ENABLE_USER_STEERING_VECTORS=true`.

**Verification gate (all must pass):**

- **V2.1** `python -c "import steering_backend, layer_selection"` succeeds
  with no import errors (pins torch + transformers from requirements.txt).
- **V2.2** FastAPI boots via `uvicorn steering_backend:app --host 127.0.0.1
  --port 8787`; `curl /health` returns 200 with `{"status":"ok", ...}`.
- **V2.3** `GET /v1/model-info` returns JSON with `model_name`,
  `num_hidden_layers` (=12 for gpt2), `hidden_size` (=768), `suggested_layers`,
  `min_coefficient`, `max_coefficient`.
- **V2.4** `POST /v1/steering-vectors:dry-run` with 3 matched pos/neg
  examples + `auto_select_layers=false` + `target_layers=[8,9]` returns
  `{ok:true, details:{dim:768, target_layers:[8,9], ...}}` and does **not**
  write to Supabase. Header `X-Internal-Secret` missing → 401.
- **V2.5** Validation errors return 422 with structured body: empty lists,
  mismatched lengths, <3 pairs, >32 pairs, layer out of range, pooling not in
  `{last, mean}`, `min_coefficient >= max_coefficient`.
- **V2.6** Stacking composition test: build two `SteeringHookManager`s with
  different orthogonal directions applied to the same layer; run one forward
  pass with hook A attached, one with hook B attached, one with both
  attached. Assert `hidden_states_AB - hidden_states_base` ≈
  `(hidden_states_A - hidden_states_base) + (hidden_states_B -
  hidden_states_base)` within 1e-5. This proves additive composition.
- **V2.7** `POST /v1/chat/completions` with both `challenge.steering_vector_id`
  (defender) and `attacker_steering` (attacker) returns a response whose
  `steering.defender` and `steering.attacker` blocks are both populated and
  whose `target_layers` match the stored vectors.
- **V2.8** Attacker-vector model-compat mismatch returns 409 with a
  `model_name` error — not 500.

### Phase 3 — Library, create form, server routes (§§5.1–5.3, 5.6)

**Ships:** `src/lib/steering/{types.ts, copy.ts}`,
`src/routes/steering/vectors/{+page.svelte, new/+page.svelte, [id]/edit/+page.svelte}`,
`src/routes/api/steering-vectors/+server.ts`,
`src/routes/admin/steering-vectors/validate/+server.ts`, and the guard swap
in `src/routes/admin/challenges/+page.svelte` from
`model_name === 'llama-interp-server'` to
`STEERING_CAPABLE_MODELS.has(model_name)`.

**Verification gate (all must pass):**

- **V3.1** `npx svelte-check --tsconfig ./tsconfig.json` reports **0**
  errors in the new files and the modified admin-challenges page.
- **V3.2** `grep -nE "model_name\s*===\s*['\"]llama-interp" src/` returns
  zero hits — all guards go through the set helper.
- **V3.3** `grep -n "STEERING_CAPABLE_MODELS" src/lib/steering/types.ts`
  returns a single `export const` line; admin-challenges and attack files
  import from that module (verified via `grep -rn "STEERING_CAPABLE_MODELS"
  src/`).
- **V3.4** Unauthenticated `POST /api/steering-vectors` returns 401 (no
  backend call attempted). Authenticated request forwards with
  `X-Internal-Secret` attached and `created_by = user.id` injected
  server-side — asserted by unit-level fetch mock in a small Vitest spec
  `src/routes/api/steering-vectors/server.spec.ts`.
- **V3.5** `POST /api/admin/steering-vectors/validate` — admin user gets
  forwarded dry-run; non-admin gets 403.
- **V3.6** Form submission with <3 pairs is blocked client-side before any
  network call (verified by a Playwright smoke or a Svelte component test
  with `@testing-library/svelte`).
- **V3.7** Create form renders the §5.2 guidance block verbatim from
  `src/lib/steering/copy.ts` — no duplicated strings in the Svelte file
  (`grep -c "Positive example"` in the Svelte file returns 0; it returns ≥1
  in `copy.ts`).

### Phase 4 — Attack-page integration (§5.4)

**Ships:** Attacker-steering panel in
`src/routes/game/[gameId]/attack/[defendedChallengeId]/+page.svelte`,
payload plumbing in `src/routes/game/[gameId]/attack/+server.ts`, edge-function
forwarding in `supabase/functions/attack/index.ts` (gated on `isLlamaInterp`).

**Verification gate (all must pass):**

- **V4.1** Panel is hidden when target `model_name ∉
  STEERING_CAPABLE_MODELS`; visible and enabled when it is. Asserted by
  component test with both fixtures.
- **V4.2** Selecting a vector and a coefficient populates the outgoing
  attack request JSON at `attacker_steering.{vector_id, coefficient}`. Grep
  `src/routes/game/[gameId]/attack/+server.ts` for `attacker_steering` to
  confirm the payload hop; run an integration test that posts to the route
  with a mocked edge function and asserts the forwarded body.
- **V4.3** Coefficient input is clamped to the vector's declared
  `[min_coefficient, max_coefficient]` both on the slider max/min attrs and
  on a server-side guard in `attack/+server.ts`. Manual override >max in the
  request body returns 422.
- **V4.4** `isLlamaInterp === false` path: `supabase/functions/attack/index.ts`
  drops `attacker_steering` before calling the non-interp backend. Verified
  by a unit test on the edge function that asserts the outbound body.
- **V4.5** RLS check: user A cannot submit user B's private vector as
  `attacker_steering` — `POST /game/:id/attack/:id` with B's private
  `vector_id` under A's JWT returns 403.
- **V4.6** Backwards compat: existing attacks with no `attacker_steering`
  still succeed end-to-end (regression asserted by running the existing
  attack test suite once, or by a targeted test with the field absent).

### Phase 5 — Response metadata + logging (§5.5)

**Ships:** Result-card rendering of `steering.defender` and
`steering.attacker` blocks, persistence into `attacks.log.steering`.

**Verification gate (all must pass):**

- **V5.1** Mocked backend response with both context blocks → result card
  shows two lines matching the §5.5 format exactly (snapshot test).
- **V5.2** `attacks.log` row inserted after a successful attack contains
  the full `steering` object under `log.steering` (JSONB). Verified by a
  DB-level query in an integration test.
- **V5.3** Defender-only attack (no attacker_steering) → result card shows
  only the defender line; log still contains `steering.attacker: null`.
- **V5.4** Attack against non-interp model → `steering` field is absent
  from response and log (not `null`, absent), so we don't pollute legacy
  rows.

### Phase 6 — Auto-layer-selection activation (§4.2)

**Ships:** `auto_select_layers: true` path in `POST /v1/steering-vectors`;
"Auto-select layers" toggle in create form (default ON); manual picker
hidden when toggle is on.

**Verification gate (all must pass):**

- **V6.1** Dry-run with `auto_select_layers=true` and 5 matched pos/neg
  pairs on gpt2 returns `target_layers` of length ≤ 3, all indices in the
  second half of the model (`>= num_hidden_layers // 2`).
- **V6.2** Cosine-sparsification kicks in: two selected layers have pairwise
  direction cosine < 0.95 (assert in unit test on `layer_selection.py`).
- **V6.3** Probe accuracy on the training pairs for each selected layer is
  ≥ 0.7 on gpt2 for a known-easy contrastive set ("happy" vs "sad"
  sentences). This prevents random-chance layer picks.
- **V6.4** Form: toggling auto-select ON hides the manual layer picker and
  clears the `target_layers` form state; toggling OFF restores the picker
  with an empty selection.
- **V6.5** When auto-select is ON and `target_layers` is still sent by the
  client, the backend ignores the client value and emits a response field
  `layer_source: "auto"`; when OFF, response field `layer_source: "manual"`.

### Phase 7 — Presets (§3 references `happy_sad` in seed.sql)

**Ships:** `steering_presets.py` imported into `steering_backend.py`;
`_resolve_steering_config` falls back to `PRESETS` on preset-name match
when no row is found in Supabase.

**Verification gate (all must pass):**

- **V7.1** `POST /v1/chat/completions` with
  `challenge.interp_args.configuration = {"steering_vector_name": "happy_sad",
  "steer_coefficient": 3.0}` succeeds and returns
  `steering.defender.vector_name == "happy_sad"` even when no Supabase row
  exists with that name.
- **V7.2** Preset resolution is layer-bounded by the loaded model
  (`max(target_layers) < num_hidden_layers`); mismatches fall back to the
  preset's `suggested_layers` clamped to the model's range.
- **V7.3** When both a Supabase row and a preset share a name, the Supabase
  row wins (DB is authoritative; presets are a fallback). Asserted by
  inserting a dummy `happy_sad` row and confirming its `target_layers`
  appear in the response, not the preset's.
- **V7.4** The seed.sql `interp-steering-demo` challenge (see
  `supabase/seed.sql:36`) resolves end-to-end: fresh `supabase db reset`
  followed by a chat-completion request against that challenge returns
  `steering.defender.vector_name == "happy_sad"` and a non-zero coefficient.

## 9. Files created or changed

New:
- `supabase/migrations/20260418120000_user_steering_vectors.sql`
- `interp-backend/layer_selection.py` (auto-select helper, §4.2)
- `src/routes/steering/vectors/+page.svelte`
- `src/routes/steering/vectors/new/+page.svelte`
- `src/routes/steering/vectors/[id]/edit/+page.svelte`
- `src/routes/api/steering-vectors/+server.ts`
- `src/routes/admin/steering-vectors/validate/+server.ts` (dry-run proxy,
  mirrors `admin/challenges/validate-model/+server.ts` — see §5.6)
- `src/lib/steering/copy.ts`
- `src/lib/steering/types.ts` — exports `STEERING_CAPABLE_MODELS` (see §5.6)

Changed:
- `interp-backend/steering_backend.py` — new endpoint, model-info endpoint,
  attacker-steering stacking, response metadata.
- `interp-backend/.env.example` — add `INTERP_INTERNAL_SECRET`.
- `supabase/functions/attack/index.ts` — forward `attacker_steering`.
- `src/routes/game/[gameId]/attack/+server.ts` — plumb `attacker_steering`.
- `src/routes/game/[gameId]/attack/[defendedChallengeId]/+page.svelte` —
  add the attacker-steering panel + result metadata display.
- `src/routes/admin/challenges/+page.svelte` — swap the
  `model_name === 'llama-interp-server'` guard around the `interp_arg_id`
  selector for `STEERING_CAPABLE_MODELS.has(model_name)` (see §5.6).
- `svelte.config.js` / nav — add `/steering/vectors` link for authenticated
  users behind the feature flag.

## 10. Explicit non-goals

- No image-generation steering. Backend remains text-only causal LM.
- No per-layer magnitudes in v1 (the capability exists in
  `activation_steering_feature.py:TextEncoderSteerer` but the production
  backend uses a single scalar; we keep that simpler interface).
- No preset storefront in v1 (§8 item 7 handles it separately).
- No support for multiple attacker vectors in a single attack. One attacker
  vector per request.
