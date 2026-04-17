import { describe, expect, it } from 'vitest';
import { buildBackendRequest, extractBearerToken, normalizeAttackerSteering } from './server';
import { validateSteeringDraft, type SteeringVectorCreateInput } from './types';

describe('extractBearerToken', () => {
	it('returns null when header is missing', () => {
		expect(extractBearerToken(null)).toBeNull();
	});

	it('returns null on non-Bearer schemes', () => {
		expect(extractBearerToken('Basic abc:def')).toBeNull();
	});

	it('returns the token for a well-formed Bearer header', () => {
		expect(extractBearerToken('Bearer sk-test-token-123')).toBe('sk-test-token-123');
	});

	it('is case-insensitive on the scheme and trims whitespace', () => {
		expect(extractBearerToken('bearer   tok  ')).toBe('tok');
	});

	it('returns null when token is empty', () => {
		expect(extractBearerToken('Bearer   ')).toBeNull();
	});
});

describe('buildBackendRequest', () => {
	it('injects created_by from the authenticated user id, overriding any client value', () => {
		const req = buildBackendRequest({
			backendUrl: 'http://interp:8000/',
			internalSecret: 'shh',
			path: '/v1/steering-vectors',
			userId: 'user-abc',
			body: { name: 'foo', created_by: 'attacker-spoofed-id' }
		});
		const parsed = JSON.parse(req.init.body);
		expect(parsed.created_by).toBe('user-abc');
		expect(parsed.name).toBe('foo');
	});

	it('attaches the X-Internal-Secret header and the right URL', () => {
		const req = buildBackendRequest({
			backendUrl: 'http://interp:8000',
			internalSecret: 'top-secret-32-char-value-here___',
			path: '/v1/steering-vectors:dry-run',
			userId: 'user-42',
			body: { positive_examples: [] }
		});
		expect(req.url).toBe('http://interp:8000/v1/steering-vectors:dry-run');
		expect(req.init.headers['X-Internal-Secret']).toBe('top-secret-32-char-value-here___');
		expect(req.init.headers['Content-Type']).toBe('application/json');
		expect(req.init.method).toBe('POST');
	});

	it('strips a trailing slash from the backend base URL', () => {
		const req = buildBackendRequest({
			backendUrl: 'http://interp:8000/',
			internalSecret: 'x',
			path: '/v1/steering-vectors',
			userId: 'u',
			body: {}
		});
		expect(req.url).toBe('http://interp:8000/v1/steering-vectors');
	});
});

// Also cover a few edges of the draft validator so the client-side copy
// and the server contract stay in sync.
describe('validateSteeringDraft', () => {
	function draft(overrides: Partial<SteeringVectorCreateInput> = {}): SteeringVectorCreateInput {
		return {
			name: 'valid-name',
			description: null,
			positive_examples: ['a', 'b', 'c'],
			negative_examples: ['x', 'y', 'z'],
			target_layers: [3],
			auto_select_layers: false,
			pooling: 'last',
			position: 'all',
			min_coefficient: -4,
			max_coefficient: 4,
			visibility: 'private',
			...overrides
		};
	}

	it('accepts a well-formed draft', () => {
		expect(validateSteeringDraft(draft())).toEqual([]);
	});

	it('rejects when fewer than 3 pairs', () => {
		const issues = validateSteeringDraft(
			draft({ positive_examples: ['a', 'b'], negative_examples: ['x', 'y'] })
		);
		expect(issues.some((i) => i.message.includes('3 matched pairs'))).toBe(true);
	});

	it('rejects when positive and negative lengths differ', () => {
		const issues = validateSteeringDraft(
			draft({ positive_examples: ['a', 'b', 'c'], negative_examples: ['x', 'y'] })
		);
		expect(issues.some((i) => i.message.includes('same length'))).toBe(true);
	});

	it('rejects when min >= max coefficient', () => {
		const issues = validateSteeringDraft(draft({ min_coefficient: 4, max_coefficient: 4 }));
		expect(issues.some((i) => i.message.includes('strictly less'))).toBe(true);
	});

	it('accepts auto-select with empty target_layers', () => {
		expect(
			validateSteeringDraft(draft({ auto_select_layers: true, target_layers: [] }))
		).toEqual([]);
	});

	it('rejects manual selection with no target_layers', () => {
		const issues = validateSteeringDraft(
			draft({ auto_select_layers: false, target_layers: [] })
		);
		expect(issues.some((i) => i.field === 'target_layers')).toBe(true);
	});
});

describe('normalizeAttackerSteering', () => {
	const bounds = { min_coefficient: -4, max_coefficient: 4 };

	it('returns null steering when field is absent (backwards compat)', () => {
		expect(normalizeAttackerSteering(undefined, bounds)).toEqual({ ok: true, steering: null });
		expect(normalizeAttackerSteering(null, bounds)).toEqual({ ok: true, steering: null });
	});

	it('accepts a well-formed payload within vector bounds', () => {
		const result = normalizeAttackerSteering(
			{ vector_id: 'v-123', coefficient: 1.5 },
			bounds
		);
		expect(result).toEqual({ ok: true, steering: { vector_id: 'v-123', coefficient: 1.5 } });
	});

	it('rejects a non-object payload', () => {
		const result = normalizeAttackerSteering(42, bounds);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(400);
	});

	it('rejects a payload missing vector_id', () => {
		const result = normalizeAttackerSteering({ coefficient: 1 }, bounds);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(400);
	});

	it('rejects a non-finite coefficient', () => {
		const result = normalizeAttackerSteering({ vector_id: 'v', coefficient: 'nope' }, bounds);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(400);
	});

	it('returns 422 when coefficient exceeds the vector max', () => {
		const result = normalizeAttackerSteering({ vector_id: 'v', coefficient: 9 }, bounds);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(422);
	});

	it('returns 422 when coefficient is below the vector min', () => {
		const result = normalizeAttackerSteering({ vector_id: 'v', coefficient: -9 }, bounds);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(422);
	});

	it('skips range check when vectorBounds are null (e.g. vector not yet resolved)', () => {
		const result = normalizeAttackerSteering({ vector_id: 'v', coefficient: 999 }, null);
		expect(result.ok).toBe(true);
	});
});
