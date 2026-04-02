<script lang="ts">
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  // UI state
  let challenges = $state<any[]>([]);
  let tools = $state<any[]>([]);
  let interpArgs = $state<any[]>([]);

  // Form state
  let model_name = $state('');
  let description = $state('');
  let default_prompt = $state('');
  let context = $state('');
  let type = $state('secret-key');
  let challenge_url = $state('');
  let target_tool_name = $state('');
  let defense_reward_coins = $state(0);
  let attack_steal_coins = $state(0);
  let selectedTools = $state<string[]>([]);
  let interp_arg_id = $state('');
  let loading = $state(false);
  let editingChallengeId = $state<string | null>(null);
  let errorMsg = $state('');

  onMount(async () => {
    await fetchChallenges();
    await fetchTools();
    await fetchInterpArgs();
  });

  async function fetchChallenges() {
    const { data, error } = await supabase.from('challenges').select('*');
    if (data) challenges = data;
    if (error) console.error(error);
  }

  async function fetchTools() {
    const { data, error } = await supabase.from('tools').select('*');
    if (data) tools = data;
  }

  async function fetchInterpArgs() {
    const { data, error } = await supabase.from('interp_args').select('*');
    if (data) interpArgs = data;
  }

  function resetForm() {
    model_name = '';
    description = '';
    default_prompt = '';
    context = '';
    type = 'secret-key';
    challenge_url = '';
    target_tool_name = '';
    defense_reward_coins = 0;
    attack_steal_coins = 0;
    selectedTools = [];
    interp_arg_id = '';
    editingChallengeId = null;
  }

  async function upsertChallengeTools(challengeId: string) {
    const { error: deleteToolsError } = await supabase
      .from('challenge_tools')
      .delete()
      .eq('challenge_id', challengeId);

    if (deleteToolsError) {
      throw deleteToolsError;
    }

    if (type !== 'tool-calling' || selectedTools.length === 0) {
      return;
    }

    const challengeTools = selectedTools.map((tool_id) => ({
      challenge_id: challengeId,
      tool_id
    }));

    const { error: insertToolsError } = await supabase
      .from('challenge_tools')
      .insert(challengeTools);

    if (insertToolsError) {
      throw insertToolsError;
    }
  }

  async function submitChallengeForm() {
    loading = true;
    errorMsg = '';

    try {
      if (editingChallengeId) {
        const { error } = await supabase
          .from('challenges')
          .update({
            model_name,
            description,
            default_prompt,
            context,
            type,
            challenge_url: challenge_url.trim() || null,
            target_tool_name: type === 'tool-calling' ? target_tool_name || null : null,
            defense_reward_coins,
            attack_steal_coins,
            interp_arg_id: model_name === 'llama-interp-server' ? (interp_arg_id || null) : null
          })
          .eq('id', editingChallengeId);

        if (error) {
          throw error;
        }

        await upsertChallengeTools(editingChallengeId);
      } else {
        const { data: user } = await supabase.auth.getUser();
        const newChallenge = {
          model_name,
          description,
          default_prompt,
          context,
          type,
          challenge_url: challenge_url.trim() || null,
          target_tool_name: type === 'tool-calling' ? target_tool_name : null,
          defense_reward_coins,
          attack_steal_coins,
          interp_arg_id: interp_arg_id || null,
          created_by: user?.user?.id || null
        };

        const { data, error } = await supabase
          .from('challenges')
          .insert([newChallenge])
          .select()
          .single();

        if (error) {
          throw error;
        }

        await upsertChallengeTools(data.id);
      }

      resetForm();
      await fetchChallenges();
    } catch (error: any) {
      errorMsg = error.message;
    } finally {
      loading = false;
    }
  }

  async function startEdit(challenge: any) {
    editingChallengeId = challenge.id;
    errorMsg = '';

    model_name = challenge.model_name ?? '';
    description = challenge.description ?? '';
    default_prompt = challenge.default_prompt ?? '';
    context = challenge.context ?? '';
    type = challenge.type ?? 'secret-key';
    challenge_url = challenge.challenge_url ?? '';
    target_tool_name = challenge.target_tool_name ?? '';
    defense_reward_coins = challenge.defense_reward_coins ?? 0;
    attack_steal_coins = challenge.attack_steal_coins ?? 0;
    interp_arg_id = challenge.interp_arg_id ?? '';

    const { data, error } = await supabase
      .from('challenge_tools')
      .select('tool_id')
      .eq('challenge_id', challenge.id);

    if (error) {
      errorMsg = error.message;
      selectedTools = [];
      return;
    }

    selectedTools = (data ?? []).map((row: any) => row.tool_id);
  }

  function cancelEdit() {
    resetForm();
    errorMsg = '';
  }
</script>

<div class="p-8 max-w-5xl mx-auto space-y-8">
  <div class="flex items-center justify-between border-b border-white/10 pb-6">
    <div class="space-y-1">
      <h1 class="text-3xl font-bold tracking-tight text-white">Manage Challenges</h1>
      <p class="text-gray-400">Create and configure LLM targets for the competition.</p>
    </div>
  </div>
  
  {#if errorMsg}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">
      {errorMsg}
    </div>
  {/if}

  <div class="border border-white/10 bg-slate-900/50 backdrop-blur-sm p-6 rounded-xl space-y-4 shadow-xl">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-xl font-semibold text-white">{editingChallengeId ? 'Edit Challenge' : 'Create New Challenge'}</h2>
      {#if editingChallengeId}
        <span class="text-xs font-mono bg-red-500/10 border border-red-500/30 text-red-300 px-2.5 py-1 rounded-md">
          ID: {editingChallengeId}
        </span>
      {/if}
    </div>
    
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2">
        <p class="text-sm font-medium text-gray-300">Model Name</p>
        <input bind:value={model_name} placeholder="e.g. gpt-4o, llama-interp-server" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
      </div>

      <div class="space-y-2">
        <p class="text-sm font-medium text-gray-300">Type</p>
        <select bind:value={type} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all">
          <option value="secret-key">Secret Key</option>
          <option value="tool-calling">Tool Calling</option>
        </select>
      </div>

      <div class="space-y-2 col-span-2">
        <p class="text-sm font-medium text-gray-300">Description</p>
        <textarea bind:value={description} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white h-20 focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" placeholder="Describe the challenge..."></textarea>
      </div>

      <div class="space-y-2 col-span-2">
        <p class="text-sm font-medium text-gray-300">Default Prompt</p>
        <textarea bind:value={default_prompt} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white h-20 focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" placeholder="Default prompt if team provides none..."></textarea>
      </div>

      <div class="space-y-2 col-span-2">
        <p class="text-sm font-medium text-gray-300">Challenge Backend URL</p>
        <input bind:value={challenge_url} placeholder="Optional direct attack backend URL" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
        <p class="text-xs text-gray-500">If set, attacks will bypass the Supabase edge function and call this URL directly with the same payload.</p>
      </div>

      <div class="space-y-2 col-span-2">
        <p class="text-sm font-medium text-gray-300">System Context</p>
        <textarea bind:value={context} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white h-32 font-mono text-sm focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" placeholder="Model system instructions..."></textarea>
      </div>

      <div class="space-y-2">
        <p class="text-sm font-medium text-gray-300">Defense Reward Coins (x)</p>
        <input bind:value={defense_reward_coins} type="number" min="0" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
      </div>

      <div class="space-y-2">
        <p class="text-sm font-medium text-gray-300">Attack Steal Coins (y)</p>
        <input bind:value={attack_steal_coins} type="number" min="0" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
      </div>

      {#if type === 'tool-calling'}
        <div class="space-y-2">
          <p class="text-sm font-medium text-gray-300">Target Tool Call Name (Victory Condition)</p>
          <input bind:value={target_tool_name} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
        </div>
        <div class="space-y-2 col-span-2">
          <p class="text-sm font-medium text-gray-300">Available Tools</p>
          <!-- Multiple select for tools -->
          <div class="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-40 overflow-y-auto pr-2">
            {#each tools as tool}
              <label class="flex items-center space-x-3 text-white text-sm bg-black/40 p-3 rounded-lg border border-white/10 hover:border-red-500/50 hover:bg-slate-800/50 transition-all cursor-pointer">
                <input type="checkbox" bind:group={selectedTools} value={tool.id} class="accent-red-500 w-4 h-4 rounded border-white/20 bg-black/40" />
                <span class="font-medium">{tool.name}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}

      {#if model_name === 'llama-interp-server'}
        <div class="space-y-2 col-span-2">
          <p class="text-sm font-medium text-gray-300">Interp Args (Configuration)</p>
          <select bind:value={interp_arg_id} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all">
            <option value="">None</option>
            {#each interpArgs as arg}
              <option value={arg.id}>{arg.name}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>

    <div class="mt-6 flex gap-3">
      <button onclick={submitChallengeForm} disabled={loading || !model_name || !description} class="flex-1 bg-red-600 hover:bg-red-500 text-white px-4 py-3 rounded-lg font-bold disabled:opacity-50 transition-all shadow-lg hover:shadow-red-500/20 active:scale-[0.98]">
        {#if loading}
          {editingChallengeId ? 'Saving...' : 'Creating...'}
        {:else}
          {editingChallengeId ? 'Save Challenge' : 'Create Challenge'}
        {/if}
      </button>
      {#if editingChallengeId}
        <button onclick={cancelEdit} class="border border-white/20 hover:border-white/40 text-white px-4 py-3 rounded-lg font-semibold transition-colors">
          Cancel Edit
        </button>
      {/if}
    </div>
  </div>

  <div class="space-y-4 pt-8">
    <h2 class="text-xl font-semibold text-white">Existing Challenges</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each challenges as challenge}
        <div class="border border-white/10 bg-slate-900/40 backdrop-blur-sm p-5 rounded-xl hover:border-red-500/30 transition-colors shadow-lg">
          <h3 class="font-bold text-lg text-white">{challenge.model_name}</h3>
          <span class="inline-block px-2.5 py-1 bg-red-500/10 border border-red-500/20 text-xs rounded-full text-red-400 mt-2 font-medium">{challenge.type}</span>
          {#if challenge.challenge_url}
            <p class="mt-2 text-xs text-gray-400 break-all">Backend URL: {challenge.challenge_url}</p>
          {/if}
          <div class="mt-3 text-xs text-gray-300 bg-black/30 rounded p-2 space-y-1">
            <p>Defense Reward: {challenge.defense_reward_coins ?? 0} coins</p>
            <p>Attack Steal: {challenge.attack_steal_coins ?? 0} coins</p>
          </div>
          <p class="text-sm text-gray-400 mt-3 line-clamp-2 leading-relaxed">{challenge.description}</p>

          <div class="mt-4 flex gap-2">
            {#if editingChallengeId === challenge.id}
              <button onclick={cancelEdit} class="flex-1 border border-white/20 hover:border-white/40 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                Stop Editing
              </button>
              <button onclick={submitChallengeForm} disabled={loading || !model_name || !description} class="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white px-3 py-2 rounded-md text-sm font-semibold transition-colors">
                {loading ? 'Saving...' : 'Save In Form'}
              </button>
            {:else}
              <button onclick={() => startEdit(challenge)} class="w-full border border-white/20 hover:border-red-500/40 hover:bg-red-500/10 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">
                Edit In Form
              </button>
            {/if}
          </div>
        </div>
      {/each}
      {#if challenges.length === 0}
        <p class="text-gray-500 text-sm col-span-full">No challenges created yet. Create one above to get started.</p>
      {/if}
    </div>
  </div>
</div>
