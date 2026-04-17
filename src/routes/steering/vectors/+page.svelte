<script lang="ts">
  // Personal library of the current user's steering vectors + public
  // vectors they can pick from at attack time. Each row links to the
  // create/edit form or lets the author deactivate the vector.

  import { supabase } from '$lib/supabaseClient';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { STEERING_LIBRARY_COPY } from '$lib/steering/copy';
  import type { SteeringVector } from '$lib/steering/types';

  type LibraryRow = Pick<
    SteeringVector,
    | 'id'
    | 'name'
    | 'description'
    | 'model_name'
    | 'target_layers'
    | 'pooling'
    | 'position'
    | 'min_coefficient'
    | 'max_coefficient'
    | 'visibility'
    | 'is_active'
    | 'created_by'
    | 'created_at'
    | 'updated_at'
  >;

  let userId = $state('');
  let loading = $state(true);
  let errorMsg = $state('');
  let mine = $state<LibraryRow[]>([]);
  let publicOthers = $state<LibraryRow[]>([]);

  async function loadVectors() {
    loading = true;
    errorMsg = '';
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData?.session;
      if (!session?.user) {
        goto('/');
        return;
      }
      userId = session.user.id;

      const response = await fetch('/api/steering-vectors', {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      const body = await response.json();
      if (!response.ok) {
        errorMsg = body?.error || `Failed to load vectors (${response.status}).`;
        return;
      }

      const rows: LibraryRow[] = Array.isArray(body?.vectors) ? body.vectors : [];
      mine = rows.filter((r) => r.created_by === userId);
      publicOthers = rows.filter((r) => r.created_by !== userId && r.visibility === 'public');
    } catch (err: any) {
      errorMsg = err?.message || 'Failed to load vectors.';
    } finally {
      loading = false;
    }
  }

  async function deactivate(vector: LibraryRow) {
    if (!confirm(`Deactivate "${vector.name}"? Players currently using it will no longer be able to attach it.`)) {
      return;
    }
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) return;

      const response = await fetch(`/api/steering-vectors?id=${encodeURIComponent(vector.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        errorMsg = body?.error || `Failed to deactivate (${response.status}).`;
        return;
      }
      await loadVectors();
    } catch (err: any) {
      errorMsg = err?.message || 'Failed to deactivate.';
    }
  }

  function goToNew() {
    goto('/steering/vectors/new');
  }

  function goToEdit(id: string) {
    goto(`/steering/vectors/${id}/edit`);
  }

  function layerSummary(row: LibraryRow): string {
    const layers = row.target_layers ?? [];
    if (layers.length === 0) return '—';
    if (layers.length <= 4) return layers.join(', ');
    return `${layers.slice(0, 2).join(', ')}…${layers.slice(-1)}`;
  }

  function coefficientRange(row: LibraryRow): string {
    return `[${row.min_coefficient}, ${row.max_coefficient}]`;
  }

  onMount(loadVectors);
</script>

<div class="mx-auto max-w-6xl px-6 py-10">
  <div class="flex items-center justify-between mb-8">
    <div>
      <h1 class="text-3xl font-bold text-white">{STEERING_LIBRARY_COPY.title}</h1>
      <p class="text-sm text-gray-400 mt-1">
        Compose a direction from matched example pairs, then use it to steer an attack against a defender.
      </p>
    </div>
    <button
      onclick={goToNew}
      class="bg-red-600 hover:bg-red-500 text-white px-4 py-2.5 rounded-lg font-semibold shadow-lg hover:shadow-red-500/20 active:scale-[0.98] transition-all"
    >
      + {STEERING_LIBRARY_COPY.newButton}
    </button>
  </div>

  {#if errorMsg}
    <div class="mb-6 rounded-lg border border-red-500/40 bg-red-900/30 px-4 py-3 text-sm text-red-200">
      {errorMsg}
    </div>
  {/if}

  {#if loading}
    <p class="text-gray-400">Loading…</p>
  {:else}
    <section class="mb-10">
      <h2 class="text-lg font-semibold text-gray-200 mb-3">Yours</h2>
      {#if mine.length === 0}
        <p class="text-sm text-gray-400">{STEERING_LIBRARY_COPY.empty}</p>
      {:else}
        <div class="overflow-x-auto rounded-lg border border-white/10">
          <table class="min-w-full text-sm text-left text-gray-200">
            <thead class="bg-white/5 text-xs uppercase text-gray-400">
              <tr>
                <th class="px-4 py-2">Name</th>
                <th class="px-4 py-2">Model</th>
                <th class="px-4 py-2">Layers</th>
                <th class="px-4 py-2">Coef range</th>
                <th class="px-4 py-2">Visibility</th>
                <th class="px-4 py-2">Active</th>
                <th class="px-4 py-2">Created</th>
                <th class="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each mine as row (row.id)}
                <tr class="border-t border-white/5 hover:bg-white/5">
                  <td class="px-4 py-2 font-medium text-white">
                    <div>{row.name}</div>
                    {#if row.description}
                      <div class="text-xs text-gray-400 truncate max-w-xs">{row.description}</div>
                    {/if}
                  </td>
                  <td class="px-4 py-2 font-mono text-xs text-gray-300">{row.model_name}</td>
                  <td class="px-4 py-2">{layerSummary(row)}</td>
                  <td class="px-4 py-2">{coefficientRange(row)}</td>
                  <td class="px-4 py-2">
                    <span
                      class="text-xs font-medium rounded px-2 py-0.5 {row.visibility === 'public'
                        ? 'bg-green-900/40 text-green-200'
                        : 'bg-gray-800 text-gray-300'}"
                    >
                      {row.visibility === 'public' ? STEERING_LIBRARY_COPY.publicLabel : STEERING_LIBRARY_COPY.privateLabel}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-xs">{row.is_active ? '✓' : '—'}</td>
                  <td class="px-4 py-2 text-xs text-gray-400">{new Date(row.created_at).toLocaleDateString()}</td>
                  <td class="px-4 py-2 text-right">
                    <button
                      onclick={() => goToEdit(row.id)}
                      class="text-sm text-red-300 hover:text-red-200 mr-3"
                    >
                      Edit
                    </button>
                    <button
                      onclick={() => deactivate(row)}
                      class="text-sm text-gray-400 hover:text-red-300 disabled:opacity-40"
                      disabled={!row.is_active}
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section>
      <h2 class="text-lg font-semibold text-gray-200 mb-3">Public (from other authors)</h2>
      {#if publicOthers.length === 0}
        <p class="text-sm text-gray-400">No public vectors yet.</p>
      {:else}
        <div class="overflow-x-auto rounded-lg border border-white/10">
          <table class="min-w-full text-sm text-left text-gray-200">
            <thead class="bg-white/5 text-xs uppercase text-gray-400">
              <tr>
                <th class="px-4 py-2">Name</th>
                <th class="px-4 py-2">Model</th>
                <th class="px-4 py-2">Layers</th>
                <th class="px-4 py-2">Coef range</th>
                <th class="px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {#each publicOthers as row (row.id)}
                <tr class="border-t border-white/5">
                  <td class="px-4 py-2 font-medium text-white">
                    <div>{row.name}</div>
                    {#if row.description}
                      <div class="text-xs text-gray-400 truncate max-w-xs">{row.description}</div>
                    {/if}
                  </td>
                  <td class="px-4 py-2 font-mono text-xs text-gray-300">{row.model_name}</td>
                  <td class="px-4 py-2">{layerSummary(row)}</td>
                  <td class="px-4 py-2">{coefficientRange(row)}</td>
                  <td class="px-4 py-2 text-xs">{row.is_active ? '✓' : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>
