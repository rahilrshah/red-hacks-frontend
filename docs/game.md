# Game Rules (In-Depth)

This document is the canonical game-design reference for how Red Hacks gameplay works.

## 1) Game Objective

Teams compete by:
- Defending LLM challenges against unaligned behavior.
- Attacking other targets to cause unaligned behavior.
- Earning and stealing coins based on defense and attack outcomes.

High-level loop:
1. A round defines which challenges are active.
2. Teams set defenses (PvP rounds) or attack defaults (PvE rounds).
3. Successful attacks steal coins from defenders.
4. Teams with stronger strategy and prompt security finish with more coins.

## 2) Core Concepts

## 2.1 Game
A Game is a top-level competition container.

It contains:
- Teams
- Rounds
- Challenge availability per round
- Coin economy interactions

## 2.2 Team
A Team is a player group inside a game.

A team has:
- Membership (leader/member roles)
- Coin balance
- Defenses configured for available challenges (in PvP)

## 2.3 Challenge
A Challenge is a target scenario with:
- Model metadata
- Type (for example secret-key, tool-calling)
- Defense reward value
- Attack steal value
- Optional direct backend endpoint

Updated field:
- `challenge_url: string | null`

Routing rule:
- If `challenge_url` is present for a challenge, attack requests bypass the Supabase `attack` Edge Function and are sent directly to that URL using the same request arguments.
- If `challenge_url` is null, attack requests use the Supabase `attack` Edge Function.

## 2.4 Defended Challenge
A Defended Challenge is a team's active defensive setup for a challenge.

Typical defense data includes:
- System prompt
- Challenge-specific defense params (for example secret key)
- Active/inactive state

## 2.5 Coins
Coins are the game currency.

- Defense can grant coins when a defense is deployed.
- Attack success can transfer coins from defender to attacker.
- Teams with 0 coins are effectively eliminated as steal targets.

## 3) Round System (Updated)

Gameplay is now round-driven.

Each round has these attributes:

- `name: string`
- `id: int` (ordered from `0..n`)
- `game: string` (the game id)
- `available_challenges: List[string]` (challenge ids active in that round)
- `type: 'pvp' | 'pve'`

Meaning of round type:
- `pvp`: Teams configure defenses; other teams attack those defended challenges.
- `pve`: No team-specific defense setup; players attack challenge defaults, where the default prompt acts as the defense.

Operational expectations:
- Round `id` order defines progression (`0`, `1`, `2`, ...).
- Only `available_challenges` for the active/current round are legal attack targets.
- Attack surfaces and UI should be filtered by both `game` and active round.

## 4) PvP Rules

PvP clarifies to:
- Players attack other teams' defended challenges to steal coins.

Detailed rules:
1. A target must belong to another team in the same game.
2. A target challenge must be active for the current round.
3. Defender must have coins available for steals.
4. Attacker cannot attack their own team's defense.
5. Successful attack transfers coins according to challenge settings and transfer rules.
6. Cooldowns and anti-abuse checks may block repeated farming.

Defense in PvP:
- Teams choose which available challenges to defend.
- Deploying defense grants that challenge's defense reward (per game policy/constraints).
- Poor defense quality increases risk of coin loss to attackers.

## 5) PvE Rules

PvE clarifies to:
- Players attack the challenges defended by the challenge default prompt.

Detailed rules:
1. No opponent team defense is required to attack.
2. Target set comes from round `available_challenges`.
3. The challenge `default_prompt` is treated as the defense baseline.
4. Attack execution and success evaluation still follow challenge-specific logic.
5. Scoring/coin handling should follow configured PvE policy for the game.

## 6) Attack Routing Rules (Updated)

Request body should match the attack contract used by the Supabase edge function.

Common attack args include:
- Prompt/message content
- Conversation messages/history
- Optional guess/answer fields
- Target identifiers (depends on mode)

Routing decision:
1. Resolve target challenge.
2. If `challenge_url` exists, call it directly with the same body args and auth headers expected by the edge-function path.
3. Else call Supabase Edge Function (`attack`).

Design intent:
- Lets challenge authors provide specialized evaluators/backends without changing client attack UX.
- Preserves a common payload format across default and custom backends.

## 7) Round + Challenge Validity Rules

An attack is valid only if all are true:
- Request is authenticated.
- Actor is allowed to participate in the game.
- Challenge is in current round `available_challenges`.
- Target semantics match round type:
  - PvP: target is another team's defended challenge.
  - PvE: target is the challenge default defense.

Recommended server checks:
- Membership checks in PvP
- Self-target prevention in PvP
- Challenge enabled for active round
- Cooldown verification
- Coin transfer constraints

## 8) Economy Rules

Economy is challenge-driven.

Per challenge:
- `defense_reward_coins`: coins earned when defense is successfully set/deployed (PvP context)
- `attack_steal_coins`: maximum or configured steal value on successful attack

Expected behavior:
- Defense is an up-front opportunity to earn.
- Attack is a risk/reward mechanism to steal from defenders.
- Economy balancing should prevent one strategy from dominating (for example via cooldowns and capped steals).

## 9) Canonical Clarifications

- PvP: players attack other teams defended challenges to steal coins.
- PvE: players attack challenges defended by the default prompt.
- `challenge_url` present: bypass Supabase attack edge function and call the challenge backend directly with the same args.
- Round definitions determine legal challenge targets and mode behavior.

## 10) Implementation Notes

For this repository, keep these behaviors aligned across UI and backend:
- Round filter is authoritative for what can be attacked.
- Attack mode (`pvp` vs `pve`) controls target resolution.
- Direct backend (`challenge_url`) and edge function paths should stay payload-compatible.
- Critical checks (authorization, validity, transfer) must remain server-side.
