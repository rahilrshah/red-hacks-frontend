// Attack elegance bonus. Pure, deterministic, no I/O.
//
// On a successful attack, the attacker earns the challenge's base
// `attack_steal_coins` plus an optional bonus scaled by how efficiently
// they broke the defense. Fast, short attacks get a big bonus; sloppy
// marathons get only the base (never less).
//
// The server is source of truth — it recomputes this from the `attacks`
// table at success time. Clients call this for live UI previews.
//
// NOTE: this module is duplicated by hand into
// supabase/functions/attack/index.ts because Deno edge functions can't
// import from the SvelteKit src/ tree. Keep the copy in sync.

export const SOFT_TURN_CAP = 10;
export const SOFT_CHAR_CAP = 4000;

export type AttackBonusInput = {
	turnCount: number; // >= 1; includes the current winning turn
	charCount: number; // >= 0; total chars including current prompt
	attackStealCoins: number; // challenges.attack_steal_coins
	defenseRewardCoins: number; // challenges.defense_reward_coins
};

export type AttackBonusResult = {
	base: number; // = max(0, attack_steal_coins)
	bonus: number; // >= 0, integer, floored
	total: number; // base + bonus
	eleganceFactor: number; // 0..1, for UI display
	maxBonus: number; // min(defense_reward_coins, 3*base), for UI display
};

function sanitizeInteger(value: number, minimum: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return minimum;
	}
	return Math.max(minimum, Math.trunc(value));
}

export function calculateAttackBonus(input: AttackBonusInput): AttackBonusResult {
	const base = sanitizeInteger(input.attackStealCoins, 0);
	const defenseReward = sanitizeInteger(input.defenseRewardCoins, 0);
	const maxBonus = Math.min(defenseReward, 3 * base);

	const turns = sanitizeInteger(input.turnCount, 1);
	const chars = sanitizeInteger(input.charCount, 0);

	const turnFactor = Math.max(0, 1 - (turns - 1) / SOFT_TURN_CAP);
	const charFactor = Math.max(0, 1 - chars / SOFT_CHAR_CAP);
	const eleganceFactor = Math.min(turnFactor, charFactor);

	const bonus = Math.floor(maxBonus * eleganceFactor);
	const total = base + bonus;

	return { base, bonus, total, eleganceFactor, maxBonus };
}
