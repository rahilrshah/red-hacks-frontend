<script module lang="ts">
  type AttackTargetsCacheEntry = {
    gameName: string;
    roundInfo: any;
    challenges: any[];
    selectedChallengeId: string;
    statusError: string;
    timestampMs: number;
  };

  const ATTACK_TARGETS_CACHE_TTL_MS = 60_000;
  const attackTargetsCache = new Map<string, AttackTargetsCacheEntry>();

  type AttackMessage = {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  };
</script>

<script lang="ts">
  import { page } from '$app/stores';
  import { calculateAttackBonus, SOFT_CHAR_CAP, SOFT_TURN_CAP } from '$lib/bonus';
  import GameSectionNav from '$lib/components/GameSectionNav.svelte';
  import { isGameActive, loadRoundChallengeIds, loadRoundRuntimeContext, resolveRoundType } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onDestroy, onMount } from 'svelte';

  let gameId = $derived($page.params.gameId ?? '');
  let gameName = $state('');
  let roundInfo = $state<any>(null);
  let challenges = $state<any[]>([]);
  let selectedChallengeId = $state('');
  let loading = $state(false);
  let statusError = $state('');
  let attackMode = $derived(resolveRoundType(roundInfo));
  let loadingTargets = $state(false);
  let hasLoadedOnce = $state(false);

  // Chat state — per-target, swaps when selectedChallengeId changes
  let messages = $state<AttackMessage[]>([]);
  let promptInput = $state('');
  let secretKeyGuess = $state('');
  let chatLoading = $state(false);
  let attackResult = $state<any>(null);
  let userId = $state('');

  let selectedTarget = $derived(challenges.find((c: any) => c.id === selectedChallengeId) ?? null);
  let chatStorageKey = $derived(`attack-chat:${gameId}:${attackMode}:${selectedChallengeId}`);

  let potentialReward = $derived.by(() => {
    const userMessages = messages.filter((m) => m.role === 'user');
    const localTurns = userMessages.length;
    const localChars = userMessages.reduce((acc, m) => acc + m.content.length, 0);
    const draftChars = promptInput.length;

    // After a chat clear, serverTurnCount is populated from the attacks table
    // so the preview reflects ALL prior attempts, not just the (now empty)
    // local messages. Use whichever is higher (server may know about attempts
    // the client doesn't have in localStorage).
    const effectiveTurns = Math.max(localTurns, serverTurnCount ?? 0);
    const effectiveChars = Math.max(localChars, serverCharCount ?? 0);

    return calculateAttackBonus({
      turnCount: effectiveTurns + 1,
      charCount: effectiveChars + draftChars,
      attackStealCoins: selectedTarget?.challenges?.attack_steal_coins ?? 0,
      defenseRewardCoins: selectedTarget?.challenges?.defense_reward_coins ?? 0
    });
  });

  function hasActiveSession(targetId: string): boolean {
    try {
      const key = `attack-chat:${gameId}:${attackMode}:${targetId}`;
      const stored = localStorage.getItem(key);
      if (!stored) return false;
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }

  // ---------- target list caching (from Denali's e3c2547) ----------

  function cacheKey() { return gameId; }

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
    statusError = cached.statusError;
    return true;
  }

  function saveToCache() {
    const key = cacheKey();
    if (!key) return;
    attackTargetsCache.set(key, {
      gameName, roundInfo, challenges, selectedChallengeId, statusError,
      timestampMs: Date.now()
    });
  }

  $effect(() => {
    if (hasLoadedOnce && !loadingTargets) {
      saveToCache();
    }
  });

  // ---------- chat persistence ----------

  function loadChatForTarget() {
    if (!selectedChallengeId || !chatStorageKey) {
      messages = [];
      attackResult = null;
      return;
    }
    try {
      const raw = localStorage.getItem(chatStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) { messages = parsed; return; }
      }
    } catch { /* ignore */ }
    messages = [];
    attackResult = null;
  }

  function persistChat() {
    if (!chatStorageKey) return;
    localStorage.setItem(chatStorageKey, JSON.stringify(messages));
  }

  function clearChatHistory() {
    if (!confirm('Are you sure you want to clear chat?\n\nThis resets the LLM conversation (the model forgets prior context) but does NOT reset your server-side bonus tracking. Your elegance score is based on ALL attempts you have sent, including cleared ones.')) {
      return;
    }
    messages = [];
    attackResult = null;
    if (chatStorageKey) localStorage.removeItem(chatStorageKey);
    // Refresh the server-side attempt count so the bonus preview stays
    // accurate instead of jumping back to 100%.
    void refreshServerTurnCount();
  }

  let serverTurnCount = $state<number | null>(null);
  let serverCharCount = $state<number | null>(null);

  async function refreshServerTurnCount() {
    if (!selectedChallengeId || !userId) {
      serverTurnCount = null;
      serverCharCount = null;
      return;
    }

    try {
      const targetColumn = attackMode === 'pve' ? 'challenge_id' : 'defended_challenge_id';
      const { data } = await supabase
        .from('attacks')
        .select('is_successful, log, created_at')
        .eq('attacker_team_id', await getMyTeamId())
        .eq(targetColumn, selectedChallengeId)
        .eq('is_successful', false)
        .order('created_at', { ascending: false });

      // Count all failed attempts (the server uses a time window, but for a
      // quick preview after clear we just use the total — it'll be close
      // enough and always >= the server's count, so the preview is
      // conservative rather than misleading).
      serverTurnCount = (data?.length ?? 0);
      serverCharCount = (data ?? []).reduce((acc, row: any) => {
        const prompt = row?.log?.latest_prompt;
        return acc + (typeof prompt === 'string' ? prompt.length : 0);
      }, 0);
    } catch {
      serverTurnCount = null;
      serverCharCount = null;
    }
  }

  async function getMyTeamId(): Promise<string> {
    const { data } = await supabase
      .from('team_members')
      .select('team_id, teams!inner(game_id)')
      .eq('user_id', userId)
      .eq('teams.game_id', gameId)
      .limit(1)
      .maybeSingle();
    return data?.team_id ?? '';
  }

  // When the selected target changes, swap the chat and reset server counts
  $effect(() => {
    if (selectedChallengeId) {
      loadChatForTarget();
      attackResult = null;
      promptInput = '';
      secretKeyGuess = '';
      serverTurnCount = null;
      serverCharCount = null;
    }
  });

  // ---------- attack invocation ----------

  function buildAttackPayload(args: { guess?: string } = {}) {
    const t = selectedTarget;
    const currentAttackMode = resolveRoundType(roundInfo);
    const resolvedSystemPrompt =
      (t?.system_prompt as string | undefined)?.trim() ||
      (t?.challenges?.default_prompt as string | undefined)?.trim() ||
      'You are a helpful assistant.';

    const payload: Record<string, unknown> = {
      prompt: messages.length > 0 ? messages[messages.length - 1].content : '',
      guess: args.guess || '',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      challenge: {
        challenge_id: t?.challenges?.id ?? selectedChallengeId,
        title: t?.challenges?.model_name ?? 'Challenge',
        description: t?.challenges?.description ?? '',
        objective:
          t?.challenges?.type === 'tool-calling'
            ? `Induce targeted tool use: ${t?.challenges?.target_tool_name ?? 'unknown tool'}`
            : 'Extract the secret key.',
        system_prompt: resolvedSystemPrompt,
        success_tool_name: t?.challenges?.target_tool_name ?? null
      }
    };

    if (currentAttackMode === 'pve') {
      payload.challenge_id = selectedChallengeId;
      payload.game_id = gameId;
      payload.round_type = 'pve';
    } else {
      payload.defended_challenge_id = selectedChallengeId;
    }

    return payload;
  }

  async function invokeAttack(args: { guess?: string } = {}) {
    if (!selectedTarget || !userId) {
      attackResult = { error: 'You must be signed in and have a valid target selected.' };
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken) {
      attackResult = { error: 'Your session is missing or expired. Please sign in again.', success: false };
      return;
    }

    const payload = buildAttackPayload(args);
    let responseData: any = null;

    try {
      const response = await fetch(`/game/${gameId}/attack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload)
      });
      const responseText = await response.text();
      try { responseData = responseText ? JSON.parse(responseText) : null; } catch { responseData = responseText; }
      if (!response.ok) {
        throw new Error(responseData?.error || responseData?.message || (typeof responseData === 'string' ? responseData : '') || `Attack request failed with status ${response.status}`);
      }
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error while connecting to attack backend.' };
      return;
    }

    if (!responseData || typeof responseData !== 'object') {
      attackResult = { success: false, error: 'Attack backend returned an invalid response payload.' };
      return;
    }

    attackResult = responseData;

    if (responseData?.assistant) {
      messages = [...messages, { role: 'assistant', content: responseData.assistant, timestamp: new Date().toISOString() }];
      persistChat();
    }
  }

  async function sendPrompt() {
    if (!promptInput.trim()) return;
    chatLoading = true;
    try {
      messages = [...messages, { role: 'user', content: promptInput.trim(), timestamp: new Date().toISOString() }];
      persistChat();
      promptInput = '';
      await invokeAttack();
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error while sending prompt.' };
    } finally {
      chatLoading = false;
    }
  }

  async function submitSecretGuess() {
    if (!secretKeyGuess.trim()) return;
    chatLoading = true;
    try {
      await invokeAttack({ guess: secretKeyGuess.trim() });
      secretKeyGuess = '';
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error while submitting secret key guess.' };
    } finally {
      chatLoading = false;
    }
  }

  function formatTime(isoText: string) {
    try { return new Date(isoText).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }

  // ---------- target list loading ----------

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

      if (gameError) { statusError = gameError.message; return; }
      gameName = gameData?.name ?? '';
      if (!gameData || !isGameActive(gameData)) { statusError = 'This game is not currently active.'; return; }

      const runtimeContext = await loadRoundRuntimeContext(supabase, gameId);
      roundInfo = runtimeContext.currentRound;

      if (runtimeContext.phase === 'intermission') { statusError = 'Round intermission is active. Attacks are paused until the next round starts.'; return; }
      if (runtimeContext.phase !== 'round-active' || !roundInfo) { statusError = 'There is no active round to attack right now.'; return; }

      const allowedChallengeIds = await loadRoundChallengeIds(supabase, gameId, roundInfo);
      if (allowedChallengeIds.length === 0) { challenges = []; return; }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) { statusError = userError.message; return; }
      userId = userData?.user?.id ?? '';

      let myTeamId: string | null = null;
      if (userId && resolveRoundType(roundInfo) === 'pvp') {
        const { data: membership, error: membershipError } = await supabase
          .from('team_members')
          .select('team_id, teams!inner(game_id)')
          .eq('user_id', userId)
          .eq('teams.game_id', gameId)
          .limit(1)
          .maybeSingle();
        if (membershipError) { statusError = membershipError.message; return; }
        myTeamId = membership?.team_id ?? null;

        const requiredDefenses = Math.max(0, Math.trunc(roundInfo?.required_defenses ?? 0));
        if (myTeamId && requiredDefenses > 0) {
          const { count: defendedCount, error: defendedCountError } = await supabase
            .from('defended_challenges')
            .select('id', { count: 'exact', head: true })
            .eq('team_id', myTeamId)
            .eq('is_active', true)
            .in('challenge_id', allowedChallengeIds);
          if (defendedCountError) { statusError = defendedCountError.message; return; }
          if ((defendedCount ?? 0) < requiredDefenses) {
            statusError = `Attack locked: defend at least ${requiredDefenses} prompt(s) this round before attacking (${defendedCount ?? 0}/${requiredDefenses} configured).`;
            return;
          }
        }
      }

      if (resolveRoundType(roundInfo) === 'pvp') {
        if (!myTeamId) { statusError = 'Could not determine your team for this game, so opponent targets cannot be resolved.'; return; }
        const { data, error } = await supabase
          .from('defended_challenges')
          .select('id, team_id, is_active, teams!inner(name, game_id, coins), challenges(*)')
          .eq('teams.game_id', gameId)
          .in('challenge_id', allowedChallengeIds)
          .gt('teams.coins', 0)
          .neq('team_id', myTeamId);
        if (error) { statusError = error.message; return; }
        challenges = (data ?? []).sort((a: any, b: any) => Number(b.is_active) - Number(a.is_active));
      } else {
        const { data, error } = await supabase
          .from('challenges')
          .select('id, name, description, type, model_name, attack_steal_coins, default_prompt, *')
          .in('id', allowedChallengeIds);
        if (error) { statusError = error.message; return; }
        challenges = (data ?? []).map((challenge: any) => ({
          id: challenge.id, team_id: null, is_active: true,
          teams: { name: roundInfo?.name ?? 'Default Defense', game_id: gameId, coins: 0 },
          challenges: challenge
        }));
      }

      if (challenges.length > 0 && !selectedChallengeId) {
        selectedChallengeId = challenges[0].id;
      }
    } catch (err: any) {
      statusError = err?.message || 'Unexpected error while loading attack targets.';
    } finally {
      hasLoadedOnce = true;
      saveToCache();
      loadingTargets = false;
    }
  }

  onMount(() => {
    const restored = restoreFromCache();
    if (!restored) {
      void loadAttackTargets();
    } else {
      supabase.auth.getUser().then(({ data }) => { userId = data?.user?.id ?? ''; });
    }
  });

  // ---------- Realtime: refresh targets when defenses or teams change ----------

  const realtimeChannel = supabase.channel(`attack-targets:${gameId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'defended_challenges' },
      () => { void loadAttackTargets(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },
      () => { void loadAttackTargets(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `game_id=eq.${gameId}` },
      () => { void loadAttackTargets(); })
    .subscribe();

  onDestroy(() => { supabase.removeChannel(realtimeChannel); });
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
      <p class="text-gray-400 text-sm">Game: <span class="font-semibold text-white">{gameName}</span></p>
    {/if}
    {#if roundInfo}
      <p class="text-gray-400 text-sm mb-2">Round: <span class="font-semibold text-white">{roundInfo.name}</span> · Type: <span class="font-semibold text-white uppercase">{roundInfo.type}</span></p>
    {/if}
  </div>

  {#if statusError}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">{statusError}</div>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    <!-- Left: target list -->
    <div class="col-span-1 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl overflow-hidden h-[48rem] flex flex-col shadow-xl">
      <div class="p-4 border-b border-white/10 bg-black/40 sticky top-0 z-10">
        <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Available Targets</h2>
      </div>
      <div class="divide-y divide-white/5 overflow-y-auto flex-1">
        {#each challenges as target}
          <button
            class="w-full text-left p-5 hover:bg-slate-800/80 transition-all block group {selectedChallengeId === target.id ? 'bg-red-500/10 border-l-4 border-red-500' : 'border-l-4 border-transparent'}"
            onclick={() => selectedChallengeId = target.id}
          >
            <div class="font-bold text-white mb-1 group-hover:text-red-300 transition-colors flex items-center gap-2">
              {target.teams?.name || 'Default Defense'}
              {#if hasActiveSession(target.id)}
                <span class="text-[10px] font-normal uppercase tracking-wider text-amber-300 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded">In Progress</span>
              {/if}
            </div>
            <div class="text-xs text-gray-400 mb-3 truncate font-mono">{target.challenges?.name || target.challenges?.model_name} · {target.challenges?.type}</div>
            <div class="text-xs mb-2 {target.is_active ? 'text-emerald-300' : 'text-amber-300'}">{target.is_active ? 'Active Defense' : 'Inactive Defense'}</div>
            <div class="text-xs text-gray-300">{attackMode === 'pvp' ? `Team Coins: ${target.teams?.coins ?? 0}` : 'Default prompt target'}</div>
            <div class="text-xs text-gray-500 mt-1">Base steal value: {target.challenges?.attack_steal_coins ?? 0}</div>
          </button>
        {/each}
        {#if challenges.length === 0}
          <div class="p-5 text-sm text-gray-500">
            {attackMode === 'pvp' ? 'No opponent defended challenges were found for this game yet.' : 'No round challenges are available for this game yet.'}
          </div>
        {/if}
      </div>
    </div>

    <!-- Right: inline chat -->
    <div class="col-span-1 md:col-span-2 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl shadow-xl flex flex-col h-[48rem]">
      {#if !selectedTarget}
        <div class="flex-1 flex items-center justify-center">
          <div class="text-center text-gray-500 space-y-3">
            <div class="text-5xl">🎯</div>
            <p class="font-semibold text-lg">No target selected</p>
            <p class="text-sm">Select an opponent from the list to begin the assault.</p>
          </div>
        </div>
      {:else}
        <!-- Target header -->
        <div class="p-4 border-b border-white/10 bg-black/40 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-white font-bold">
              {selectedTarget.teams?.name || 'Default Defense'}
              <span class="text-gray-400 font-normal ml-2">{selectedTarget.challenges?.name || selectedTarget.challenges?.model_name} · {selectedTarget.challenges?.type}</span>
            </p>
            <p class="text-xs text-gray-500 mt-1">{selectedTarget.challenges?.description}</p>
          </div>
          <button onclick={clearChatHistory} class="px-2.5 py-1 rounded border border-white/20 hover:border-white/40 text-xs text-gray-300 hover:text-white transition-colors" title="Resets the LLM conversation only. Server still counts prior attempts for bonus.">
            Clear Chat
          </button>
        </div>

        <!-- Messages -->
        <div class="flex-1 overflow-y-auto p-4 space-y-3">
          {#if messages.length === 0}
            <p class="text-gray-500 text-sm">No messages yet. Send your first attack prompt below.</p>
          {:else}
            {#each messages as message}
              <div class="rounded-lg p-3 {message.role === 'user' ? 'bg-red-500/10 border border-red-500/20' : 'bg-white/5 border border-white/10'}">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs uppercase tracking-wider {message.role === 'user' ? 'text-red-300' : 'text-gray-300'}">{message.role}</span>
                  <span class="text-xs text-gray-500">{formatTime(message.timestamp)}</span>
                </div>
                <p class="text-sm text-gray-100 whitespace-pre-wrap">{message.content}</p>
              </div>
            {/each}
          {/if}

          {#if attackResult}
            {@const isSuccess = !!attackResult.success}
            {@const isError = !!attackResult.error}
            <div class="p-4 rounded-xl border {isSuccess ? 'bg-green-500/10 border-green-500/50 text-green-400' : isError ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-amber-500/10 border-amber-500/50 text-amber-300'}">
              <div class="font-black text-lg mb-2">{isSuccess ? '✅ TARGET COMPROMISED!' : isError ? '⚠️ ATTACK ERROR' : '↻ ATTEMPT COMPLETE - KEEP PUSHING'}</div>
              <div class="text-sm opacity-90 font-medium">{attackResult.message || attackResult.error || 'No compromise yet. Refine your prompt and try again.'}</div>
              {#if isSuccess && typeof attackResult.bonus_coins === 'number' && attackResult.bonus_coins > 0}
                <div class="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono">
                  <div class="font-semibold">⚡ Elegance bonus: +{attackResult.bonus_coins} coins</div>
                  <div class="opacity-80 mt-1">
                    {attackResult.base_coins ?? 0} base + {attackResult.bonus_coins} bonus = {attackResult.stolen_coins ?? 0} total
                    {#if typeof attackResult.elegance_factor === 'number'}· elegance {Math.round(attackResult.elegance_factor * 100)}%{/if}
                    {#if typeof attackResult.turn_count === 'number'}· {attackResult.turn_count} {attackResult.turn_count === 1 ? 'turn' : 'turns'}{/if}
                  </div>
                </div>
              {:else if isSuccess && typeof attackResult.base_coins === 'number'}
                <div class="mt-3 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-300 text-xs font-mono">
                  Base reward: {attackResult.base_coins} coins (elegance exhausted, no bonus)
                </div>
              {/if}
              {#if attackResult.log}
                <div class="mt-3 text-xs bg-black/60 p-3 rounded-lg text-gray-300 font-mono max-h-44 overflow-y-auto border border-white/5">{attackResult.log}</div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Input area -->
        <div class="p-4 border-t border-white/10 bg-black/20 space-y-3">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Attack Prompt</p>
            <div class="px-3 py-1.5 rounded-lg bg-amber-900/30 border border-amber-500/30 text-xs font-mono text-amber-200">
              {#if potentialReward.base === 0}
                Reward: <strong>0</strong> (no steal configured)
              {:else if potentialReward.bonus > 0}
                Reward: <strong class="text-amber-100">{potentialReward.total}</strong>
                = {potentialReward.base} + <strong class="text-green-300">{potentialReward.bonus}</strong> bonus
                <span class="text-amber-400/70">· {Math.round(potentialReward.eleganceFactor * 100)}%</span>
              {:else}
                Reward: <strong>{potentialReward.base}</strong> base only
              {/if}
            </div>
          </div>
          <textarea bind:value={promptInput} class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white h-24 focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all placeholder:text-gray-600 font-mono text-sm" placeholder="> Type your attack prompt..."></textarea>
          <div class="flex gap-3">
            <button onclick={sendPrompt} disabled={chatLoading || !promptInput.trim()} class="flex-1 bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-xl font-bold disabled:opacity-50 transition-all uppercase">
              {chatLoading ? 'SENDING...' : 'Send Prompt'}
            </button>
          </div>

          {#if selectedTarget?.challenges?.type === 'secret-key'}
            <div class="flex gap-3 pt-2 border-t border-white/10">
              <input bind:value={secretKeyGuess} class="flex-1 bg-black/60 border border-white/10 rounded-xl p-3 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none placeholder:text-gray-600 font-mono text-sm" placeholder="Secret key guess..." />
              <button onclick={submitSecretGuess} disabled={chatLoading || !secretKeyGuess.trim()} class="border border-red-500/40 hover:bg-red-500/10 text-red-400 px-4 py-3 rounded-xl font-bold disabled:opacity-50 transition-all uppercase text-sm">
                {chatLoading ? '...' : 'Guess'}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
