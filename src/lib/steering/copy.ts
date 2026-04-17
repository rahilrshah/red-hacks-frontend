// User-facing copy for the steering-vectors feature. Kept separate from
// the Svelte components so we can unit-test the wording and keep
// tone/phrasing consistent between the library page, the create form, and
// the attack-side dropdown.

export const STEERING_CREATE_GUIDANCE = {
	heading: 'What this does',
	body: `A steering vector nudges the model's hidden state in a chosen direction. You teach it the direction by giving it matched pairs of examples that differ only in the behavior you want to control.`,
	rulesHeading: 'Rules of thumb',
	rules: [
		'Provide at least 3 pairs. Each positive example is matched to one negative example at the same index. Both lists must have the same length.',
		'Make each pair a minimal contrast: same topic and grammar, opposite attitude (e.g. "I will help you with that right away." ↔ "I refuse to help with that.").',
		'Short, concrete sentences work better than long paragraphs.',
		'Target layers near the end of the model (e.g. last quarter) usually generalize best. If unsure, tick Auto-select layers and we will pick for you using probe accuracy.',
		'Coefficient at attack time scales the direction; positive values push toward the positives, negative values toward the negatives.'
	]
} as const;

export const STEERING_FIELD_LABELS = {
	name: 'Name',
	description: 'Description',
	model: 'Model',
	pairs: 'Example pairs',
	autoSelectLayers: 'Auto-select layers',
	targetLayers: 'Target layers',
	pooling: 'Pooling',
	position: 'Position',
	coefficientRange: 'Coefficient range',
	visibility: 'Visibility'
} as const;

export const STEERING_FIELD_HELPERS = {
	name: 'e.g. compliant-v1',
	description: 'Optional — what behavior does this direction represent?',
	positivePlaceholder: 'Positive example — model behaves the way you want',
	negativePlaceholder: 'Negative example — matched opposite of the positive',
	pairsCount: (count: number, min: number) =>
		count < min
			? `${min} pairs minimum. ${count} pair${count === 1 ? '' : 's'} matched so far.`
			: `${count} pair${count === 1 ? '' : 's'} matched.`,
	autoSelectLayers: 'Recommended — picks layers with the highest probe accuracy.',
	targetLayers: 'Pick 2–4 layers near the end of the model.',
	poolingLast: "'Last' captures the final hidden state.",
	poolingMean: "'Mean' averages across tokens.",
	positionAll: "'All' steers every token during generation.",
	positionLast: "'Last' only nudges the last token.",
	coefficientRange: 'Bounds limit how far an attacker can push this direction (|value| ≤ 32).',
	visibilityPrivate: 'Private vectors are only usable by you.',
	visibilityPublic: 'Public vectors can be used by any player as an attack tool.'
} as const;

export const STEERING_LIBRARY_COPY = {
	title: 'Your steering vectors',
	empty: "You haven't created any steering vectors yet.",
	newButton: 'New steering vector',
	publicLabel: 'Public',
	privateLabel: 'Private'
} as const;

export const STEERING_ATTACK_COPY = {
	heading: 'Attacker steering (optional)',
	body:
		"Nudge the defender's model in a direction of your choice. Pick one of your vectors (or any public one) and set how hard to push.",
	unsupported: 'This target runs a non-steering model, so attacker-steering is not available for this challenge.',
	empty: 'No compatible steering vectors yet. Build one from the Steering Vectors page, or pick a public one.',
	noneOption: 'None — ship the prompt as-is',
	coefficientLabel: (vectorMin: number, vectorMax: number) =>
		`Coefficient (${vectorMin.toFixed(2)} ≤ value ≤ ${vectorMax.toFixed(2)})`,
	loading: 'Loading compatible steering vectors…',
	errorPrefix: 'Failed to load steering vectors: '
} as const;
