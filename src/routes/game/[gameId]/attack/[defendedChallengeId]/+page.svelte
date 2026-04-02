<script lang="ts">
  import { page } from '$app/stores';
  import { isGameActive, loadRoundChallengeIds, loadRoundRuntimeContext, resolveRoundType } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  type AttackMessage = {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  };

  let gameId = $derived($page.params.gameId ?? '');
  let defendedChallengeId = $derived($page.params.defendedChallengeId ?? '');

  let roundInfo = $state<any>(null);
  let target = $state<any>(null);
  let messages = $state<AttackMessage[]>([]);
  let promptInput = $state('');
  let secretKeyGuess = $state('');
  let loading = $state(false);
  let pageLoading = $state(true);
  let attackResult = $state<any>(null);
  let userId = $state('');
  let statusError = $state('');

  let attackMode = $derived(resolveRoundType(roundInfo));
  const chatStorageKey = $derived(`attack-chat:${gameId}:${attackMode}:${defendedChallengeId}`);

  onMount(async () => {
    const { data: userData } = await supabase.auth.getUser();
    userId = userData?.user?.id ?? '';

    await loadTarget();
    loadChatHistory();

    const initialSeed = $page.url.searchParams.get('seed')?.trim();
    if (initialSeed) {
      promptInput = initialSeed;
      await sendPrompt();
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('seed');
      window.history.replaceState(window.history.state, '', nextUrl.toString());
    }
  });

  async function loadTarget() {
    pageLoading = true;
    statusError = '';

    const { data: gameData, error: gameError } = await supabase
      .from('games')
      .select('is_active, start_time, end_time')
      .eq('id', gameId)
      .maybeSingle();

    if (gameError) {
      statusError = gameError.message;
      pageLoading = false;
      return;
    }

    if (!gameData || !isGameActive(gameData)) {
      statusError = 'This game is not currently active.';
      pageLoading = false;
      return;
    }

    try {
      const runtimeContext = await loadRoundRuntimeContext(supabase, gameId);
      roundInfo = runtimeContext.currentRound;

      if (runtimeContext.phase === 'intermission') {
        statusError = 'Round intermission is active. Attack sessions are paused.';
        pageLoading = false;
        return;
      }

      if (runtimeContext.phase !== 'round-active' || !roundInfo) {
        statusError = 'There is no active round to attack right now.';
        pageLoading = false;
        return;
      }
    } catch (error: any) {
      statusError = error?.message || 'Could not load the active round.';
      pageLoading = false;
      return;
    }

    let allowedChallengeIds: string[] = [];

    try {
      allowedChallengeIds = await loadRoundChallengeIds(supabase, gameId, roundInfo);
    } catch (error: any) {
      statusError = error?.message || 'Could not resolve the current round challenges.';
      pageLoading = false;
      return;
    }

    if (allowedChallengeIds.length === 0) {
      statusError = 'This game has no active round challenges yet.';
      pageLoading = false;
      return;
    }

    if (resolveRoundType(roundInfo) === 'pve') {
      const { data, error } = await supabase
        .from('challenges')
        .select('*')
        .eq('id', defendedChallengeId)
        .single();

      if (error || !data) {
        statusError = error?.message || 'Could not load selected challenge.';
        target = null;
        pageLoading = false;
        return;
      }

      if (!allowedChallengeIds.includes(data.id)) {
        statusError = 'This challenge is not enabled for the current round.';
        target = null;
        pageLoading = false;
        return;
      }

      target = {
        id: data.id,
        team_id: null,
        teams: {
          name: roundInfo?.name ?? 'Default Defense',
          game_id: gameId
        },
        challenges: data
      };

      pageLoading = false;
      return;
    }

    const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser();
    if (currentUserError) {
      statusError = currentUserError.message;
      pageLoading = false;
      return;
    }

    const currentUserId = currentUserData?.user?.id;
    if (!currentUserId) {
      statusError = 'You must be signed in to attack.';
      pageLoading = false;
      return;
    }

    const { data: membership, error: membershipError } = await supabase
      .from('team_members')
      .select('team_id, teams!inner(game_id)')
      .eq('user_id', currentUserId)
      .eq('teams.game_id', gameId)
      .limit(1)
      .maybeSingle();

    if (membershipError || !membership?.team_id) {
      statusError = membershipError?.message || 'Could not determine your team for this game.';
      pageLoading = false;
      return;
    }

    const requiredDefenses = Math.max(0, Math.trunc(roundInfo?.required_defenses ?? 0));
    if (requiredDefenses > 0) {
      const { count: defendedCount, error: defendedCountError } = await supabase
        .from('defended_challenges')
        .select('id', { count: 'exact', head: true })
        .eq('team_id', membership.team_id)
        .eq('is_active', true)
        .in('challenge_id', allowedChallengeIds);

      if (defendedCountError) {
        statusError = defendedCountError.message;
        pageLoading = false;
        return;
      }

      if ((defendedCount ?? 0) < requiredDefenses) {
        statusError = `Attack locked: defend at least ${requiredDefenses} prompt(s) this round before attacking (${defendedCount ?? 0}/${requiredDefenses} configured).`;
        pageLoading = false;
        return;
      }
    }

    const { data, error } = await supabase
      .from('defended_challenges')
      .select('id, team_id, teams!inner(name, game_id), challenges!inner(*)')
      .eq('id', defendedChallengeId)
      .eq('teams.game_id', gameId)
      .single();

    if (error || !data) {
      statusError = error?.message || 'Could not load selected attack target.';
      target = null;
      pageLoading = false;
      return;
    }

    const selectedChallenge = Array.isArray(data.challenges) ? data.challenges[0] : data.challenges;
    if (!selectedChallenge?.id) {
      statusError = 'Could not resolve the selected challenge for this target.';
      target = null;
      pageLoading = false;
      return;
    }

    const { data: gameChallengeRow, error: gameChallengeError } = await supabase
      .from('game_challenges')
      .select('challenge_id')
      .eq('game_id', gameId)
      .eq('challenge_id', selectedChallenge.id)
      .maybeSingle();

    if (gameChallengeError || !gameChallengeRow) {
      statusError = 'This challenge is not enabled for the current game.';
      target = null;
      pageLoading = false;
      return;
    }

    target = data;
    pageLoading = false;
  }

  function loadChatHistory() {
    try {
      const raw = localStorage.getItem(chatStorageKey);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        messages = parsed;
      }
    } catch {
      messages = [];
    }
  }

  function persistChatHistory() {
    localStorage.setItem(chatStorageKey, JSON.stringify(messages));
  }

  async function parseFunctionError(error: any) {
    let backendErrorMessage = error?.message || 'Failed to connect to attack server';

    const errorContext = error?.context;
    if (!errorContext) return backendErrorMessage;

    try {
      const parsed = await errorContext.json();
      return parsed?.error || parsed?.message || backendErrorMessage;
    } catch {
      try {
        const rawText = await errorContext.text();
        return rawText || backendErrorMessage;
      } catch {
        return backendErrorMessage;
      }
    }
  }

  function toChatMessages() {
    return messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
  }

  function buildAttackPayload(args: { guess?: string } = {}) {
    const currentAttackMode = resolveRoundType(roundInfo);
    const payload: Record<string, unknown> = {
      prompt: messages.length > 0 ? messages[messages.length - 1].content : '',
      guess: args.guess || '',
      messages: toChatMessages()
    };

    if (currentAttackMode === 'pve') {
      payload.challenge_id = defendedChallengeId;
      payload.game_id = gameId;
      payload.round_type = 'pve';
    } else {
      payload.defended_challenge_id = defendedChallengeId;
    }

    return payload;
  }

  async function postAttackRequest(url: string, accessToken: string, payload: Record<string, unknown>) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let parsed: any = null;

    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      parsed = responseText;
    }

    if (!response.ok) {
      const errorMessage = parsed?.error || parsed?.message || responseText || `Attack backend returned ${response.status}`;
      throw new Error(errorMessage);
    }

    return parsed;
  }

  async function invokeAttack(args: { guess?: string } = {}) {
    if (!target || !userId) {
      attackResult = { error: 'You must be signed in and have a valid target selected.' };
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;

    if (sessionError || !accessToken) {
      attackResult = {
        error: 'Your session is missing or expired. Please sign in again.',
        success: false
      };
      return;
    }

    const payload = buildAttackPayload(args);

    let responseData: any = null;

    try {
      if (target.challenges?.challenge_url) {
        responseData = await postAttackRequest(target.challenges.challenge_url, accessToken, payload);
      } else {
        const { data, error } = await supabase.functions.invoke('attack', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          body: payload
        });

        if (error) {
          const parsedError = await parseFunctionError(error);
          attackResult = { error: parsedError, success: false };
          return;
        }

        responseData = data;
      }
    } catch (err: any) {
      attackResult = {
        success: false,
        error: err?.message || 'Unexpected error while connecting to attack backend.'
      };
      return;
    }

    attackResult = responseData;

    if (responseData?.assistant) {
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: responseData.assistant,
          timestamp: new Date().toISOString()
        }
      ];
      persistChatHistory();
    }
  }

  async function sendPrompt() {
    if (!promptInput.trim()) return;

    loading = true;

    try {
      messages = [
        ...messages,
        {
          role: 'user',
          content: promptInput.trim(),
          timestamp: new Date().toISOString()
        }
      ];
      persistChatHistory();

      promptInput = '';
      await invokeAttack();
    } catch (err: any) {
      attackResult = {
        success: false,
        error: err?.message || 'Unexpected error while sending prompt.'
      };
    } finally {
      loading = false;
    }
  }

  async function submitSecretGuess() {
    if (!secretKeyGuess.trim()) return;

    loading = true;
    try {
      await invokeAttack({ guess: secretKeyGuess.trim() });
      secretKeyGuess = '';
    } catch (err: any) {
      attackResult = {
        success: false,
        error: err?.message || 'Unexpected error while submitting secret key guess.'
      };
    } finally {
      loading = false;
    }
  }

  function clearChatHistory() {
    messages = [];
    attackResult = null;
    localStorage.removeItem(chatStorageKey);
  }

  function formatTime(isoText: string) {
    try {
      return new Date(isoText).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-8">
  <div class="border-b border-white/10 pb-6">
    <a href={`/game/${gameId}/attack`} class="inline-flex items-center text-sm text-gray-400 hover:text-white transition-colors mb-4">&larr; Back to Target List</a>
    <h1 class="text-4xl font-black tracking-tight text-white mb-2">Attack Session</h1>
    {#if target}
      <p class="text-gray-400 text-lg">{attackMode === 'pvp' ? 'Target team' : 'Target challenge'}: <span class="text-red-400 font-semibold">{target.teams?.name || 'Default Defense'}</span> • Challenge: <span class="text-white font-semibold">{target.challenges?.model_name}</span></p>
      {#if roundInfo}
        <p class="text-xs text-gray-500 mt-2">Round: {roundInfo.name} • {roundInfo.type.toUpperCase()}</p>
      {/if}
    {/if}
  </div>

  {#if statusError}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">{statusError}</div>
  {:else if pageLoading}
    <div class="text-gray-400">Loading attack session...</div>
  {:else if target}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="col-span-1 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl p-5 space-y-4 h-fit">
        <h2 class="text-sm font-bold text-gray-400 tracking-widest uppercase">Target Info</h2>
        <div>
          <p class="text-white font-semibold">{target.teams?.name}</p>
          <p class="text-xs text-gray-400 mt-1">{target.challenges?.type}</p>
        </div>
        <p class="text-sm text-gray-400">{target.challenges?.description}</p>
        <div class="text-xs text-gray-500">Steal on success: {target.challenges?.attack_steal_coins ?? 0} coins</div>
        {#if target.challenges?.challenge_url}
          <div class="text-xs text-emerald-300 break-all">Direct backend: {target.challenges.challenge_url}</div>
        {/if}
        <button onclick={clearChatHistory} class="w-full border border-white/20 hover:border-white/40 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">Clear Chat History</button>
      </div>

      <div class="col-span-1 md:col-span-2 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl p-6 space-y-5">
        <div class="border border-white/10 bg-black/40 rounded-lg overflow-y-auto p-4 space-y-3" style="height: 22.5rem;">
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
        </div>

        <div class="space-y-3">
          <p class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Send Attack Prompt</p>
          <textarea bind:value={promptInput} class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white h-32 focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all placeholder:text-gray-600 font-mono text-sm leading-relaxed" placeholder="> Continue attack conversation..."></textarea>
          <button onclick={sendPrompt} disabled={loading || !promptInput.trim()} class="bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-xl font-bold disabled:opacity-50 transition-all w-full uppercase">{loading ? 'SENDING...' : 'Send Prompt'}</button>
        </div>

        {#if target.challenges?.type === 'secret-key'}
          <div class="space-y-3 pt-4 border-t border-white/10">
            <p class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Secret Key Guess</p>
            <input bind:value={secretKeyGuess} class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all placeholder:text-gray-600 font-mono text-sm" placeholder="Submit sequence if extracted..." />
            <button onclick={submitSecretGuess} disabled={loading || !secretKeyGuess.trim()} class="border border-red-500/40 hover:bg-red-500/10 text-red-400 px-6 py-3 rounded-xl font-bold disabled:opacity-50 transition-all w-full uppercase">{loading ? 'SUBMITTING...' : 'Submit Guess'}</button>
          </div>
        {/if}

        {#if attackResult}
          {@const isSuccess = !!attackResult.success}
          {@const isError = !!attackResult.error}
          <div class="p-4 rounded-xl border {isSuccess ? 'bg-green-500/10 border-green-500/50 text-green-400' : isError ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-amber-500/10 border-amber-500/50 text-amber-300'}">
            <div class="font-black text-lg mb-2">{isSuccess ? '✅ TARGET COMPROMISED!' : isError ? '⚠️ ATTACK ERROR' : '↻ ATTEMPT COMPLETE - KEEP PUSHING'}</div>
            <div class="text-sm opacity-90 font-medium">{attackResult.message || attackResult.error || 'No compromise yet. Refine your prompt and try again.'}</div>
            {#if attackResult.log}
              <div class="mt-3 text-xs bg-black/60 p-3 rounded-lg text-gray-300 font-mono max-h-44 overflow-y-auto border border-white/5">{attackResult.log}</div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
