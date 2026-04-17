// Small pure helpers used by the server-side steering-vector routes. Kept
// separate from the `+server.ts` handlers so they are unit-testable
// without pulling in SvelteKit's `$env/*` virtual modules.

export interface BuildBackendRequestArgs {
	backendUrl: string;
	internalSecret: string;
	path: string; // e.g. "/v1/steering-vectors" or "/v1/steering-vectors:dry-run"
	userId: string;
	body: Record<string, unknown>;
}

export interface BackendRequest {
	url: string;
	init: {
		method: 'POST';
		headers: Record<string, string>;
		body: string;
	};
}

/**
 * Build the outbound fetch arguments for posting a vector-create or
 * dry-run request to the interp-backend. Always injects `created_by`
 * (overriding anything the client may have sent) and attaches the
 * shared-secret header.
 */
export function buildBackendRequest(args: BuildBackendRequestArgs): BackendRequest {
	const cleanBase = args.backendUrl.replace(/\/$/, '');
	const url = `${cleanBase}${args.path}`;
	const payload = { ...args.body, created_by: args.userId };
	return {
		url,
		init: {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Internal-Secret': args.internalSecret
			},
			body: JSON.stringify(payload)
		}
	};
}

/**
 * Extract a Bearer token from an Authorization header value.
 * Returns null on anything that isn't a non-empty Bearer scheme.
 */
export function extractBearerToken(authorizationHeader: string | null): string | null {
	if (!authorizationHeader) return null;
	const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
	const token = match?.[1]?.trim();
	return token && token.length > 0 ? token : null;
}

// --------------------------------------------------------------------------
// Attacker-steering payload normalization (used by attack/+server.ts).
// Kept in $lib so it's unit-testable and so both the attack route and any
// future "preview" route share a single source of truth.
// --------------------------------------------------------------------------

export interface AttackerSteeringInput {
	vector_id?: unknown;
	coefficient?: unknown;
}

export interface AttackerSteeringNormalized {
	vector_id: string;
	coefficient: number;
}

export type AttackerSteeringResult =
	| { ok: true; steering: AttackerSteeringNormalized | null }
	| { ok: false; status: 400 | 422; error: string };

/**
 * Extract, coerce, and range-check an `attacker_steering` field from an
 * attack request body. The vector's persisted `[min_coefficient,
 * max_coefficient]` is enforced server-side — V4.3 requires 422 on
 * overrides outside that range.
 *
 * Returns `{ok:true, steering:null}` when the caller didn't send the
 * field (backwards-compat case, V4.6).
 */
export function normalizeAttackerSteering(
	raw: unknown,
	vectorBounds: { min_coefficient: number; max_coefficient: number } | null
): AttackerSteeringResult {
	if (raw === undefined || raw === null) {
		return { ok: true, steering: null };
	}

	if (typeof raw !== 'object') {
		return { ok: false, status: 400, error: 'attacker_steering must be an object.' };
	}

	const input = raw as AttackerSteeringInput;
	const vectorId = typeof input.vector_id === 'string' ? input.vector_id.trim() : '';
	if (!vectorId) {
		return { ok: false, status: 400, error: 'attacker_steering.vector_id is required.' };
	}

	const coefficientNum = Number(input.coefficient);
	if (!Number.isFinite(coefficientNum)) {
		return {
			ok: false,
			status: 400,
			error: 'attacker_steering.coefficient must be a finite number.'
		};
	}

	if (vectorBounds) {
		if (coefficientNum < vectorBounds.min_coefficient || coefficientNum > vectorBounds.max_coefficient) {
			return {
				ok: false,
				status: 422,
				error: `attacker_steering.coefficient must be between ${vectorBounds.min_coefficient} and ${vectorBounds.max_coefficient}.`
			};
		}
	}

	return { ok: true, steering: { vector_id: vectorId, coefficient: coefficientNum } };
}
