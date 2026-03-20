<script lang="ts">
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let tools = $state<any[]>([]);
  let name = $state('');
  let description = $state('');
  let spec = $state('');
  let loading = $state(false);
  let errorMsg = $state('');

  onMount(async () => {
    await fetchTools();
  });

  async function fetchTools() {
    const { data, error } = await supabase.from('tools').select('*');
    if (data) tools = data;
    if (error) console.error(error);
  }

  async function createTool() {
    loading = true;
    errorMsg = '';
    
    let parsedSpec;
    try {
      parsedSpec = JSON.parse(spec);
    } catch(e) {
      errorMsg = 'Invalid JSON in OpenRouter Tool Specification';
      loading = false;
      return;
    }

    const { data: user } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from('tools')
      .insert([{
        name,
        description,
        spec: parsedSpec,
        created_by: user?.user?.id || null
      }])
      .select()
      .single();

    if (error) {
      errorMsg = error.message;
    } else {
      name = '';
      description = '';
      spec = '';
      await fetchTools();
    }
    
    loading = false;
  }
</script>

<div class="p-8 max-w-4xl mx-auto space-y-8">
  <div class="flex items-center justify-between">
    <h1 class="text-3xl font-bold tracking-tight text-white space-y-2">Manage Tools</h1>
  </div>
  
  {#if errorMsg}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">
      {errorMsg}
    </div>
  {/if}

  <div class="border border-white/10 bg-black/40 p-6 rounded-lg space-y-4">
    <h2 class="text-xl font-semibold text-white">Create New Tool</h2>
    
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2">
        <label class="text-sm text-gray-400">Tool Name</label>
        <input bind:value={name} placeholder="e.g. weather_api" class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
      </div>

      <div class="space-y-2 col-span-2">
        <label class="text-sm text-gray-400">Description</label>
        <textarea bind:value={description} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white h-20" placeholder="Describe the tool..."></textarea>
      </div>

      <div class="space-y-2 col-span-2">
        <label class="text-sm text-gray-400">OpenRouter Tool Specification (JSON)</label>
        <textarea bind:value={spec} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white font-mono h-48" placeholder={'{ "type": "function", "function": { "name": "get_weather", "description": "Get current weather" } }'}></textarea>
      </div>
    </div>

    <button onclick={createTool} disabled={loading || !name || !spec} class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md font-medium disabled:opacity-50 mt-4">
      {loading ? 'Creating...' : 'Create Tool'}
    </button>
  </div>

  <div class="space-y-4 pt-8">
    <h2 class="text-xl font-semibold text-white">Existing Tools</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each tools as tool}
        <div class="border border-white/10 bg-white/5 p-4 rounded-lg">
          <h3 class="text-lg font-medium text-white">{tool.name}</h3>
          <p class="text-sm text-gray-400 mt-2 line-clamp-2">{tool.description}</p>
        </div>
      {/each}
      {#if tools.length === 0}
        <p class="text-gray-500 text-sm">No tools created yet.</p>
      {/if}
    </div>
  </div>
</div>
