# Architecture

## Overview

This project is a SvelteKit frontend backed by Supabase services.

Main layers:
- UI routes in `src/routes`
- Shared frontend utilities in `src/lib`
- Data/auth/storage/edge runtime in Supabase

## Frontend

Key routing areas:
- `src/routes/play`: Player hub and invite-code onboarding
- `src/routes/play/[inviteCode]`: Team creation/join for a game
- `src/routes/game/[gameId]/defend`: Defense setup workflow
- `src/routes/game/[gameId]/attack`: Attack target selection and execution
- `src/routes/admin`: Admin tools for games/challenges/tools/interp args

Supabase browser client:
- `src/lib/supabaseClient.ts`
- Uses `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`
- Session persistence and refresh are enabled

## Backend (Supabase)

- Postgres tables model users, games, teams, challenges, defenses, attacks, and coin economy
- RLS policies restrict reads/writes by role and team/game membership
- Edge Function `supabase/functions/attack` handles attack validation and outcome logic
- Attack transcripts can be stored in Supabase Storage bucket `attack-logs`

## Data/Behavior Boundaries

- Frontend: orchestration, user input, page state, and route transitions
- Database/RPC/Edge function: authority for game integrity and coin transfer

For gameplay integrity, enforce rule checks server-side whenever possible (membership, cooldowns, enabled challenge checks, and coin transfer).
