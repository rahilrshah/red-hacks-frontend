# Red Hacks Frontend

Web app for a red-team/blue-team prompt-security game. Players join games and teams, configure defenses, attack opponent defenses, and earn/lose coins based on challenge outcomes.

Tech stack:
- SvelteKit 5 + TypeScript
- Tailwind CSS 4
- Supabase (Auth, Postgres, Storage, Edge Functions)

## Quick Start

1. Install dependencies:

```sh
pnpm install
```

2. Create `.env` in the project root:

```env
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
PUBLIC_SUPABASE_ANON_KEY=<from local Supabase output>
```

3. Start Supabase locally:

```sh
npx supabase start
```

4. Start the frontend:

```sh
pnpm dev
```

5. Open the app and run a smoke test:
- Go to `/play`
- Enter a game invite code
- Create or join a team
- Enter a game and visit defend/attack pages

## Scripts

- `pnpm dev`: Run Vite dev server
- `pnpm build`: Build production bundle
- `pnpm preview`: Preview production bundle
- `pnpm check`: Run SvelteKit sync + type checks
- `pnpm check:watch`: Type checks in watch mode

## Project Structure

- `src/routes`: Player, admin, game, and team pages
- `src/lib/supabaseClient.ts`: Browser Supabase client setup
- `supabase/migrations`: Schema and policy migrations
- `supabase/functions/attack`: Attack resolution Edge Function
- `supabase/seed.sql`: Local seed data for development

## Core Concepts

- Game: Top-level competition with an invite code
- Team: Group inside a game, with coin balance
- Challenge: Attack/defense scenario with a model and type
- Defended challenge: Team's configured defense for a challenge
- Attack: Attempt against an opponent defense; may transfer coins

## Documentation Index

- `docs/getting-started.md`
- `docs/architecture.md`
- `docs/database.md`
- `docs/edge-functions.md`
- `docs/gameplay-flows.md`
- `docs/game.md`
- `docs/security.md`
- `docs/troubleshooting.md`

## Notes

- Local auth/sign-in behavior for players relies on anonymous auth in player flows.
- Supabase Edge Function auth should support gateway auth context and bearer-token fallback in local/dev.
