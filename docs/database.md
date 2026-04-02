# Database

## Source of Truth

- Migrations: `supabase/migrations`
- Local seed data: `supabase/seed.sql`

If schema and docs drift, migration SQL is authoritative.

## Key Entities

- `profiles`: User profile and role metadata
- `games`: Scheduled competitions with invite code
- `teams`: Team records per game, with coin balance
- `team_members`: User membership and role per team
- `challenges`: Challenge definitions and reward/steal values
- `game_challenges`: Which challenges are enabled for a game
- `defended_challenges`: Team defense configuration per challenge
- `attacks`: Recorded attack attempts and outcomes

## Rule Highlights

- A user can belong to only one team per game (enforced by schema/policies)
- Attack targets should be filtered to opponent teams in same game
- Teams at 0 coins are effectively eliminated from attack target list
- Challenge must be enabled via `game_challenges` for that game

## Coins and Transfers

Coin updates on successful attacks are performed server-side.

Current implementation relies on RPC call in edge function:
- `transfer_attack_coins`

Keep coin transfer logic centralized in SQL or server-side code, not frontend.

## Auth and RLS

- Anonymous sign-in is used in player onboarding flows
- RLS policies should enforce tenant boundaries (game/team ownership)
- Edge functions use service-role key and must perform explicit authorization checks before mutating state
