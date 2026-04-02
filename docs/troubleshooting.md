# Troubleshooting

## Frontend Fails to Start

Symptoms:
- `pnpm dev` exits quickly or shows missing package errors

Checks:
- Run `pnpm install`
- Ensure Node version is compatible with project dependencies
- Run `pnpm check` to surface type/config issues

## Supabase Connection Errors

Symptoms:
- Network/auth errors in browser console
- Queries fail with URL or key issues

Checks:
- Confirm `.env` contains `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`
- Ensure local stack is running: `npx supabase status`
- Restart local stack if needed: `npx supabase stop` then `npx supabase start`

## Attack Request Returns 401

Checks:
- Ensure user has valid session/token
- Confirm edge function can read user identity
- In local/dev, verify bearer-token fallback path is functioning

## Attack Target Not Visible

Checks:
- Player must be on a team in the same game
- Opponent defense must exist and be in same game
- Challenge must be enabled in `game_challenges`
- Opponent team coins must be greater than 0

## Cannot Join Team or Game

Checks:
- Verify game invite code is active and valid
- Verify team invite code exists and belongs to that game
- Check one-team-per-game constraints and unique membership behavior

## Data Looks Outdated Locally

Reset and reseed local DB:

```sh
npx supabase db reset
```

Then refresh the app and repeat the smoke test flow.
