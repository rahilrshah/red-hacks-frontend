<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let gameId = $derived($page.params.gameId);
  let gameName = $state('');
  let challenges = $state<any[]>([]);
  let selectedChallengeId = $state('');
  let initialAttackPrompt = $state('');
  let loading = $state(false);
  let statusError = $state('');

  onMount(async () => {
    statusError = '';

    try {
      const { data: gameData, error: gameError } = await supabase
        .from('games')
        .select('name')
        .eq('id', gameId)
        .maybeSingle();

      if (gameError) {
        statusError = gameError.message;
        return;
      }

      gameName = gameData?.name ?? '';

      // Resolve viewer's team for this game so we can hide self-targets.
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) {
        statusError = userError.message;
        return;
      }

      const userId = userData?.user?.id;

      let myTeamId: string | null = null;
      if (userId) {
        const { data: membership, error: membershipError } = await supabase
          .from('team_members')
          .select('team_id, teams!inner(game_id)')
          .eq('user_id', userId)
          .eq('teams.game_id', gameId)
          .limit(1)
          .maybeSingle();

        if (membershipError) {
          statusError = membershipError.message;
          return;
        }

        myTeamId = membership?.team_id ?? null;
      }

      if (!myTeamId) {
        statusError = 'Could not determine your team for this game, so opponent targets cannot be resolved.';
        return;
      }

      const { data: gameChallengeRows, error: gameChallengeError } = await supabase
        .from('game_challenges')
        .select('challenge_id')
        .eq('game_id', gameId);

      if (gameChallengeError) {
        statusError = gameChallengeError.message;
        return;
      }

      const allowedChallengeIds = (gameChallengeRows ?? []).map((row: any) => row.challenge_id);
      if (allowedChallengeIds.length === 0) {
        challenges = [];
        return;
      }

      // Fetch all defended challenges in this game and hide self-targets.
      const { data, error } = await supabase
        .from('defended_challenges')
        .select('id, team_id, is_active, teams!inner(name, game_id, coins), challenges(id, description, type, model_name, attack_steal_coins)')
        .eq('teams.game_id', gameId)
        .in('challenge_id', allowedChallengeIds)
        .gt('teams.coins', 0) // Only show targets that have coins to steal
        .neq('team_id', myTeamId);

      if (error) {
        statusError = error.message;
        return;
      }

      challenges = (data ?? []).sort((a: any, b: any) => Number(b.is_active) - Number(a.is_active));

      if (challenges.length > 0) {
        selectedChallengeId = challenges[0].id;
      }
    } catch (err: any) {
      statusError = err?.message || 'Unexpected error while loading attack targets.';
    }
  });

  async function startAttack() {
    if (!selectedChallengeId || !initialAttackPrompt.trim()) return;

    loading = true;

    try {
      const seed = encodeURIComponent(initialAttackPrompt.trim());
      await goto(`/game/${gameId}/attack/${selectedChallengeId}?seed=${seed}`);
    } catch (err: any) {
      statusError = err?.message || 'Unable to open attack session.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-8">
  <div class="border-b border-white/10 pb-6">
    <h1 class="text-4xl font-black tracking-tight text-white mb-2 flex items-center gap-3">
      <span class="text-red-500">⚡</span> Red Team: Attack Interface
    </h1>
    {#if gameName}
      <p class="text-gray-300 text-sm mb-2">Game: <span class="font-semibold text-white">{gameName}</span></p>
    {/if}
    <p class="text-gray-400 text-lg">Select an opponent's defended challenge to attack. Bypass their system prompt to extract the secret key or trigger the forbidden tool!</p>
  </div>

  {#if statusError}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">{statusError}</div>
  {/if}
  
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="col-span-1 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl overflow-hidden h-[600px] flex flex-col shadow-xl">
      <div class="p-4 border-b border-white/10 bg-black/40 top-0 sticky z-10">
        <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Available Targets</h2>
      </div>
      <div class="divide-y divide-white/5 overflow-y-auto flex-1">
        {#each challenges as target}
          <button 
            class="w-full text-left p-5 hover:bg-slate-800/80 transition-all block group {selectedChallengeId === target.id ? 'bg-red-500/10 border-l-4 border-red-500' : 'border-l-4 border-transparent'}"
            onclick={() => selectedChallengeId = target.id}
          >
            <div class="font-bold text-white mb-1 group-hover:text-red-300 transition-colors">{target.teams?.name}</div>
            <div class="text-xs text-gray-400 mb-3 truncate font-mono">{target.challenges?.model_name} • {target.challenges?.type}</div>
            <div class="text-xs mb-2 {target.is_active ? 'text-emerald-300' : 'text-amber-300'}">{target.is_active ? 'Active Defense' : 'Inactive Defense'}</div>
            <div class="text-xs text-gray-300">Team Coins: {target.teams?.coins ?? 0}</div>
            <div class="text-xs text-gray-500 mt-1">Steal on success: {target.challenges?.attack_steal_coins ?? 0}</div>
          </button>
        {/each}
        {#if challenges.length === 0}
          <div class="p-5 text-sm text-gray-500">
            No opponent defended challenges were found for this game yet.
          </div>
        {/if}
      </div>
    </div>

    <div class="col-span-1 md:col-span-2 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl p-8 flex flex-col shadow-xl relative overflow-hidden">
      <div class="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-red-500/5 rounded-full blur-[80px] pointer-events-none"></div>

      {#if selectedChallengeId}
        {@const selected = challenges.find(c => c.id === selectedChallengeId)}
        <div class="mb-6 pb-6 border-b border-white/10 relative z-10">
          <div class="flex justify-between items-start">
            <div>
              <h2 class="text-2xl font-bold text-white mb-2">Targeting: <span class="text-red-400">{selected.teams?.name}</span></h2>
              <p class="text-sm text-gray-400 leading-relaxed max-w-xl">{selected.challenges?.description}</p>
            </div>
            <span class="px-3 py-1 bg-black/40 border border-white/10 rounded-full text-xs font-mono text-gray-300">
              {selected.challenges?.model_name}
            </span>
          </div>
        </div>

        <div class="flex-1 space-y-6 relative z-10">
          <div class="space-y-3">
            <p class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Initial Attack Prompt</p>
            <textarea 
              bind:value={initialAttackPrompt}
              class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white h-48 focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all placeholder:text-gray-600 font-mono text-sm leading-relaxed" 
              placeholder="> Start with your first attack message..."></textarea>
            <p class="text-xs text-gray-500">After this message, you will move to a dedicated session page with chat history for this team and challenge.</p>
          </div>
        </div>

        <div class="mt-8 pt-6 border-t border-white/10 relative z-10">
          <button 
            onclick={startAttack}
            disabled={loading || !initialAttackPrompt.trim()}
            class="bg-red-600 hover:bg-red-500 text-white px-6 py-4 rounded-xl font-bold disabled:opacity-50 transition-all w-full text-lg tracking-wide shadow-[0_0_15px_rgba(220,38,38,0.3)] hover:shadow-[0_0_25px_rgba(220,38,38,0.5)] active:scale-[0.98] uppercase"
          >
            {loading ? 'PREPARING SESSION...' : 'START ATTACK SESSION'}
          </button>
        </div>
      {:else}
        <div class="flex-1 flex flex-col items-center justify-center text-gray-500 space-y-4">
          <div class="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-2">
            <span class="text-2xl">🎯</span>
          </div>
          <p class="text-lg font-medium">No target selected</p>
          <p class="text-sm">Select an opponent from the list to begin the assault.</p>
        </div>
      {/if}
    </div>
  </div>
</div>
