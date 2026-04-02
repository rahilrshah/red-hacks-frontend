# Edge Functions

## Attack Function

Path:
- `supabase/functions/attack/index.ts`

Purpose:
- Validate attacker identity and game membership
- Validate target/challenge eligibility
- Apply cooldown and anti-self-target rules
- Determine success/failure for challenge type
- Execute coin transfer via RPC on success
- Persist attack records and optional transcript log

## Auth Behavior

The function supports two auth sources:
- Gateway context (`req.auth.user.id`) when present
- Bearer token fallback for local/dev requests where `req.auth` may be missing

If user identity cannot be resolved, function returns `401`.

## Important Guards

- Attacker must be in same game as target defense
- Attacker cannot attack own team defense
- Defender must have coins remaining
- Challenge must be enabled for the game (`game_challenges`)
- Cooldown blocks repeated successful attacks against same defended challenge

## Storage

On attack handling, transcript upload to `attack-logs` is best-effort and non-fatal.

## Local Testing

1. Start Supabase: `npx supabase start`
2. Serve/deploy function via Supabase CLI as needed
3. Invoke from frontend attack pages or direct request with valid bearer token
