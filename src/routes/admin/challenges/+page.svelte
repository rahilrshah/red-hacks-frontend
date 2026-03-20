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
  let target_tool_name = $state('');
  let selectedTools = $state<string[]>([]);
  let interp_arg_id = $state('');
  let loading = $state(false);
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

  async function createChallenge() {
    loading = true;
    errorMsg = '';

    const { data: user } = await supabase.auth.getUser();
    
    const newChallenge = {
      model_name,
      description,
      default_prompt,
      context,
      type,
      target_tool_name: type === 'tool-calling' ? target_tool_name : null,
      interp_arg_id: interp_arg_id || null,
      created_by: user?.user?.id || null
    };

    const { data, error } = await supabase
      .from('challenges')
      .insert([newChallenge])
      .select()
      .single();

    if (error) {
      errorMsg = error.message;
    } else {
      if (selectedTools.length > 0 && data) {
        const challengeTools = selectedTools.map(tool_id => ({
          challenge_id: data.id,
          tool_id
        }));
        await supabase.from('challenge_tools').insert(challengeTools);
      }
      
      model_name = '';
      description = '';
      default_prompt = '';
      context = '';
      type = 'secret-key';
      target_tool_name = '';
      selectedTools = [];
      interp_arg_id = '';
      await fetchChallenges();
    }
    loading = false;
  }
</script>

<div class="p-8 max-w-4xl mx-auto space-y-8">
  <div class="flex items-center justify-between">
    <h1 class="text-3xl font-bold tracking-tight text-white space-y-2">Manage Challenges</h1>
  </div>
  
  {#if errorMsg}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">
      {errorMsg}
    </div>
  {/if}

  <div class="border border-white/10 bg-black/40 p-6 rounded-lg space-y-4">
    <h2 class="text-xl font-semibold text-white">Create New Challenge</h2>
    
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2">
        <label class="text-sm text-gray-400">Model Name</label>
        <input bind:value={model_name} placeholder="e.g. gpt-4o, llama-interp-server" class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
      </div>

      <div class="space-y-2">
        <label class="text-sm text-gray-400">Type</label>
        <select bind:value={type} class="w-full bg-black border border-white/10 rounded-md p-2 text-white">
          <option value="secret-key">Secret Key</option>
          <option value="tool-calling">Tool Calling</option>
        </select>
      </div>

      <div class="space-y-2 col-span-2">
        <label class="text-sm text-gray-400">Description</label>
        <textarea bind:value={description} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white h-20" placeholder="Describe the challenge..."></textarea>
      </div>

      <div class="space-y-2 col-span-2">
        <label class="text-sm text-gray-400">Default Prompt</label>
        <textarea bind:value={default_prompt} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white h-20" placeholder="Default prompt if team provides none..."></textarea>
      </div>

      <div class="space-y-2 col-span-2">
        <label class="text-sm text-gray-400">System Context</label>
        <textarea bind:value={context} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white h-20" placeholder="Model system instructions..."></textarea>
      </div>

      {#if type === 'tool-calling'}
        <div class="space-y-2">
          <label class="text-sm text-gray-400">Target Tool Call Name (Victory Condition)</label>
          <input bind:value={target_tool_name} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
        </div>
        <div class="space-y-2">
          <label class="text-sm text-gray-400">Available Tools</label>
          <!-- Multiple select for tools -->
          <div class="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
            {#each tools as tool}
              <label class="flex items-center space-x-2 text-white text-sm bg-white/5 p-2 rounded border border-white/10">
                <input type="checkbox" bind:group={selectedTools} value={tool.id} />
                <span>{tool.name}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}

      {#if model_name === 'llama-interp-server'}
        <div class="space-y-2 col-span-2">
          <label class="text-sm text-gray-400">Interp Args (Configuration)</label>
          <select bind:value={interp_arg_id} class="w-full bg-black border border-white/10 rounded-md p-2 text-white">
            <option value="">None</option>
            {#each interpArgs as arg}
              <option value={arg.id}>{arg.name}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>

    <button onclick={createChallenge} disabled={loading || !model_name || !description} class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md font-medium disabled:opacity-50 mt-4">
      {loading ? 'Creating...' : 'Create Challenge'}
    </button>
  </div>

  <div class="space-y-4 pt-8">
    <h2 class="text-xl font-semibold text-white">Existing Challenges</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each challenges as challenge}
        <div class="border border-white/10 bg-white/5 p-4 rounded-lg">
          <h3 class="text-lg font-medium text-white">{challenge.model_name}</h3>
          <span class="inline-block px-2 py-1 bg-white/10 text-xs rounded-full text-gray-300 mt-2">{challenge.type}</span>
          <p class="text-sm text-gray-400 mt-2 line-clamp-2">{challenge.description}</p>
        </div>
      {/each}
      {#if challenges.length === 0}
        <p class="text-gray-500 text-sm">No challenges created yet.</p>
      {/if}
    </div>
  </div>
</div>
