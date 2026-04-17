<script lang="ts">
  // Shared editor component for both the /new and /[id]/edit pages.
  // Renders the §5.2 guidance block, the example-pair editor, the
  // layer/pooling/position/coefficient knobs, and handles client-side
  // validation before posting to `/api/steering-vectors`.
  //
  // The guidance copy lives in `$lib/steering/copy.ts` — NEVER duplicate
  // it inline in this file (see V3.7).

  import { supabase } from '$lib/supabaseClient';
  import { goto } from '$app/navigation';
  import {
    STEERING_CREATE_GUIDANCE,
    STEERING_FIELD_HELPERS,
    STEERING_FIELD_LABELS
  } from './copy';
  import {
    MIN_PAIRS,
    MAX_PAIRS,
    MAX_EXAMPLE_LENGTH,
    MAX_COEFFICIENT_MAGNITUDE,
    validateSteeringDraft,
    type SteeringPooling,
    type SteeringPosition,
    type SteeringVector,
    type SteeringVectorCreateInput,
    type SteeringVisibility
  } from './types';

  type Props = {
    // Pre-fill values when editing. `null` on /new.
    initialVector?: Partial<SteeringVector> | null;
    mode: 'create' | 'edit';
  };

  let { initialVector = null, mode }: Props = $props();

  // Snapshot the hydration source once so the Svelte 5 linter doesn't fire
  // `state_referenced_locally` on every initializer below. The form is
  // intentionally hydrated once — subsequent prop changes shouldn't
  // clobber the user's in-progress edits.
  const seed = initialVector ?? {};
  const seedHasInitial = initialVector != null;

  // Form state --------------------------------------------------------
  let name = $state(seed.name ?? '');
  let description = $state(seed.description ?? '');
  let positive = $state<string[]>(
    seed.positive_examples && seed.positive_examples.length > 0
      ? [...seed.positive_examples]
      : ['', '', '']
  );
  let negative = $state<string[]>(
    seed.negative_examples && seed.negative_examples.length > 0
      ? [...seed.negative_examples]
      : ['', '', '']
  );
  let autoSelectLayers = $state(
    !seedHasInitial || !(seed.target_layers && seed.target_layers.length > 0)
  );
  let targetLayers = $state<number[]>(seed.target_layers ?? []);
  let pooling = $state<SteeringPooling>((seed.pooling as SteeringPooling) ?? 'last');
  let position = $state<SteeringPosition>((seed.position as SteeringPosition) ?? 'all');
  let minCoefficient = $state<number>(seed.min_coefficient ?? -6);
  let maxCoefficient = $state<number>(seed.max_coefficient ?? 6);
  let visibility = $state<SteeringVisibility>((seed.visibility as SteeringVisibility) ?? 'private');

  // Model metadata pulled from the backend --------------------------
  let modelName = $state(seed.model_name ?? '');
  let numHiddenLayers = $state<number | null>(null);
  let modelInfoError = $state('');

  let submitting = $state(false);
  let submitError = $state('');
  let successMessage = $state('');

  async function loadModelInfo() {
    try {
      // We proxy this through the admin validator purely for the
      // response envelope — but model info is not sensitive. We instead
      // ask the backend directly via its public GET. If INTERP_BACKEND_URL
      // isn't exposed to the browser (it shouldn't be), fall back to
      // whatever the row already knows.
      const response = await fetch('/api/steering-vectors?active_only=1');
      if (response.ok) {
        // Piggyback on an existing vector to learn the active model.
        const body = await response.json();
        const first = body?.vectors?.[0];
        if (first?.model_name) {
          modelName = first.model_name;
        }
      }
    } catch {
      // Non-fatal: the backend will validate target_layers server-side.
    }
  }

  async function addPair() {
    if (positive.length >= MAX_PAIRS) return;
    positive = [...positive, ''];
    negative = [...negative, ''];
  }

  async function removePair(index: number) {
    if (positive.length <= 1) return;
    positive = positive.filter((_, i) => i !== index);
    negative = negative.filter((_, i) => i !== index);
  }

  function toggleLayer(layer: number) {
    if (targetLayers.includes(layer)) {
      targetLayers = targetLayers.filter((l) => l !== layer);
    } else {
      targetLayers = [...targetLayers, layer].sort((a, b) => a - b);
    }
  }

  // V6.4: toggling auto-select (either direction) clears the manual layer
  // picker so the user doesn't submit a stale selection that the backend
  // would then silently ignore. Done via explicit event handler — NOT a
  // `$effect` — so the initial hydration from `seed.target_layers` is
  // preserved for edit mode.
  function onAutoSelectToggle(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    autoSelectLayers = target.checked;
    targetLayers = [];
  }

  // Derived ----------------------------------------------------------
  const pairCount = $derived(Math.min(positive.length, negative.length));
  const buildDraft = (): SteeringVectorCreateInput => ({
    name: name.trim(),
    description: description.trim() || null,
    positive_examples: positive.map((s) => s),
    negative_examples: negative.map((s) => s),
    target_layers: autoSelectLayers ? [] : [...targetLayers],
    auto_select_layers: autoSelectLayers,
    pooling,
    position,
    min_coefficient: Number(minCoefficient),
    max_coefficient: Number(maxCoefficient),
    visibility
  });
  const issues = $derived(validateSteeringDraft(buildDraft()));
  const canSubmit = $derived(!submitting && issues.length === 0);

  async function submit() {
    submitError = '';
    successMessage = '';
    const draft = buildDraft();
    const currentIssues = validateSteeringDraft(draft);
    if (currentIssues.length > 0) {
      submitError = currentIssues[0]?.message ?? 'Please fix the highlighted fields.';
      return;
    }
    submitting = true;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        submitError = 'Session expired. Please sign in again.';
        return;
      }

      const response = await fetch('/api/steering-vectors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(draft)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        submitError = body?.detail || body?.error || `Failed (${response.status}).`;
        return;
      }
      successMessage = mode === 'create' ? 'Vector created.' : 'Vector saved.';
      setTimeout(() => goto('/steering/vectors'), 600);
    } catch (err: any) {
      submitError = err?.message || 'Submission failed.';
    } finally {
      submitting = false;
    }
  }

  loadModelInfo();
</script>

<div class="mx-auto max-w-4xl px-6 py-10">
  <!-- Guidance block -->
  <div class="rounded-xl border border-white/10 bg-white/5 p-5 mb-8">
    <h2 class="text-lg font-semibold text-white">{STEERING_CREATE_GUIDANCE.heading}</h2>
    <p class="mt-2 text-sm text-gray-300">{STEERING_CREATE_GUIDANCE.body}</p>

    <h3 class="mt-4 text-sm font-semibold text-gray-200">{STEERING_CREATE_GUIDANCE.rulesHeading}</h3>
    <ul class="mt-2 list-disc list-inside space-y-1 text-sm text-gray-300">
      {#each STEERING_CREATE_GUIDANCE.rules as rule}
        <li>{rule}</li>
      {/each}
    </ul>
  </div>

  {#if submitError}
    <div class="mb-4 rounded-lg border border-red-500/40 bg-red-900/30 px-4 py-3 text-sm text-red-200">
      {submitError}
    </div>
  {/if}
  {#if successMessage}
    <div class="mb-4 rounded-lg border border-green-500/40 bg-green-900/30 px-4 py-3 text-sm text-green-200">
      {successMessage}
    </div>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div class="space-y-1.5">
      <label class="block text-sm font-medium text-gray-200" for="sv-name">
        {STEERING_FIELD_LABELS.name}
      </label>
      <input
        id="sv-name"
        bind:value={name}
        placeholder={STEERING_FIELD_HELPERS.name}
        class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white text-sm focus:ring-2 focus:ring-red-500/50 outline-none"
      />
    </div>

    <div class="space-y-1.5">
      <label class="block text-sm font-medium text-gray-200" for="sv-model">
        {STEERING_FIELD_LABELS.model}
      </label>
      <div id="sv-model" class="font-mono text-xs bg-black/40 border border-white/10 rounded-md px-3 py-2.5 text-gray-300">
        {modelName || 'llama-interp-server'}
      </div>
      {#if modelInfoError}
        <p class="text-xs text-amber-300">{modelInfoError}</p>
      {/if}
    </div>

    <div class="space-y-1.5 md:col-span-2">
      <label class="block text-sm font-medium text-gray-200" for="sv-description">
        {STEERING_FIELD_LABELS.description}
      </label>
      <textarea
        id="sv-description"
        bind:value={description}
        placeholder={STEERING_FIELD_HELPERS.description}
        class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white text-sm h-20 focus:ring-2 focus:ring-red-500/50 outline-none"
      ></textarea>
    </div>
  </div>

  <!-- Pairs editor -->
  <div class="mt-6">
    <div class="flex items-center justify-between">
      <label class="block text-sm font-medium text-gray-200">{STEERING_FIELD_LABELS.pairs}</label>
      <span class={pairCount < MIN_PAIRS ? 'text-xs text-red-400' : 'text-xs text-gray-400'}>
        {STEERING_FIELD_HELPERS.pairsCount(pairCount, MIN_PAIRS)}
      </span>
    </div>
    <div class="space-y-2 mt-2">
      {#each positive as _pos, i (i)}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 items-start">
          <input
            bind:value={positive[i]}
            maxlength={MAX_EXAMPLE_LENGTH}
            placeholder={STEERING_FIELD_HELPERS.positivePlaceholder}
            class="bg-black/40 border border-white/10 rounded-md p-2 text-white text-sm focus:ring-2 focus:ring-green-500/30 outline-none"
          />
          <div class="flex gap-2">
            <input
              bind:value={negative[i]}
              maxlength={MAX_EXAMPLE_LENGTH}
              placeholder={STEERING_FIELD_HELPERS.negativePlaceholder}
              class="flex-1 bg-black/40 border border-white/10 rounded-md p-2 text-white text-sm focus:ring-2 focus:ring-red-500/30 outline-none"
            />
            <button
              type="button"
              onclick={() => removePair(i)}
              class="text-gray-400 hover:text-red-300 text-sm px-2"
              aria-label="Remove pair"
              disabled={positive.length <= 1}
            >
              ×
            </button>
          </div>
        </div>
      {/each}
    </div>
    <button
      type="button"
      onclick={addPair}
      class="mt-3 text-sm text-red-300 hover:text-red-200"
      disabled={positive.length >= MAX_PAIRS}
    >
      + Add pair
    </button>
  </div>

  <!-- Layer selection -->
  <div class="mt-6 space-y-2">
    <label class="inline-flex items-center gap-2 text-sm text-gray-200">
      <input
        type="checkbox"
        checked={autoSelectLayers}
        onchange={onAutoSelectToggle}
        data-testid="auto-select-layers-toggle"
      />
      {STEERING_FIELD_LABELS.autoSelectLayers}
    </label>
    <p class="text-xs text-gray-400">{STEERING_FIELD_HELPERS.autoSelectLayers}</p>

    {#if !autoSelectLayers}
      <div class="mt-3" data-testid="manual-layer-picker">
        <p class="text-sm font-medium text-gray-200">{STEERING_FIELD_LABELS.targetLayers}</p>
        <p class="text-xs text-gray-400 mb-2">{STEERING_FIELD_HELPERS.targetLayers}</p>
        <div class="flex flex-wrap gap-2">
          {#each Array.from({ length: numHiddenLayers ?? 32 }, (_, i) => i) as layer}
            <button
              type="button"
              onclick={() => toggleLayer(layer)}
              class="text-xs rounded px-2 py-1 border {targetLayers.includes(layer)
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-black/40 border-white/10 text-gray-300 hover:border-white/30'}"
            >
              {layer}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
    <div>
      <p class="text-sm font-medium text-gray-200 mb-2">{STEERING_FIELD_LABELS.pooling}</p>
      <div class="flex gap-4 text-sm text-gray-200">
        <label class="inline-flex items-center gap-2">
          <input type="radio" bind:group={pooling} value="last" />
          Last token
        </label>
        <label class="inline-flex items-center gap-2">
          <input type="radio" bind:group={pooling} value="mean" />
          Mean
        </label>
      </div>
      <p class="text-xs text-gray-400 mt-1">
        {pooling === 'last' ? STEERING_FIELD_HELPERS.poolingLast : STEERING_FIELD_HELPERS.poolingMean}
      </p>
    </div>

    <div>
      <p class="text-sm font-medium text-gray-200 mb-2">{STEERING_FIELD_LABELS.position}</p>
      <div class="flex gap-4 text-sm text-gray-200">
        <label class="inline-flex items-center gap-2">
          <input type="radio" bind:group={position} value="all" />
          All tokens
        </label>
        <label class="inline-flex items-center gap-2">
          <input type="radio" bind:group={position} value="last" />
          Last
        </label>
      </div>
      <p class="text-xs text-gray-400 mt-1">
        {position === 'all' ? STEERING_FIELD_HELPERS.positionAll : STEERING_FIELD_HELPERS.positionLast}
      </p>
    </div>
  </div>

  <div class="mt-6">
    <p class="text-sm font-medium text-gray-200 mb-2">{STEERING_FIELD_LABELS.coefficientRange}</p>
    <div class="flex items-center gap-3">
      <input
        type="number"
        bind:value={minCoefficient}
        min={-MAX_COEFFICIENT_MAGNITUDE}
        max={MAX_COEFFICIENT_MAGNITUDE}
        step="0.5"
        class="w-32 bg-black/40 border border-white/10 rounded-md p-2 text-white text-sm"
      />
      <span class="text-gray-400">→</span>
      <input
        type="number"
        bind:value={maxCoefficient}
        min={-MAX_COEFFICIENT_MAGNITUDE}
        max={MAX_COEFFICIENT_MAGNITUDE}
        step="0.5"
        class="w-32 bg-black/40 border border-white/10 rounded-md p-2 text-white text-sm"
      />
    </div>
    <p class="text-xs text-gray-400 mt-1">{STEERING_FIELD_HELPERS.coefficientRange}</p>
  </div>

  <div class="mt-6">
    <p class="text-sm font-medium text-gray-200 mb-2">{STEERING_FIELD_LABELS.visibility}</p>
    <div class="flex gap-4 text-sm text-gray-200">
      <label class="inline-flex items-center gap-2">
        <input type="radio" bind:group={visibility} value="private" />
        Private
      </label>
      <label class="inline-flex items-center gap-2">
        <input type="radio" bind:group={visibility} value="public" />
        Public
      </label>
    </div>
    <p class="text-xs text-gray-400 mt-1">
      {visibility === 'private'
        ? STEERING_FIELD_HELPERS.visibilityPrivate
        : STEERING_FIELD_HELPERS.visibilityPublic}
    </p>
  </div>

  {#if issues.length > 0}
    <ul class="mt-6 list-disc list-inside text-xs text-amber-300 space-y-0.5">
      {#each issues as issue}
        <li>{issue.message}</li>
      {/each}
    </ul>
  {/if}

  <div class="mt-8 flex gap-3">
    <button
      type="button"
      onclick={submit}
      disabled={!canSubmit}
      class="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white px-5 py-2.5 rounded-lg font-semibold transition-all"
    >
      {submitting ? 'Saving…' : mode === 'create' ? 'Create vector' : 'Save vector'}
    </button>
    <button
      type="button"
      onclick={() => goto('/steering/vectors')}
      class="text-gray-300 hover:text-white px-5 py-2.5 rounded-lg border border-white/10 transition-all"
    >
      Cancel
    </button>
  </div>
</div>
