// Shared types + capability sets for the activation-steering feature.
//
// Any site that historically checked `model_name === 'llama-interp-server'`
// should call `isSteeringCapable(model_name)` (or `STEERING_CAPABLE_MODELS`
// directly) so the rule stays in one place. This mirrors the
// `INTERNAL_MODELS` pattern introduced in the 2026-04-17 admin update — see
// `src/routes/admin/challenges/+page.svelte`.

/**
 * Models that the steering backend can serve. If/when we add more GPU-
 * served models (e.g. a llama-7b variant), add them here and every guard
 * in the frontend picks it up automatically.
 */
export const STEERING_CAPABLE_MODELS: ReadonlySet<string> = new Set([
	'llama-interp-server'
]);

/**
 * Case-insensitive match + the legacy "llama-interp*" substring rule. Use
 * this everywhere; never compare `model_name === 'llama-interp-server'`
 * inline.
 */
export function isSteeringCapable(modelName: string | null | undefined): boolean {
	if (!modelName) return false;
	const trimmed = modelName.trim().toLowerCase();
	if (!trimmed) return false;
	if (STEERING_CAPABLE_MODELS.has(trimmed)) return true;
	return trimmed.includes('llama-interp');
}

// --------------------------------------------------------------------------
// Vector shape — mirrors the `steering_vectors` Supabase table and the
// `/v1/steering-vectors` backend payload. Keep these in sync with the
// Python side.
// --------------------------------------------------------------------------

export type SteeringVisibility = 'private' | 'public';
export type SteeringPooling = 'last' | 'mean';
export type SteeringPosition = 'all' | 'last';

export interface SteeringVector {
	id: string;
	name: string;
	description: string | null;
	model_name: string;
	positive_examples: string[];
	negative_examples: string[];
	target_layers: number[];
	pooling: SteeringPooling;
	position: SteeringPosition;
	vector_payload: Record<string, number[]> | null;
	compiled_dim: number | null;
	min_coefficient: number;
	max_coefficient: number;
	visibility: SteeringVisibility;
	is_active: boolean;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

export interface SteeringVectorCreateInput {
	name: string;
	description?: string | null;
	positive_examples: string[];
	negative_examples: string[];
	target_layers?: number[];
	auto_select_layers?: boolean;
	pooling: SteeringPooling;
	position: SteeringPosition;
	min_coefficient: number;
	max_coefficient: number;
	visibility: SteeringVisibility;
}

// --------------------------------------------------------------------------
// Client-side validation shared between the create form and the admin
// validator route. The server-side Pydantic contract is the source of
// truth — these constants mirror the Python defaults.
// --------------------------------------------------------------------------

export const MIN_PAIRS = 3;
export const MAX_PAIRS = 32;
export const MAX_EXAMPLE_LENGTH = 500;
export const MAX_TARGET_LAYERS = 8;
export const MAX_COEFFICIENT_MAGNITUDE = 32;

export interface SteeringValidationIssue {
	field: string;
	message: string;
}

export function validateSteeringDraft(input: SteeringVectorCreateInput): SteeringValidationIssue[] {
	const issues: SteeringValidationIssue[] = [];

	const name = input.name?.trim() ?? '';
	if (name.length < 2) {
		issues.push({ field: 'name', message: 'Name must be at least 2 characters.' });
	}
	if (name.length > 64) {
		issues.push({ field: 'name', message: 'Name must be at most 64 characters.' });
	}

	const pos = input.positive_examples ?? [];
	const neg = input.negative_examples ?? [];

	if (pos.length !== neg.length) {
		issues.push({
			field: 'pairs',
			message: 'Positive and negative example lists must have the same length.'
		});
	}
	const pairs = Math.min(pos.length, neg.length);
	if (pairs < MIN_PAIRS) {
		issues.push({
			field: 'pairs',
			message: `At least ${MIN_PAIRS} matched pairs are required.`
		});
	}
	if (pairs > MAX_PAIRS) {
		issues.push({
			field: 'pairs',
			message: `At most ${MAX_PAIRS} pairs allowed.`
		});
	}

	const anyEmpty = [...pos, ...neg].some((text) => !text || !text.trim());
	if (pairs > 0 && anyEmpty) {
		issues.push({ field: 'pairs', message: 'Every example must be non-empty.' });
	}
	const anyTooLong = [...pos, ...neg].some((text) => (text ?? '').length > MAX_EXAMPLE_LENGTH);
	if (anyTooLong) {
		issues.push({
			field: 'pairs',
			message: `Each example must be at most ${MAX_EXAMPLE_LENGTH} characters.`
		});
	}

	if (!input.auto_select_layers) {
		const layers = input.target_layers ?? [];
		if (layers.length === 0) {
			issues.push({ field: 'target_layers', message: 'Pick at least one target layer (or enable Auto-select).' });
		}
		if (layers.length > MAX_TARGET_LAYERS) {
			issues.push({
				field: 'target_layers',
				message: `Pick at most ${MAX_TARGET_LAYERS} layers.`
			});
		}
	}

	if (!Number.isFinite(input.min_coefficient) || !Number.isFinite(input.max_coefficient)) {
		issues.push({ field: 'coefficient', message: 'Coefficient bounds must be numbers.' });
	} else {
		if (input.min_coefficient >= input.max_coefficient) {
			issues.push({ field: 'coefficient', message: 'min_coefficient must be strictly less than max_coefficient.' });
		}
		if (Math.abs(input.min_coefficient) > MAX_COEFFICIENT_MAGNITUDE || Math.abs(input.max_coefficient) > MAX_COEFFICIENT_MAGNITUDE) {
			issues.push({
				field: 'coefficient',
				message: `Coefficient magnitude must not exceed ${MAX_COEFFICIENT_MAGNITUDE}.`
			});
		}
	}

	if (input.pooling !== 'last' && input.pooling !== 'mean') {
		issues.push({ field: 'pooling', message: 'Pooling must be "last" or "mean".' });
	}
	if (input.position !== 'all' && input.position !== 'last') {
		issues.push({ field: 'position', message: 'Position must be "all" or "last".' });
	}
	if (input.visibility !== 'private' && input.visibility !== 'public') {
		issues.push({ field: 'visibility', message: 'Visibility must be "private" or "public".' });
	}

	return issues;
}

// --------------------------------------------------------------------------
// Admin validator result shape — mirrors
// `/admin/challenges/validate-model/+server.ts` so the existing result-card
// component can render it unchanged.
// --------------------------------------------------------------------------

export interface SteeringValidateResult {
	ok: boolean;
	error?: string;
	details?: {
		target_layers: number[];
		layer_source: 'manual' | 'auto';
		dim: number;
		num_hidden_layers: number;
		probe_accuracies: Record<string, number>;
		pairs: number;
	};
}
