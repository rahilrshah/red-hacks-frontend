<script lang="ts">
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let games = $state<any[]>([]);
  let name = $state('');
  let start_time = $state('');
  let end_time = $state('');
  let challenges_per_team = $state(5);
  let lives_per_challenge = $state(3);
  let loading = $state(false);
  let errorMsg = $state('');

  onMount(async () => {
    await fetchGames();
  });

  async function fetchGames() {
    const { data, error } = await supabase.from('games').select('*').order('created_at', { ascending: false });
    if (data) games = data;
    if (error) console.error(error);
  }

  async function createGame() {
    loading = true;
    errorMsg = '';
    
    const { data: user } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from('games')
      .insert([{
        name,
        start_time,
        end_time,
        challenges_per_team,
        lives_per_challenge,
        is_active: false,
        created_by: user?.user?.id || null
      }])
      .select()
      .single();

    if (error) {
      errorMsg = error.message;
    } else {
      name = '';
      start_time = '';
      end_time = '';
      challenges_per_team = 5;
      lives_per_challenge = 3;
      await fetchGames();
    }
    
    loading = false;
  }
</script>

<div class="p-8 max-w-4xl mx-auto space-y-8">
  <div class="flex items-center justify-between">
    <h1 class="text-3xl font-bold tracking-tight text-white space-y-2">Manage Games</h1>
  </div>
  
  {#if errorMsg}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">
      {errorMsg}
    </div>
  {/if}

  <div class="border border-white/10 bg-black/40 p-6 rounded-lg space-y-4">
    <h2 class="text-xl font-semibold text-white">Create New Game</h2>
    
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2">
        <label class="text-sm text-gray-400">Game Name</label>
        <input bind:value={name} placeholder="RedHacks 2026 Season 1" class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
      </div>

      <div class="space-y-4 col-span-2 grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <label class="text-sm text-gray-400">Start Time</label>
          <input type="datetime-local" bind:value={start_time} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
        </div>
        <div class="space-y-2">
          <label class="text-sm text-gray-400">End Time</label>
          <input type="datetime-local" bind:value={end_time} class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
        </div>
      </div>

      <div class="space-y-4 col-span-2 grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <label class="text-sm text-gray-400">Challenges Per Team</label>
          <input type="number" bind:value={challenges_per_team} min="1" max="20" class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
        </div>
        <div class="space-y-2">
          <label class="text-sm text-gray-400">Lives Per Challenge</label>
          <input type="number" bind:value={lives_per_challenge} min="1" max="10" class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-white" />
        </div>
      </div>
    </div>

    <button onclick={createGame} disabled={loading || !name || !start_time || !end_time} class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md font-medium disabled:opacity-50 mt-4">
      {loading ? 'Creating...' : 'Create Game'}
    </button>
  </div>

  <div class="space-y-4 pt-8">
    <h2 class="text-xl font-semibold text-white">Existing Games</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each games as game}
        <div class="border border-white/10 {game.is_active ? 'bg-red-500/10 border-red-500/30' : 'bg-white/5'} p-4 rounded-lg flex flex-col justify-between">
          <div>
            <h3 class="text-lg font-medium text-white">{game.name}</h3>
            <span class="inline-block px-2 py-1 bg-white/10 text-xs rounded-full text-gray-300 mt-2 whitespace-nowrap">
              {new Date(game.start_time).toLocaleDateString()} - {new Date(game.end_time).toLocaleDateString()}
            </span>
            <p class="text-xs text-gray-400 mt-2">
              {game.challenges_per_team} Challenges / {game.lives_per_challenge} Lives
            </p>
          </div>
          <div class="mt-4">
            <a href="/dashboard/{game.id}" class="text-red-400 hover:text-red-300 text-sm font-medium">View Dashboard &rarr;</a>
          </div>
        </div>
      {/each}
      {#if games.length === 0}
        <p class="text-gray-500 text-sm">No games created yet.</p>
      {/if}
    </div>
  </div>
</div>
