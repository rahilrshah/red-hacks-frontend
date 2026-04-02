# Security Notes

## Secrets and Credentials

- Do not commit service-role keys or production secrets
- Frontend must only use public anon key
- Keep local `.env` out of version control

## Auth Model

- Player flows use anonymous auth for low-friction onboarding
- Sensitive mutations must still be authorized server-side using user identity + membership checks

## Edge Function Hardening

For `supabase/functions/attack`:
- Always resolve authenticated user (gateway or bearer fallback)
- Reject unauthenticated requests early
- Validate game and team boundaries before any state mutation
- Keep rule enforcement in edge function/SQL, not client

## Prompt-Security Rules

- Secret-key defenses require non-empty target key when challenge type is `secret-key`
- Defense prompts should explicitly reject prompt-injection and secret leakage
- Attack logs may contain sensitive prompts; treat as restricted data

## Database Safety

- Use RLS to enforce tenant boundaries
- Prefer RPC/stored procedures for critical currency updates
- Validate challenge-game relationships before accepting attacks

## Operational Guidance

- Rotate keys when shared accidentally
- Audit attack logs for abuse patterns
- Keep dependency versions current and run periodic checks
