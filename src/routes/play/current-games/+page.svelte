<script lang="ts">
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let myTeams = $state<any[]>([]);
  let userId = $state('');

  onMount(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) await supabase.auth.signInAnonymously();

    const { data: currentUser } = await supabase.auth.getUser();
    if (!currentUser?.user) return;

    userId = currentUser.user.id;
    await fetchUserData();
  });

  async function fetchUserData() {
    const { data: memberData } = await supabase
      .from('team_members')
      .select('role, teams(*, games(id, name, is_active))')
      .eq('user_id', userId);

    if (memberData) {
      myTeams = (memberData as any[])
        .map((m: any) => {
          const game = Array.isArray(m.teams?.games) ? m.teams.games[0] : m.teams?.games;
          return {
            ...m.teams,
            role: m.role,
            game
          };
        })
        .filter((t: any) => t.game);
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-12">
  <div class="border-b border-white/10 pb-6">
    <h1 class="text-4xl font-black tracking-tight text-white flex items-center gap-3">
      <span class="text-red-500">🎮</span> Current Games
    </h1>
    <p class="text-gray-400 mt-2 text-lg">Jump back into any game where your team is active.</p>
  </div>

  <div class="space-y-6">
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each myTeams as team}
        <div class="border border-white/10 bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl shadow-lg relative group overflow-hidden">
          {#if team.role === 'leader'}
            <div class="absolute top-0 right-0 bg-red-500/20 text-red-400 text-[10px] font-bold px-3 py-1 rounded-bl-lg uppercase tracking-wider">Leader</div>
          {:else}
            <div class="absolute top-0 right-0 bg-blue-500/20 text-blue-400 text-[10px] font-bold px-3 py-1 rounded-bl-lg uppercase tracking-wider">Member</div>
          {/if}
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-xl font-bold text-white group-hover:text-red-400 transition-colors">{team.game?.name || 'Unknown'}</h3>
          </div>
          <div class="space-y-2 mb-6">
            <div class="flex justify-between items-center text-sm">
              <span class="text-gray-400">Team:</span>
              <span class="text-white font-medium">{team.name}</span>
            </div>
          </div>
          <a href={`/game/${team.game.id}`} class="block w-full bg-white/5 hover:bg-red-500/20 border border-white/10 hover:border-red-500/50 text-white text-center py-3 rounded-lg font-semibold transition-all hover:shadow-[0_0_15px_rgba(220,38,38,0.2)]">
            Play Game
          </a>
        </div>
      {/each}
      {#if myTeams.length === 0}
        <div class="col-span-full border border-dashed border-white/20 bg-white/5 p-8 rounded-2xl text-center">
          <p class="text-gray-400">You are not part of any games yet.</p>
        </div>
      {/if}
    </div>
  </div>
</div>
