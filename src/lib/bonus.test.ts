import { describe, expect, it } from 'vitest'
import {
	calculateAttackBonus,
	SOFT_CHAR_CAP,
	SOFT_TURN_CAP,
	type AttackBonusInput
} from './bonus'

// ---------- fixtures ----------

function makeInput(overrides: Partial<AttackBonusInput> = {}): AttackBonusInput {
	return {
		turnCount: 1,
		charCount: 0,
		attackStealCoins: 10,
		defenseRewardCoins: 50,
		...overrides
	}
}

// ---------- basic shapes ----------

describe('calculateAttackBonus — basic shapes', () => {
	it('1 turn, 0 chars: full bonus capped at 3x steal when reward is generous', () => {
		const result = calculateAttackBonus(
			makeInput({ turnCount: 1, charCount: 0, attackStealCoins: 10, defenseRewardCoins: 50 })
		)
		expect(result.base).toBe(10)
		expect(result.maxBonus).toBe(30) // min(50, 3*10)
		expect(result.bonus).toBe(30)
		expect(result.total).toBe(40)
		expect(result.eleganceFactor).toBe(1)
	})

	it('reward below 3x steal: max bonus is defense_reward_coins', () => {
		const result = calculateAttackBonus(
			makeInput({ turnCount: 1, charCount: 0, attackStealCoins: 10, defenseRewardCoins: 5 })
		)
		expect(result.maxBonus).toBe(5)
		expect(result.bonus).toBe(5)
		expect(result.total).toBe(15)
	})

	it('defense_reward_coins = 0: base only, no bonus ceiling', () => {
		const result = calculateAttackBonus(
			makeInput({ defenseRewardCoins: 0 })
		)
		expect(result.base).toBe(10)
		expect(result.maxBonus).toBe(0)
		expect(result.bonus).toBe(0)
		expect(result.total).toBe(10)
	})

	it('attack_steal_coins = 0: nothing pays out, even on perfect elegance', () => {
		const result = calculateAttackBonus(
			makeInput({ attackStealCoins: 0, defenseRewardCoins: 100 })
		)
		expect(result.base).toBe(0)
		expect(result.maxBonus).toBe(0)
		expect(result.bonus).toBe(0)
		expect(result.total).toBe(0)
	})
})

// ---------- turn-cap decay ----------

describe('calculateAttackBonus — turn decay', () => {
	it('6 turns: elegance factor 0.5 → bonus is half of max', () => {
		const result = calculateAttackBonus(makeInput({ turnCount: 6 }))
		expect(result.eleganceFactor).toBe(0.5)
		expect(result.bonus).toBe(15) // floor(30 * 0.5)
		expect(result.total).toBe(25)
	})

	it('exactly SOFT_TURN_CAP + 1 turns: elegance 0, base only', () => {
		const result = calculateAttackBonus(makeInput({ turnCount: SOFT_TURN_CAP + 1 }))
		expect(result.eleganceFactor).toBe(0)
		expect(result.bonus).toBe(0)
		expect(result.total).toBe(10)
	})

	it('50 turns: clamped to 0, still pays base (no sloppy penalty)', () => {
		const result = calculateAttackBonus(makeInput({ turnCount: 50 }))
		expect(result.eleganceFactor).toBe(0)
		expect(result.total).toBe(10)
	})

	it('SOFT_TURN_CAP turns: small residual bonus (floor of fp-approximated 30 * 0.1 = 2)', () => {
		// Nominal elegance = 0.1, but JS float gives 0.0999..., so 30 * 0.0999... floors to 2.
		const result = calculateAttackBonus(makeInput({ turnCount: SOFT_TURN_CAP }))
		expect(result.eleganceFactor).toBeCloseTo(0.1, 10)
		expect(result.bonus).toBe(2)
	})
})

// ---------- char-cap decay ----------

describe('calculateAttackBonus — char decay', () => {
	it('half the char cap: elegance 0.5', () => {
		const result = calculateAttackBonus(makeInput({ charCount: SOFT_CHAR_CAP / 2 }))
		expect(result.eleganceFactor).toBe(0.5)
		expect(result.bonus).toBe(15)
	})

	it('exactly the char cap: elegance 0, base only', () => {
		const result = calculateAttackBonus(makeInput({ charCount: SOFT_CHAR_CAP }))
		expect(result.eleganceFactor).toBe(0)
		expect(result.bonus).toBe(0)
		expect(result.total).toBe(10)
	})

	it('way over char cap: clamped to 0, still pays base', () => {
		const result = calculateAttackBonus(makeInput({ charCount: 1_000_000 }))
		expect(result.eleganceFactor).toBe(0)
		expect(result.total).toBe(10)
	})
})

// ---------- stricter-of-two-caps ----------

describe('calculateAttackBonus — combined decay', () => {
	it('symmetry: half turn cap and half char cap both give elegance 0.5', () => {
		const turnDecayed = calculateAttackBonus(makeInput({ turnCount: 6, charCount: 0 }))
		const charDecayed = calculateAttackBonus(makeInput({ turnCount: 1, charCount: 2000 }))
		expect(turnDecayed.eleganceFactor).toBe(0.5)
		expect(charDecayed.eleganceFactor).toBe(0.5)
	})

	it('both half: elegance = min(0.5, 0.5) = 0.5', () => {
		const result = calculateAttackBonus(makeInput({ turnCount: 6, charCount: 2000 }))
		expect(result.eleganceFactor).toBe(0.5)
		expect(result.bonus).toBe(15)
	})

	it('stricter char factor wins when char decay outpaces turn decay', () => {
		// turns=3 → turnFactor 0.8, chars=3500 → charFactor 0.125
		const result = calculateAttackBonus(makeInput({ turnCount: 3, charCount: 3500 }))
		expect(result.eleganceFactor).toBeCloseTo(0.125, 10)
		expect(result.bonus).toBe(3) // floor(30 * 0.125)
	})

	it('stricter turn factor wins when turn decay outpaces char decay', () => {
		// turns=11 → turnFactor 0, chars=0 → charFactor 1 → elegance 0
		const result = calculateAttackBonus(makeInput({ turnCount: 11, charCount: 0 }))
		expect(result.eleganceFactor).toBe(0)
	})
})

// ---------- defensive inputs ----------

describe('calculateAttackBonus — defensive input handling', () => {
	it('turnCount 0 clamps to 1 (treated as 1-turn win)', () => {
		const result = calculateAttackBonus(makeInput({ turnCount: 0 }))
		expect(result.eleganceFactor).toBe(1)
		expect(result.total).toBe(40)
	})

	it('negative turnCount clamps to 1', () => {
		const result = calculateAttackBonus(makeInput({ turnCount: -5 }))
		expect(result.eleganceFactor).toBe(1)
	})

	it('negative charCount clamps to 0', () => {
		const result = calculateAttackBonus(makeInput({ charCount: -100 }))
		expect(result.eleganceFactor).toBe(1)
	})

	it('fractional turnCount truncates via Math.trunc', () => {
		// 2.7 truncates to 2, turnFactor = 1 - 1/10 = 0.9
		const result = calculateAttackBonus(makeInput({ turnCount: 2.7 }))
		expect(result.eleganceFactor).toBeCloseTo(0.9, 10)
	})

	it('negative attack_steal_coins clamps to 0', () => {
		const result = calculateAttackBonus(makeInput({ attackStealCoins: -10 }))
		expect(result.base).toBe(0)
		expect(result.total).toBe(0)
	})

	it('negative defense_reward_coins clamps to 0', () => {
		const result = calculateAttackBonus(makeInput({ defenseRewardCoins: -50 }))
		expect(result.maxBonus).toBe(0)
		expect(result.bonus).toBe(0)
	})

	it('NaN everywhere falls back to safe defaults without throwing', () => {
		const result = calculateAttackBonus({
			turnCount: NaN,
			charCount: NaN,
			attackStealCoins: NaN,
			defenseRewardCoins: NaN
		})
		expect(result.base).toBe(0)
		expect(result.bonus).toBe(0)
		expect(result.total).toBe(0)
	})
})

// ---------- flooring ----------

describe('calculateAttackBonus — integer flooring', () => {
	it('exact integer bonus: no fractional coin drift', () => {
		const result = calculateAttackBonus(
			makeInput({ turnCount: 1, attackStealCoins: 10, defenseRewardCoins: 7 })
		)
		expect(result.maxBonus).toBe(7)
		expect(result.bonus).toBe(7)
		expect(Number.isInteger(result.bonus)).toBe(true)
	})

	it('fractional intermediate bonus is floored, not rounded', () => {
		// turns=2, maxBonus=5, elegance=0.9 → 5 * 0.9 = 4.5 → floor to 4
		const result = calculateAttackBonus(
			makeInput({ turnCount: 2, attackStealCoins: 10, defenseRewardCoins: 5 })
		)
		expect(result.maxBonus).toBe(5)
		expect(result.eleganceFactor).toBeCloseTo(0.9, 10)
		expect(result.bonus).toBe(4) // NOT 5
		expect(result.total).toBe(14)
	})
})

// ---------- exported constants ----------

describe('exported tuning constants', () => {
	it('SOFT_TURN_CAP is 10', () => {
		expect(SOFT_TURN_CAP).toBe(10)
	})

	it('SOFT_CHAR_CAP is 4000', () => {
		expect(SOFT_CHAR_CAP).toBe(4000)
	})
})
