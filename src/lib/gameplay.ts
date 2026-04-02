export type RoundType = 'pvp' | 'pve'

export type GameRound = {
	game_id: string
	round_index: number
	name: string
	type: RoundType
	required_defenses: number | null
	available_challenges: string[] | null
	duration_minutes: number | null
	intermission_minutes: number | null
}

export type GameWindow = {
	is_active: boolean
	start_time: string
	end_time: string
}

export type RoundTimelineEntry = {
	round: GameRound
	startMs: number
	endMs: number
	intermissionEndMs: number
}

export type RoundPhase = 'pre-game' | 'round-active' | 'intermission' | 'post-game' | 'no-rounds'

export type RoundRuntimeContext = {
	phase: RoundPhase
	gameActive: boolean
	currentRound: GameRound | null
	nextRound: GameRound | null
	timeline: RoundTimelineEntry[]
	timeRemainingSeconds: number | null
}

type SupabaseLike = {
	from: (table: string) => any
}

type GameWindowLike = {
	is_active?: boolean
	start_time?: string
	end_time?: string
}

function asValidDateMs(value: string | null | undefined): number | null {
	if (!value) return null
	const ms = new Date(value).getTime()
	if (Number.isNaN(ms)) {
		return null
	}
	return ms
}

function normalizeRoundMinutes(value: number | null | undefined, minimum: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return minimum
	}

	return Math.max(minimum, Math.trunc(value))
}

export function isGameActive(gameData: GameWindowLike): boolean {
	if (!gameData?.is_active) {
		return false
	}

	const startMs = asValidDateMs(gameData.start_time)
	const endMs = asValidDateMs(gameData.end_time)

	if (startMs === null || endMs === null) {
		return false
	}

	const now = Date.now()
	return now >= startMs && now <= endMs
}

export function calculateRoundTimeline(gameStartIso: string, rounds: GameRound[]): RoundTimelineEntry[] {
	const gameStartMs = asValidDateMs(gameStartIso)
	if (gameStartMs === null) {
		return []
	}

	const orderedRounds = [...rounds].sort((left, right) => left.round_index - right.round_index)
	let cursorMs = gameStartMs

	return orderedRounds.map((round) => {
		const durationMinutes = normalizeRoundMinutes(round.duration_minutes, 1)
		const intermissionMinutes = normalizeRoundMinutes(round.intermission_minutes, 0)
		const durationMs = durationMinutes * 60_000
		const intermissionMs = intermissionMinutes * 60_000
		const startMs = cursorMs
		const endMs = startMs + durationMs
		const intermissionEndMs = endMs + intermissionMs

		cursorMs = intermissionEndMs

		return {
			round,
			startMs,
			endMs,
			intermissionEndMs
		}
	})
}

export function getRoundRuntimeContext(
	gameWindow: GameWindow,
	rounds: GameRound[],
	nowMs: number = Date.now()
): RoundRuntimeContext {
	const startMs = asValidDateMs(gameWindow.start_time)
	const endMs = asValidDateMs(gameWindow.end_time)

	if (startMs === null || endMs === null) {
		return {
			phase: 'no-rounds',
			gameActive: false,
			currentRound: null,
			nextRound: null,
			timeline: [],
			timeRemainingSeconds: null
		}
	}

	const timeline = calculateRoundTimeline(gameWindow.start_time, rounds)

	if (timeline.length === 0) {
		if (nowMs < startMs) {
			return {
				phase: 'pre-game',
				gameActive: false,
				currentRound: null,
				nextRound: null,
				timeline,
				timeRemainingSeconds: Math.max(0, Math.floor((startMs - nowMs) / 1000))
			}
		}

		if (nowMs > endMs || !gameWindow.is_active) {
			return {
				phase: 'post-game',
				gameActive: false,
				currentRound: null,
				nextRound: null,
				timeline,
				timeRemainingSeconds: null
			}
		}

		return {
			phase: 'no-rounds',
			gameActive: true,
			currentRound: null,
			nextRound: null,
			timeline,
			timeRemainingSeconds: null
		}
	}

	if (!gameWindow.is_active || nowMs > endMs) {
		return {
			phase: 'post-game',
			gameActive: false,
			currentRound: null,
			nextRound: null,
			timeline,
			timeRemainingSeconds: null
		}
	}

	if (nowMs < startMs) {
		return {
			phase: 'pre-game',
			gameActive: false,
			currentRound: null,
			nextRound: timeline[0]?.round ?? null,
			timeline,
			timeRemainingSeconds: Math.max(0, Math.floor((startMs - nowMs) / 1000))
		}
	}

	for (let index = 0; index < timeline.length; index += 1) {
		const entry = timeline[index]
		if (nowMs >= entry.startMs && nowMs < entry.endMs) {
			return {
				phase: 'round-active',
				gameActive: true,
				currentRound: entry.round,
				nextRound: timeline[index + 1]?.round ?? null,
				timeline,
				timeRemainingSeconds: Math.max(0, Math.floor((entry.endMs - nowMs) / 1000))
			}
		}

		if (nowMs >= entry.endMs && nowMs < entry.intermissionEndMs) {
			return {
				phase: 'intermission',
				gameActive: true,
				currentRound: entry.round,
				nextRound: timeline[index + 1]?.round ?? null,
				timeline,
				timeRemainingSeconds: Math.max(0, Math.floor((entry.intermissionEndMs - nowMs) / 1000))
			}
		}
	}

	return {
		phase: 'post-game',
		gameActive: false,
		currentRound: null,
		nextRound: null,
		timeline,
		timeRemainingSeconds: null
	}
}

export async function loadRoundRuntimeContext(supabase: SupabaseLike, gameId: string): Promise<RoundRuntimeContext> {
	const { data: gameData, error: gameError } = await supabase
		.from('games')
		.select('is_active, start_time, end_time')
		.eq('id', gameId)
		.maybeSingle()

	if (gameError) {
		throw gameError
	}

	if (!gameData?.start_time || !gameData?.end_time) {
		return {
			phase: 'no-rounds',
			gameActive: false,
			currentRound: null,
			nextRound: null,
			timeline: [],
			timeRemainingSeconds: null
		}
	}

	const { data: roundsData, error: roundsError } = await supabase
		.from('rounds')
		.select('game_id, round_index, name, type, required_defenses, available_challenges, duration_minutes, intermission_minutes')
		.eq('game_id', gameId)
		.order('round_index', { ascending: true })

	if (roundsError) {
		throw roundsError
	}

	return getRoundRuntimeContext(
		{
			is_active: Boolean(gameData.is_active),
			start_time: gameData.start_time,
			end_time: gameData.end_time
		},
		(roundsData ?? []) as GameRound[]
	)
}

export async function loadCurrentRound(supabase: SupabaseLike, gameId: string): Promise<GameRound | null> {
	const runtimeContext = await loadRoundRuntimeContext(supabase, gameId)
	if (runtimeContext.phase === 'round-active') {
		return runtimeContext.currentRound
	}

	// Keep returning the last round during intermission so challenge filtering remains stable.
	if (runtimeContext.phase === 'intermission') {
		return runtimeContext.currentRound
	}

	return null
}

export async function loadGameChallengeIds(supabase: SupabaseLike, gameId: string): Promise<string[]> {
	const { data, error } = await supabase
		.from('game_challenges')
		.select('challenge_id')
		.eq('game_id', gameId)

	if (error) {
		throw error
	}

	return (data ?? [])
		.map((row: any) => row.challenge_id)
		.filter((challengeId: unknown): challengeId is string => typeof challengeId === 'string' && challengeId.length > 0)
}

export async function loadRoundChallengeIds(
	supabase: SupabaseLike,
	gameId: string,
	roundInfo: GameRound | null
): Promise<string[]> {
	const explicitChallengeIds = (roundInfo?.available_challenges ?? []).filter(
		(challengeId): challengeId is string => typeof challengeId === 'string' && challengeId.length > 0
	)

	if (explicitChallengeIds.length > 0) {
		return explicitChallengeIds
	}

	return loadGameChallengeIds(supabase, gameId)
}

export function resolveRoundType(roundInfo: GameRound | null, fallback: RoundType = 'pvp'): RoundType {
	if (roundInfo?.type === 'pvp' || roundInfo?.type === 'pve') {
		return roundInfo.type
	}

	return fallback
}