<script module lang="ts">
  type AttackTargetsCacheEntry = {
    gameName: string;
    roundInfo: any;
    challenges: any[];
    selectedChallengeId: string;
    initialAttackPrompt: string;
    statusError: string;
    timestampMs: number;
  };

  const ATTACK_TARGETS_CACHE_TTL_MS = 60_000;
  const attackTargetsCache = new Map<string, AttackTargetsCacheEntry>();
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import GameSectionNav from '$lib/components/GameSectionNav.svelte';
  import { isGameActive, loadRoundChallengeIds, loadRoundRuntimeContext, resolveRoundType } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let gameId = $derived($page.params.gameId ?? '');
  let gameName = $state('');
  let roundInfo = $state<any>(null);
  let challenges = $state<any[]>([]);
  let selectedChallengeId = $state('');
  let initialAttackPrompt = $state('');
  let loading = $state(false);
  let statusError = $state('');
  let attackMode = $derived(resolveRoundType(roundInfo));
  let loadingTargets = $state(false);

  function cacheKey() {
    return gameId;
  }

  function restoreFromCache() {
    const key = cacheKey();
    if (!key) return false;

    const cached = attackTargetsCache.get(key);
    if (!cached) return false;

    if (Date.now() - cached.timestampMs > ATTACK_TARGETS_CACHE_TTL_MS) {
      attackTargetsCache.delete(key);
      return false;
    }

    gameName = cached.gameName;
    roundInfo = cached.roundInfo;
    challenges = cached.challenges;
    selectedChallengeId = cached.selectedChallengeId;
    initialAttackPrompt = cached.initialAttackPrompt;
    statusError = cached.statusError;
    return true;
  }

  function saveToCache() {
    const key = cacheKey();
    if (!key) return;

    attackTargetsCache.set(key, {
      gameName,
      roundInfo,
      challenges,
      selectedChallengeId,
      initialAttackPrompt,
      statusError,
      timestampMs: Date.now()
    });
  }

  $effect(() => {
    if (!loadingTargets) {
      saveToCache();
    }
  });

  async function loadAttackTargets() {
    if (loadingTargets) return;
    loadingTargets = true;
    statusError = '';

    try {
      const { data: gameData, error: gameError } = await supabase
        .from('games')
        .select('name, is_active, start_time, end_time')
        .eq('id', gameId)
        .maybeSingle();

      if (gameError) {
        statusError = gameError.message;
        return;
      }

      gameName = gameData?.name ?? '';
      if (!gameData || !isGameActive(gameData)) {
        statusError = 'This game is not currently active.';
        return;
      }

      const runtimeContext = await loadRoundRuntimeContext(supabase, gameId);
      roundInfo = runtimeContext.currentRound;

      if (runtimeContext.phase === 'intermission') {
        statusError = 'Round intermission is active. Attacks are paused until the next round starts.';
        return;
      }

      if (runtimeContext.phase !== 'round-active' || !roundInfo) {
        statusError = 'There is no active round to attack right now.';
        return;
      }

      const allowedChallengeIds = await loadRoundChallengeIds(supabase, gameId, roundInfo);

      if (allowedChallengeIds.length === 0) {
        challenges = [];
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) {
        statusError = userError.message;
        return;
      }

      const userId = userData?.user?.id;

      let myTeamId: string | null = null;
      if (userId && resolveRoundType(roundInfo) === 'pvp') {
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

        const requiredDefenses = Math.max(0, Math.trunc(roundInfo?.required_defenses ?? 0));
        if (myTeamId && requiredDefenses > 0) {
          const { count: defendedCount, error: defendedCountError } = await supabase
            .from('defended_challenges')
            .select('id', { count: 'exact', head: true })
            .eq('team_id', myTeamId)
            .eq('is_active', true)
            .in('challenge_id', allowedChallengeIds);

          if (defendedCountError) {
            statusError = defendedCountError.message;
            return;
          }

          if ((defendedCount ?? 0) < requiredDefenses) {
            statusError = `Attack locked: defend at least ${requiredDefenses} prompt(s) this round before attacking (${defendedCount ?? 0}/${requiredDefenses} configured).`;
            return;
          }
        }
      }

      if (resolveRoundType(roundInfo) === 'pvp') {
        if (!myTeamId) {
          statusError = 'Could not determine your team for this game, so opponent targets cannot be resolved.';
          return;
        }

        const { data, error } = await supabase
          .from('defended_challenges')
          .select('id, team_id, is_active, teams!inner(name, game_id, coins), challenges(*)')
          .eq('teams.game_id', gameId)
          .in('challenge_id', allowedChallengeIds)
          .gt('teams.coins', 0)
          .neq('team_id', myTeamId);

        if (error) {
          statusError = error.message;
          return;
        }

        challenges = (data ?? []).sort((a: any, b: any) => Number(b.is_active) - Number(a.is_active));
      } else {
        const { data, error } = await supabase
          .from('challenges')
          .select('id, name, description, type, model_name, attack_steal_coins, default_prompt, *')
          .in('id', allowedChallengeIds);

        if (error) {
          statusError = error.message;
          return;
        }

        challenges = (data ?? []).map((challenge: any) => ({
          id: challenge.id,
          team_id: null,
          is_active: true,
          teams: { name: roundInfo?.name ?? 'Default Defense', game_id: gameId, coins: 0 },
          challenges: challenge
        }));
      }

      if (challenges.length > 0) {
        selectedChallengeId = challenges[0].id;
      }
    } catch (err: any) {
      statusError = err?.message || 'Unexpected error while loading attack targets.';
    } finally {
      saveToCache();
      loadingTargets = false;
    }
  }

  onMount(() => {
    const restored = restoreFromCache();
    if (!restored) {
      void loadAttackTargets();
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
    <div class="mb-4">
      <GameSectionNav gameId={gameId} current="attack" />
    </div>
    <h1 class="text-4xl font-black tracking-tight text-white mb-2 flex items-center gap-3">
      <span class="text-red-500">⚡</span> Red Team: Attack Interface
    </h1>
    {#if gameName}
      <p class="text-gray-300 text-sm mb-2">Game: <span class="font-semibold text-white">{gameName}</span></p>
    {/if}
    {#if roundInfo}
      <p class="text-gray-400 text-sm mb-2">Round: <span class="font-semibold text-white">{roundInfo.name}</span> • Type: <span class="font-semibold text-white uppercase">{roundInfo.type}</span></p>
    {/if}
    <p class="text-gray-400 text-lg">{attackMode === 'pvp' ? "Select an opponent's defended challenge to attack." : 'Select a challenge from this round and attack the default defense.'}</p>
  </div>

  {#if statusError}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">{statusError}</div>
  {/if}
  
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="col-span-1 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl overflow-hidden h-150 flex flex-col shadow-xl">
      <div class="p-4 border-b border-white/10 bg-black/40 top-0 sticky z-10">
        <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Available Targets</h2>
      </div>
      <div class="divide-y divide-white/5 overflow-y-auto flex-1">
        {#each challenges as target}
          <button 
            class="w-full text-left p-5 hover:bg-slate-800/80 transition-all block group {selectedChallengeId === target.id ? 'bg-red-500/10 border-l-4 border-red-500' : 'border-l-4 border-transparent'}"
            onclick={() => selectedChallengeId = target.id}
          >
            <div class="font-bold text-white mb-1 group-hover:text-red-300 transition-colors">{target.teams?.name || 'Default Defense'}</div>
            <div class="text-xs text-gray-400 mb-3 truncate font-mono">{target.challenges?.name || target.challenges?.model_name} • {target.challenges?.type}</div>
            <div class="text-xs mb-2 {target.is_active ? 'text-emerald-300' : 'text-amber-300'}">{target.is_active ? 'Active Defense' : 'Inactive Defense'}</div>
            <div class="text-xs text-gray-300">{attackMode === 'pvp' ? `Team Coins: ${target.teams?.coins ?? 0}` : 'Default prompt target'}</div>
            <div class="text-xs text-gray-500 mt-1">Steal on success: {target.challenges?.attack_steal_coins ?? 0}</div>
          </button>
        {/each}
        {#if challenges.length === 0}
          <div class="p-5 text-sm text-gray-500">
            {attackMode === 'pvp' ? 'No opponent defended challenges were found for this game yet.' : 'No round challenges are available for this game yet.'}
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
              <h2 class="text-2xl font-bold text-white mb-2">Targeting: <span class="text-red-400">{selected.teams?.name || 'Default Defense'}</span></h2>
              <p class="text-sm text-gray-400 leading-relaxed max-w-xl">{selected.challenges?.description}</p>
            </div>
            <span class="px-3 py-1 bg-black/40 border border-white/10 rounded-full text-xs font-mono text-gray-300">
              {selected.challenges?.name || selected.challenges?.model_name}
            </span>
          </div>
          {#if selected.challenges?.challenge_url}
            <p class="mt-3 text-xs text-emerald-300 break-all">Direct backend: {selected.challenges.challenge_url}</p>
          {/if}
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
