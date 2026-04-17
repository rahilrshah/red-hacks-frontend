<script lang="ts">
  // /steering/vectors/[id]/edit — loads the target row + hydrates the
  // shared editor with its existing values. Uses the public REST surface
  // so RLS enforces that the caller can only read rows they own or that
  // are public.

  import VectorEditor from '$lib/steering/VectorEditor.svelte';
  import { page } from '$app/state';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { SteeringVector } from '$lib/steering/types';

  let loading = $state(true);
  let errorMsg = $state('');
  let vector = $state<Partial<SteeringVector> | null>(null);

  async function load() {
    const id = page.params.id;
    if (!id) {
      errorMsg = 'Missing id.';
      loading = false;
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session?.user) {
      goto('/');
      return;
    }

    try {
      const response = await fetch(`/api/steering-vectors`, {
        headers: { Authorization: `Bearer ${sessionData.session.access_token}` }
      });
      const body = await response.json();
      if (!response.ok) {
        errorMsg = body?.error || `Failed to load (${response.status}).`;
        return;
      }
      const all: SteeringVector[] = Array.isArray(body?.vectors) ? body.vectors : [];
      const match = all.find((v) => v.id === id) ?? null;
      if (!match) {
        errorMsg = 'Vector not found, or you are not permitted to edit it.';
        return;
      }
      vector = match;
    } catch (err: any) {
      errorMsg = err?.message || 'Failed to load vector.';
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

{#if loading}
  <div class="mx-auto max-w-4xl px-6 py-10">
    <p class="text-gray-400">Loading…</p>
  </div>
{:else if errorMsg}
  <div class="mx-auto max-w-4xl px-6 py-10">
    <div class="rounded-lg border border-red-500/40 bg-red-900/30 px-4 py-3 text-sm text-red-200">
      {errorMsg}
    </div>
  </div>
{:else}
  <VectorEditor mode="edit" initialVector={vector} />
{/if}
