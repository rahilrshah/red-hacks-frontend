<script lang="ts">
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onMount, onDestroy } from 'svelte';

  let gameId = $derived($page.params.gameId);
  let game = $state<any>(null);
  let teams = $state<any[]>([]);
  let players = $state<any[]>([]);
  let recentAttacks = $state<any[]>([]);
  let loading = $state(true);

  onMount(async () => {
    await fetchDashboardData();
    
    // Subscribe to realtime updates for attacks
    const channel = supabase.channel('public:attacks')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attacks' }, payload => {
        fetchDashboardData();
      })
      .subscribe();
      
    onDestroy(() => {
      supabase.removeChannel(channel);
    });
  });

  async function fetchDashboardData() {
    // Fetch game details
    const { data: g } = await supabase.from('games').select('*').eq('id', gameId).single();
    if (g) game = g;

    // Fetch teams
    const { data: t } = await supabase.from('teams').select('id, name, points').eq('game_id', gameId).order('points', { ascending: false });
    if (t) teams = t;

    // Fetch players (via team_members)
    // Note: requires a join to get username which is in profiles
    const { data: p } = await supabase
      .from('team_members')
      .select('kills, profiles(username), teams!inner(game_id)')
      .eq('teams.game_id', gameId)
      .order('kills', { ascending: false })
      .limit(10);
    if (p) players = p;

    // Fetch recent activity
    const { data: a } = await supabase
      .from('attacks')
      .select('is_successful, created_at, profiles!attacks_attacker_user_id_fkey(username), defended_challenges!inner(challenge_id, teams!inner(game_id, name))')
      .eq('defended_challenges.teams.game_id', gameId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (a) recentAttacks = a;

    loading = false;
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-8">
  {#if loading}
    <div class="text-white text-center py-12">Loading Dashboard...</div>
  {:else if !game}
    <div class="text-red-500 text-center py-12">Game not found</div>
  {:else}
    <div class="flex items-center justify-between border-b border-white/10 pb-6">
      <div>
        <h1 class="text-4xl font-bold tracking-tight text-white">{game.name}</h1>
        <p class="text-gray-400 mt-2">
          {new Date(game.start_time).toLocaleString()} to {new Date(game.end_time).toLocaleString()}
        </p>
      </div>
      <div class="px-4 py-2 {game.is_active ? 'bg-red-500/20 text-red-500 border-red-500/50' : 'bg-white/10 text-gray-400 border-white/20'} border rounded-full font-bold">
        {game.is_active ? 'LIVE' : 'FINISHED/PAUSED'}
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      
      <!-- Leaderboard -->
      <div class="lg:col-span-2 space-y-6">
        <div class="bg-black/40 border border-white/10 rounded-lg overflow-hidden">
          <div class="p-4 border-b border-white/10 bg-white/5">
            <h2 class="text-xl font-bold text-white">Team Leaderboard</h2>
          </div>
          <div class="divide-y divide-white/5">
            {#each teams as team, i}
              <div class="p-4 flex items-center justify-between hover:bg-white/5 transition">
                <div class="flex items-center space-x-4">
                  <span class="text-2xl font-bold text-gray-500 w-8">#{i + 1}</span>
                  <span class="text-lg font-medium text-white">{team.name}</span>
                </div>
                <div class="text-right">
                  <span class="text-2xl font-bold text-red-500">{team.points}</span>
                  <span class="text-sm text-gray-400 block uppercase tracking-wider">Points</span>
                </div>
              </div>
            {/each}
            {#if teams.length === 0}
              <div class="p-4 text-gray-500">No teams registered.</div>
            {/if}
          </div>
        </div>

        <div class="bg-black/40 border border-white/10 rounded-lg overflow-hidden">
          <div class="p-4 border-b border-white/10 bg-white/5">
            <h2 class="text-xl font-bold text-white">Top Hackers (Most Kills)</h2>
          </div>
          <div class="divide-y divide-white/5">
            {#each players as player, i}
              <div class="p-4 flex items-center justify-between">
                <div class="flex items-center space-x-4">
                  <span class="text-gray-400 w-6">#{i + 1}</span>
                  <span class="text-md text-white">{player.profiles?.username || 'Unknown'}</span>
                </div>
                <div class="font-bold text-white">{player.kills} <span class="text-xs text-gray-500 font-normal">KILLS</span></div>
              </div>
            {/each}
          </div>
        </div>
      </div>

      <!-- Activity Feed -->
      <div class="space-y-6">
        <div class="bg-black/40 border border-white/10 rounded-lg overflow-hidden h-full">
          <div class="p-4 border-b border-white/10 bg-white/5">
            <h2 class="text-xl font-bold text-white">Recent Attacks</h2>
          </div>
          <div class="p-4 space-y-4">
            {#each recentAttacks as attack}
              <div class="border-l-2 pl-3 pb-2 {attack.is_successful ? 'border-red-500' : 'border-gray-500'}">
                <p class="text-sm text-white">
                  <span class="font-bold">{attack.profiles?.username || 'Someone'}</span> 
                  attacked 
                  <span class="font-bold">{attack.defended_challenges?.teams?.name || 'Unknown Team'}</span>
                </p>
                <div class="mt-1 flex items-center space-x-2">
                  {#if attack.is_successful}
                    <span class="text-xs px-2 py-0.5 bg-red-500/20 text-red-500 rounded font-bold">SUCCESS</span>
                  {:else}
                    <span class="text-xs px-2 py-0.5 bg-white/10 text-gray-400 rounded">FAILED</span>
                  {/if}
                  <span class="text-xs text-gray-500">{new Date(attack.created_at).toLocaleTimeString()}</span>
                </div>
              </div>
            {/each}
            {#if recentAttacks.length === 0}
              <p class="text-gray-500 text-sm">No activity yet.</p>
            {/if}
          </div>
        </div>
      </div>

    </div>
  {/if}
</div>
