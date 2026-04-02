# Getting Started

## Prerequisites

- Node.js 20+
- pnpm
- Supabase CLI

## 1. Install Dependencies

```sh
pnpm install
```

## 2. Configure Environment Variables

Create `.env` in the repository root:

```env
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
PUBLIC_SUPABASE_ANON_KEY=<local anon key>
```

Where to get values:
- Run `npx supabase start`
- Copy the local API URL and anon key from the CLI output

## 3. Start Supabase

```sh
npx supabase start
```

Useful local commands:

```sh
npx supabase db reset
npx supabase status
```

## 4. Run the Frontend

```sh
pnpm dev
```

Open the local Vite URL shown in terminal.

## 5. Verify Core Flow

1. Go to `/play`.
2. Enter a game invite code from seeded data (example: `CODE12`).
3. Create a team or join with team invite code.
4. Open `/game/<gameId>` to confirm the current round and whether it is PvP or PvE.
5. Open `/game/<gameId>/defend` to configure defenses, then `/game/<gameId>/attack` to choose a target for the active round.

## Seed Data Tips

The local seed includes:
- Multiple users and profiles
- Games and teams
- Challenges
- Defended challenges (including secret-key setups)

See `supabase/seed.sql` for exact seeded IDs and invite codes.
