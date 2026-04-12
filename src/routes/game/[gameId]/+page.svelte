<script lang="ts">
  import { page } from '$app/stores';
  import {
    getRoundRuntimeContext,
    isGameJoinable,
    loadRoundChallengeIds,
    resolveRoundType,
    type GameRound
  } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onDestroy, onMount } from 'svelte';

  let gameId = $derived($page.params.gameId ?? '');
  let game = $state<any>(null);
  let cachedRounds = $state<GameRound[]>([]);
  let roundInfo = $state<any>(null);
  let roundPhase = $state('no-rounds');
  let phaseTimeRemaining = $state<number | null>(null);
  let allowedChallengeCount = $state(0);
  let defendedChallengeCount = $state(0);
  let attackTargetCount = $state(0);
  let gameplaySummaryLoading = $state(false);
  let myTeam = $state<any>(null);

  let newTeamName = $state('');
  let inviteCode = $state('');

  let loading = $state(false);
  let pageLoading = $state(true);
  let actionMessage = $state('');
  let actionError = $state(false);
  let userId = $state('');

  function normalizeInviteCode(rawValue: string) {
    return rawValue.toUpperCase().trim().replace(/^TEAM:/, '').trim();
  }

  function phaseLabel(phase: string) {
    if (phase === 'pre-game') return 'Pre-Game';
    if (phase === 'round-active') return 'Round Active';
    if (phase === 'intermission') return 'Intermission';
    if (phase === 'post-game') return 'Game Over';
    return 'No Rounds Configured';
  }

  function formatRemaining(seconds: number | null) {
    if (seconds === null) return null;
    const total = Math.max(0, Math.trunc(seconds));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
  }

  onMount(async () => {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      await supabase.auth.signInAnonymously();
    }

    const { data: currentUser } = await supabase.auth.getUser();
    if (!currentUser?.user) {
      actionMessage = 'Could not load your account.';
      actionError = true;
      pageLoading = false;
      return;
    }

    userId = currentUser.user.id;
    await supabase.from('profiles').upsert({ id: userId, username: 'Player_' + userId.substring(0, 5) }, { onConflict: 'id' }).select();

    await refreshGameAndRounds();

    if (!game) {
      actionMessage = 'Game not found.';
      actionError = true;
      pageLoading = false;
      return;
    }

    tickRoundContext();

    await fetchUserData();
    pageLoading = false;
  });

  async function refreshGameAndRounds() {
    const { data: gameRow } = await supabase
      .from('games')
      .select('id, name, invite_code, is_active, start_time, end_time')
      .eq('id', gameId)
      .maybeSingle();
    if (gameRow) game = gameRow;

    const { data: roundsData } = await supabase
      .from('rounds')
      .select('game_id, round_index, name, type, required_defenses, available_challenges, duration_minutes, intermission_minutes, is_enabled')
      .eq('game_id', gameId)
      .order('round_index', { ascending: true });
    cachedRounds = (roundsData ?? []) as GameRound[];
  }

  function tickRoundContext() {
    if (!game) return;
    const ctx = getRoundRuntimeContext(
      {
        is_active: Boolean(game.is_active),
        start_time: game.start_time,
        end_time: game.end_time
      },
      cachedRounds
    );
    roundInfo = ctx.currentRound;
    roundPhase = ctx.phase;
    phaseTimeRemaining = ctx.timeRemainingSeconds;
  }

  // Live countdown: recompute the round phase/time every second using the
  // cached game window + rounds. Pure, no DB hit. Re-runs if `game` or
  // `cachedRounds` change, and the cleanup clears the previous interval.
  $effect(() => {
    if (!game) return;
    void cachedRounds;
    const handle = setInterval(tickRoundContext, 1000);
    return () => clearInterval(handle);
  });

  // ---------- Realtime: re-fetch when admin changes game or rounds ----------

  const realtimeChannel = supabase.channel(`game-hub:${gameId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      () => { void refreshGameAndRounds(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `game_id=eq.${gameId}` },
      () => { void refreshGameAndRounds(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },
      () => { if (myTeam?.id) void fetchUserData(); })
    .subscribe();

  onDestroy(() => { supabase.removeChannel(realtimeChannel); });

  async function fetchUserData() {
    const { data: memberData } = await supabase
      .from('team_members')
      .select('role, teams!inner(*, games(id, name, is_active, start_time, end_time))')
      .eq('user_id', userId)
      .eq('teams.game_id', gameId)
      .limit(1);

    if (memberData && memberData.length > 0) {
      const row = memberData[0] as any;
      const team = Array.isArray(row.teams) ? row.teams[0] : row.teams;
      const teamGame = Array.isArray(team?.games) ? team.games[0] : team?.games;
      myTeam = team
        ? {
            ...team,
            role: row.role,
            game: teamGame
          }
        : null;

      if (myTeam?.id) {
        await loadGameplaySummary(myTeam.id);
      }
    } else {
      myTeam = null;
      allowedChallengeCount = 0;
      defendedChallengeCount = 0;
      attackTargetCount = 0;
    }
  }

  async function loadGameplaySummary(teamId: string) {
    gameplaySummaryLoading = true;

    try {
      const allowedChallengeIds = await loadRoundChallengeIds(supabase, gameId, roundInfo);
      allowedChallengeCount = allowedChallengeIds.length;

      const { count: defendedCount } = await supabase
        .from('defended_challenges')
        .select('id', { count: 'exact', head: true })
        .eq('team_id', teamId)
        .in('challenge_id', allowedChallengeIds.length > 0 ? allowedChallengeIds : ['00000000-0000-0000-0000-000000000000']);

      defendedChallengeCount = defendedCount ?? 0;

      if (resolveRoundType(roundInfo) === 'pvp') {
        const { count: targetsCount } = await supabase
          .from('defended_challenges')
          .select('id, teams!inner(game_id, coins)', { count: 'exact', head: true })
          .eq('teams.game_id', gameId)
          .neq('team_id', teamId)
          .gt('teams.coins', 0)
          .in('challenge_id', allowedChallengeIds.length > 0 ? allowedChallengeIds : ['00000000-0000-0000-0000-000000000000']);

        attackTargetCount = targetsCount ?? 0;
      } else {
        attackTargetCount = allowedChallengeIds.length;
      }
    } finally {
      gameplaySummaryLoading = false;
    }
  }

  function recommendedAction() {
    if (roundPhase === 'intermission') {
      return 'Intermission is active. Review team setup and get ready for the next round.';
    }

    if (roundPhase !== 'round-active') {
      return 'Wait for an active round to begin before attacking or updating defenses.';
    }

    if (defendedChallengeCount === 0) {
      return 'Set up at least one defense first so your team is protected this round.';
    }

    if (attackTargetCount === 0) {
      return 'No attack targets are currently available. Keep defenses fresh and watch for new targets.';
    }

    return 'Your team is ready. Defend weak spots and launch attacks while this round is active.';
  }

  async function createTeam() {
    if (!newTeamName) return;
    if (!game || !isGameJoinable(game)) {
      actionMessage = 'This game is paused or already finished.';
      actionError = true;
      return;
    }

    if (myTeam) {
      actionMessage = `You are already on ${myTeam.name} for this game.`;
      actionError = true;
      return;
    }

    loading = true;
    actionError = false;

    const newInviteCode = Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0').toUpperCase();

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .insert([
        {
          game_id: gameId,
          name: newTeamName,
          invite_code: newInviteCode
        }
      ])
      .select()
      .single();

    if (teamError || !team) {
      actionMessage = teamError?.message || 'Failed to create team.';
      actionError = true;
      loading = false;
      return;
    }

    const { error: leaderInsertError } = await supabase.from('team_members').insert([
      {
        team_id: team.id,
        user_id: userId,
        role: 'leader'
      }
    ]);

    if (leaderInsertError) {
      await supabase.from('teams').delete().eq('id', team.id);
      actionMessage = leaderInsertError.code === '23505' ? 'You are already on a team for this game.' : leaderInsertError.message;
      actionError = true;
      loading = false;
      return;
    }

    actionMessage = `Team created! TEAM:${newInviteCode}`;
    actionError = false;
    newTeamName = '';
    await fetchUserData();
    loading = false;
  }

  async function joinTeam() {
    if (!inviteCode) return;

    loading = true;
    actionError = false;

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('invite_code', normalizeInviteCode(inviteCode))
      .eq('game_id', gameId)
      .single();

    if (teamError || !team) {
      actionMessage = 'Invalid invite code for this game.';
      actionError = true;
      loading = false;
      return;
    }

    if (myTeam) {
      actionMessage = `You are already on ${myTeam.name} for this game.`;
      actionError = true;
      loading = false;
      return;
    }

    const { error: memberError } = await supabase.from('team_members').insert({
      team_id: team.id,
      user_id: userId,
      role: 'member'
    });

    if (memberError) {
      actionMessage = memberError.code === '23505' ? 'You are already on a team for this game.' : memberError.message;
      actionError = true;
    } else {
      actionMessage = `Successfully joined ${team.name}!`;
      actionError = false;
      inviteCode = '';
      await fetchUserData();
    }

    loading = false;
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-10">
  {#if pageLoading}
    <div class="text-gray-400">Loading game...</div>
  {:else}
    <div class="border-b border-white/10 pb-6">
      <h1 class="text-4xl font-black tracking-tight text-white flex items-center gap-3">
        <span class="text-red-500">🎮</span> {game?.name || 'Game'}
      </h1>
      <p class="text-gray-400 mt-2 text-lg">Everything for your run is scoped to this game.</p>
      {#if game?.invite_code}
        <p class="text-gray-300 mt-3">Game Invite Code: <span class="font-mono text-red-400 tracking-wider font-bold">{game.invite_code}</span></p>
      {/if}
      {#if roundInfo}
        <div class="mt-4 inline-flex flex-wrap items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300">
          <span class="font-semibold text-white">Current Round:</span>
          <span>{roundInfo.name}</span>
          <span class="text-gray-500">•</span>
          <span class="uppercase tracking-wider text-red-300">{resolveRoundType(roundInfo)}</span>
          {#if resolveRoundType(roundInfo) === 'pve'}
            <span class="text-gray-500">•</span>
            <span>Default prompt defense</span>
          {/if}
        </div>
      {/if}
      <div class="mt-3 inline-flex flex-wrap items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-xs text-gray-300">
        <span class="font-semibold text-white">Phase:</span>
        <span>{phaseLabel(roundPhase)}</span>
        {#if formatRemaining(phaseTimeRemaining)}
          <span class="text-gray-500">•</span>
          <span>{formatRemaining(phaseTimeRemaining)} remaining</span>
        {/if}
      </div>
    </div>

    {#if actionMessage}
      <div class="p-4 rounded-xl border {actionError ? 'bg-red-500/10 border-red-500/50 text-red-400' : 'bg-green-500/10 border-green-500/50 text-green-400'}">
        {actionMessage}
      </div>
    {/if}

    {#if myTeam}
      <div class="border border-white/10 bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl shadow-lg space-y-5">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p class="text-xs uppercase tracking-[0.2em] text-gray-500">Your Team</p>
            <h2 class="font-black text-2xl text-white mt-1">{myTeam.name}</h2>
            <p class="text-gray-400 mt-2">Role: <span class="text-gray-200">{myTeam.role}</span></p>
            <p class="text-gray-300 mt-1">Coins: <span class="text-red-400 font-semibold">{myTeam.coins ?? 0}</span></p>
          </div>
          <span class="text-gray-300 font-mono text-xs break-all">TEAM:{myTeam.id}</span>
        </div>

        {#if myTeam.role === 'leader'}
          <div class="text-sm bg-black/40 p-3 rounded-lg border border-white/5">
            <span class="text-gray-400">Team Invite Code:</span>
            <span class="ml-2 text-red-400 font-mono font-bold tracking-wider">TEAM:{myTeam.invite_code}</span>
          </div>
        {/if}

        <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
          <a href={`/game/${gameId}/team/${myTeam.id}`} class="text-center px-4 py-2 bg-white/10 hover:bg-white/20 text-gray-200 border border-white/20 rounded-lg font-bold text-sm transition-colors">Manage</a>
          <a href={`/game/${gameId}/defend`} class="text-center px-4 py-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border border-blue-500/30 rounded-lg font-bold text-sm transition-colors">Defend</a>
          <a href={`/game/${gameId}/attack`} class="text-center px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-500 border border-red-500/30 rounded-lg font-bold text-sm transition-colors">Attack</a>
          <a href={`/game/${gameId}/live-events`} class="text-center px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 border border-emerald-500/30 rounded-lg font-bold text-sm transition-colors">Live Events</a>
        </div>

        <div class="border border-white/10 rounded-xl bg-black/30 p-4 space-y-3">
          <p class="text-xs uppercase tracking-[0.2em] text-gray-400">Mission Control</p>
          {#if gameplaySummaryLoading}
            <p class="text-sm text-gray-400">Refreshing round action summary...</p>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div class="rounded-lg border border-white/10 bg-white/5 p-3">
                <p class="text-gray-400">Round Challenges</p>
                <p class="text-white font-bold text-xl mt-1">{allowedChallengeCount}</p>
              </div>
              <div class="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3">
                <p class="text-blue-200">Defenses Configured</p>
                <p class="text-white font-bold text-xl mt-1">{defendedChallengeCount}</p>
              </div>
              <div class="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                <p class="text-red-200">Attack Targets</p>
                <p class="text-white font-bold text-xl mt-1">{attackTargetCount}</p>
              </div>
            </div>
            <p class="text-sm text-gray-300">{recommendedAction()}</p>
          {/if}
        </div>
      </div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div class="border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl shadow-xl flex flex-col justify-between">
          <div>
            <div class="w-12 h-12 bg-blue-500/10 rounded-full flex items-center justify-center mb-4 ring-1 ring-blue-500/30 text-2xl">🤝</div>
            <h2 class="text-2xl font-bold text-white mb-2">Join a Team</h2>
            <p class="text-gray-400 mb-6">Enter a team invite code for this game.</p>
            <input bind:value={inviteCode} placeholder="E.g. TEAM:A1B2C3" class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white text-center text-xl tracking-[0.3em] font-mono uppercase focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all" maxlength="11" />
          </div>
          <button onclick={joinTeam} disabled={loading || normalizeInviteCode(inviteCode).length < 6} class="w-full bg-blue-600 hover:bg-blue-500 text-white px-6 py-4 rounded-xl font-bold disabled:opacity-50 transition-all text-lg tracking-wide mt-6">
            {loading ? 'Joining...' : 'JOIN TEAM'}
          </button>
        </div>

        <div class="border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl shadow-xl flex flex-col justify-between">
          <div>
            <div class="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4 ring-1 ring-red-500/30 text-2xl">🛡️</div>
            <h2 class="text-2xl font-bold text-white mb-2">Create a Team</h2>
            <p class="text-gray-400 mb-6">Start a new squad in this game.</p>
            <div class="space-y-2">
              <label for="new-team-name" class="text-sm font-semibold text-gray-300">Team Name</label>
              <input id="new-team-name" bind:value={newTeamName} placeholder="e.g. Protocol Breakers" class="w-full bg-black/60 border border-white/10 rounded-xl p-3 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
            </div>
          </div>
          <button onclick={createTeam} disabled={loading || !newTeamName} class="w-full bg-red-600 hover:bg-red-500 text-white px-6 py-4 rounded-xl font-bold disabled:opacity-50 transition-all text-lg tracking-wide mt-6">
            {loading ? 'Creating...' : 'CREATE TEAM'}
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>
