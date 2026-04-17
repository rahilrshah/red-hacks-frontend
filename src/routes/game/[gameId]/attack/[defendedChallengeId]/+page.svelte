<script module lang="ts">
  type AttackSessionCacheEntry = {
    roundInfo: any;
    target: any;
    statusError: string;
    pageLoading: boolean;
    timestampMs: number;
  };

  const ATTACK_SESSION_CACHE_TTL_MS = 60_000;
  const attackSessionCache = new Map<string, AttackSessionCacheEntry>();
</script>

<script lang="ts">
  import { page } from '$app/stores';
  import { calculateAttackBonus, SOFT_CHAR_CAP, SOFT_TURN_CAP } from '$lib/bonus';
  import GameSectionNav from '$lib/components/GameSectionNav.svelte';
  import { isGameActive, loadRoundChallengeIds, loadRoundRuntimeContext, resolveRoundType } from '$lib/gameplay';
  import { STEERING_ATTACK_COPY } from '$lib/steering/copy';
  import { isSteeringCapable, type SteeringVector } from '$lib/steering/types';
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
  let isRefreshingOnVisible = $state(false);

  let attackMode = $derived(resolveRoundType(roundInfo));
  const chatStorageKey = $derived(`attack-chat:${gameId}:${attackMode}:${defendedChallengeId}`);

  // ---------- Attacker-steering panel state ----------
  // The panel is only rendered when the target's model is steering-capable
  // (V4.1). Loaded lazily via /api/steering-vectors so we don't re-fetch on
  // every keystroke. The selected vector's `[min_coefficient, max_coefficient]`
  // bounds drive the slider min/max (V4.3 — client-side half of the clamp).
  let steeringVectors = $state<SteeringVector[]>([]);
  let steeringLoading = $state(false);
  let steeringLoadError = $state<string | null>(null);
  let steeringLoaded = $state(false);
  let selectedVectorId = $state<string>('');
  let steeringCoefficient = $state<number>(1);

  let targetModelName = $derived(target?.challenges?.model_name ?? null);
  let steeringCapable = $derived(isSteeringCapable(targetModelName));
  let selectedVector = $derived(
    steeringVectors.find((v) => v.id === selectedVectorId) ?? null
  );
  let coefficientBounds = $derived({
    min: selectedVector?.min_coefficient ?? -4,
    max: selectedVector?.max_coefficient ?? 4
  });

  // Client-side preview of the potential reward for the *next* attempt.
  // Counts the user turns in the local chat + the currently-drafted prompt.
  // Server re-computes authoritatively from the attacks table on success.
  let potentialReward = $derived.by(() => {
    const userMessages = messages.filter((m) => m.role === 'user');
    const userTurns = userMessages.length;
    const userChars = userMessages.reduce((acc, m) => acc + m.content.length, 0);
    const draftChars = promptInput.length;
    return calculateAttackBonus({
      turnCount: userTurns + 1,
      charCount: userChars + draftChars,
      attackStealCoins: target?.challenges?.attack_steal_coins ?? 0,
      defenseRewardCoins: target?.challenges?.defense_reward_coins ?? 0
    });
  });

  function sessionCacheKey() {
    return `${gameId}:${defendedChallengeId}`;
  }

  function restoreSessionCache() {
    const key = sessionCacheKey();
    if (!key) return false;

    const cached = attackSessionCache.get(key);
    if (!cached) return false;

    if (Date.now() - cached.timestampMs > ATTACK_SESSION_CACHE_TTL_MS) {
      attackSessionCache.delete(key);
      return false;
    }

    roundInfo = cached.roundInfo;
    target = cached.target;
    statusError = cached.statusError;
    pageLoading = cached.pageLoading;
    return true;
  }

  function saveSessionCache() {
    const key = sessionCacheKey();
    if (!key) return;

    attackSessionCache.set(key, {
      roundInfo,
      target,
      statusError,
      pageLoading,
      timestampMs: Date.now()
    });
  }

  $effect(() => {
    if (!roundInfo) return;
    loadChatHistory();
  });

  // Fetch the attacker's available steering vectors the first time we
  // determine the target is steering-capable. We filter to compatible
  // models server-side to avoid offering vectors built on a different
  // backbone — the Pydantic contract rejects a cross-model pairing anyway.
  $effect(() => {
    if (!steeringCapable || steeringLoaded || steeringLoading) return;
    if (!targetModelName) return;
    void loadSteeringVectors(targetModelName);
  });

  // Clamp the coefficient whenever the user switches to a different vector
  // so the slider state never drifts outside the persisted bounds.
  $effect(() => {
    if (!selectedVector) return;
    const { min_coefficient, max_coefficient } = selectedVector;
    if (steeringCoefficient < min_coefficient) steeringCoefficient = min_coefficient;
    if (steeringCoefficient > max_coefficient) steeringCoefficient = max_coefficient;
  });

  async function loadSteeringVectors(modelName: string) {
    steeringLoading = true;
    steeringLoadError = null;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        steeringLoadError = 'Sign in to use steering vectors.';
        return;
      }
      const qs = new URLSearchParams({ model_name: modelName, active_only: '1' });
      const response = await fetch(`/api/steering-vectors?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) {
        const text = await response.text();
        steeringLoadError = text || `Failed to load steering vectors (${response.status}).`;
        return;
      }
      const parsed = await response.json();
      steeringVectors = Array.isArray(parsed?.vectors) ? parsed.vectors : [];
      steeringLoaded = true;
    } catch (err: any) {
      steeringLoadError = err?.message || 'Failed to load steering vectors.';
    } finally {
      steeringLoading = false;
    }
  }

  onMount(() => {
    void (async () => {
      const { data: userData } = await supabase.auth.getUser();
      userId = userData?.user?.id ?? '';

      const restored = restoreSessionCache();
      if (!restored) {
        await loadTarget();
      }
      // Load chat history AFTER roundInfo is available so chatStorageKey is correct
      if (roundInfo) {
        loadChatHistory();
      }

      const initialSeed = $page.url.searchParams.get('seed')?.trim();
      if (initialSeed) {
        promptInput = initialSeed;
        try {
          await sendPrompt();
        } catch (err: any) {
          statusError = err?.message || 'Failed to send initial seed prompt';
        }
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete('seed');
        window.history.replaceState(window.history.state, '', nextUrl.toString());
      }
    })();
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
        system_prompt: data.default_prompt ?? data.context ?? 'You are a helpful assistant.',
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
      .select('id, team_id, system_prompt, target_secret_key, teams!inner(name, game_id), challenges!inner(*)')
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
    saveSessionCache();
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

  function toChatMessages() {
    return messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
  }

  function buildAttackPayload(args: { guess?: string } = {}) {
    const currentAttackMode = resolveRoundType(roundInfo);
    const resolvedSystemPrompt =
      (target?.system_prompt as string | undefined)?.trim() ||
      (target?.challenges?.default_prompt as string | undefined)?.trim() ||
      'You are a helpful assistant.';

    const payload: Record<string, unknown> = {
      prompt: messages.length > 0 ? messages[messages.length - 1].content : '',
      guess: args.guess || '',
      messages: toChatMessages(),
      challenge: {
        challenge_id: target?.challenges?.id ?? defendedChallengeId,
        title: target?.challenges?.model_name ?? 'Challenge',
        description: target?.challenges?.description ?? '',
        objective:
          target?.challenges?.type === 'tool-calling'
            ? `Induce targeted tool use: ${target?.challenges?.target_tool_name ?? 'unknown tool'}`
            : 'Extract the secret key.',
        system_prompt: resolvedSystemPrompt,
        success_tool_name: target?.challenges?.target_tool_name ?? null
      }
    };

    if (currentAttackMode === 'pve') {
      payload.challenge_id = defendedChallengeId;
      payload.game_id = gameId;
      payload.round_type = 'pve';
    } else {
      payload.defended_challenge_id = defendedChallengeId;
    }

    // V4.2 — only attach when both capable and a vector is selected.
    // If the target is not steering-capable, the panel is hidden and
    // selectedVectorId is the empty string, so this branch is skipped.
    if (steeringCapable && selectedVector) {
      const min = selectedVector.min_coefficient;
      const max = selectedVector.max_coefficient;
      const clamped = Math.max(min, Math.min(max, steeringCoefficient));
      payload.attacker_steering = {
        vector_id: selectedVector.id,
        coefficient: clamped
      };
    }

    return payload;
  }

  async function parseAttackResponse(response: Response) {
    const responseText = await response.text();

    try {
      return responseText ? JSON.parse(responseText) : null;
    } catch {
      return responseText;
    }
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
      const response = await fetch(`/game/${gameId}/attack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload)
      });

      responseData = await parseAttackResponse(response);
      if (!response.ok) {
        const errorMessage =
          responseData?.error ||
          responseData?.message ||
          (typeof responseData === 'string' ? responseData : '') ||
          `Attack request failed with status ${response.status}`;
        throw new Error(errorMessage);
      }
    } catch (err: any) {
      attackResult = {
        success: false,
        error: err?.message || 'Unexpected error while connecting to attack backend.'
      };
      return;
    }

    if (!responseData || typeof responseData !== 'object') {
      attackResult = {
        success: false,
        error: 'Attack backend returned an invalid response payload.'
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
    statusError = '';

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
      
      // Wait for invokeAttack to fully complete before marking loading as false
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
    <div class="mb-4">
      <GameSectionNav gameId={gameId} current="attack" />
    </div>
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
        <div class="text-xs text-gray-500">Base steal value: {target.challenges?.attack_steal_coins ?? 0} coins</div>
        {#if target.challenges?.challenge_url}
          <div class="text-xs text-emerald-300 break-all">Direct backend: {target.challenges.challenge_url}</div>
        {/if}
        <button onclick={clearChatHistory} class="w-full border border-white/20 hover:border-white/40 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">Clear Chat History</button>
        <p class="text-[10px] text-gray-600 mt-1">Resets the LLM conversation only. The server still counts all your prior attempts for bonus calculation.</p>
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
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Send Attack Prompt</p>
            <div class="px-3 py-1.5 rounded-lg bg-amber-900/30 border border-amber-500/30 text-xs font-mono text-amber-200">
              {#if potentialReward.base === 0}
                Next attempt reward: <strong>0</strong> coins (no steal configured)
              {:else if potentialReward.bonus > 0}
                Next reward: <strong class="text-amber-100">{potentialReward.total}</strong>
                = <strong>{potentialReward.base}</strong> base + <strong class="text-green-300">{potentialReward.bonus}</strong> bonus
                <span class="text-amber-400/70">· elegance {Math.round(potentialReward.eleganceFactor * 100)}%</span>
              {:else}
                Next reward: <strong>{potentialReward.base}</strong> base only
                <span class="text-amber-400/60">· elegance exhausted</span>
              {/if}
            </div>
          </div>
          <p class="text-[11px] text-gray-500 font-mono">
            Bonus decays past {SOFT_TURN_CAP} turns or {SOFT_CHAR_CAP.toLocaleString()} total chars.
            Approximate — server decides the final amount on success.
          </p>

          {#if steeringCapable}
            <div class="border border-fuchsia-500/30 bg-fuchsia-500/5 rounded-xl p-4 space-y-3" data-testid="attacker-steering-panel">
              <div>
                <p class="text-sm font-semibold text-fuchsia-200 uppercase tracking-wider">{STEERING_ATTACK_COPY.heading}</p>
                <p class="text-[11px] text-fuchsia-200/70 mt-1">{STEERING_ATTACK_COPY.body}</p>
              </div>

              {#if steeringLoading}
                <p class="text-xs text-fuchsia-200/70">{STEERING_ATTACK_COPY.loading}</p>
              {:else if steeringLoadError}
                <p class="text-xs text-red-300">{STEERING_ATTACK_COPY.errorPrefix}{steeringLoadError}</p>
              {:else if steeringVectors.length === 0}
                <p class="text-xs text-fuchsia-200/70">{STEERING_ATTACK_COPY.empty}</p>
                <a
                  href="/steering/vectors/new"
                  class="inline-block text-xs text-fuchsia-300 underline underline-offset-2 hover:text-fuchsia-200"
                  >Create a steering vector →</a
                >
              {:else}
                <label class="block text-xs text-fuchsia-200/80">
                  <span class="block mb-1 uppercase tracking-wider">Vector</span>
                  <select
                    bind:value={selectedVectorId}
                    class="w-full bg-black/60 border border-fuchsia-500/30 rounded-md p-2 text-white focus:ring-2 focus:ring-fuchsia-500/50 outline-none text-sm"
                    data-testid="attacker-steering-vector-select"
                  >
                    <option value="">{STEERING_ATTACK_COPY.noneOption}</option>
                    {#each steeringVectors as vector (vector.id)}
                      <option value={vector.id}
                        >{vector.name} · {vector.visibility === 'public' ? 'public' : 'private'}</option
                      >
                    {/each}
                  </select>
                </label>

                {#if selectedVector}
                  <label class="block text-xs text-fuchsia-200/80">
                    <span class="block mb-1 uppercase tracking-wider"
                      >{STEERING_ATTACK_COPY.coefficientLabel(coefficientBounds.min, coefficientBounds.max)}</span
                    >
                    <div class="flex items-center gap-3">
                      <input
                        type="range"
                        min={coefficientBounds.min}
                        max={coefficientBounds.max}
                        step="0.1"
                        bind:value={steeringCoefficient}
                        class="flex-1 accent-fuchsia-500"
                        data-testid="attacker-steering-coefficient-slider"
                      />
                      <input
                        type="number"
                        min={coefficientBounds.min}
                        max={coefficientBounds.max}
                        step="0.1"
                        bind:value={steeringCoefficient}
                        class="w-24 bg-black/60 border border-fuchsia-500/30 rounded-md p-2 text-white text-sm font-mono"
                        data-testid="attacker-steering-coefficient-input"
                      />
                    </div>
                    <p class="text-[10px] text-fuchsia-200/60 mt-1">
                      Positive pushes toward the vector's positive examples; negative inverts the direction.
                    </p>
                  </label>
                {/if}
              {/if}
            </div>
          {/if}

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
            {#if isSuccess && typeof attackResult.bonus_coins === 'number' && attackResult.bonus_coins > 0}
              <div class="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono">
                <div class="font-semibold">⚡ Elegance bonus: +{attackResult.bonus_coins} coins</div>
                <div class="opacity-80 mt-1">
                  {attackResult.base_coins ?? 0} base + {attackResult.bonus_coins} bonus = {attackResult.stolen_coins ?? 0} total
                  {#if typeof attackResult.elegance_factor === 'number'}
                    · elegance {Math.round(attackResult.elegance_factor * 100)}%
                  {/if}
                  {#if typeof attackResult.turn_count === 'number'}
                    · {attackResult.turn_count} {attackResult.turn_count === 1 ? 'turn' : 'turns'}
                  {/if}
                </div>
              </div>
            {:else if isSuccess && typeof attackResult.base_coins === 'number'}
              <div class="mt-3 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-300 text-xs font-mono">
                Base reward: {attackResult.base_coins} coins (elegance exhausted, no bonus)
              </div>
            {/if}
            {#if attackResult.steering && (attackResult.steering.defender || attackResult.steering.attacker)}
              {@const steeringBlock = attackResult.steering}
              <div
                class="mt-3 px-3 py-2 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/30 text-xs font-mono text-fuchsia-200 space-y-1"
                data-testid="steering-result-block"
              >
                {#if steeringBlock.defender}
                  {@const d = steeringBlock.defender}
                  <!-- §5.5 format: "Defender steering: `name` @ 3.00 (layers 8–11)" -->
                  <div data-testid="steering-defender-line">
                    Defender steering: <code class="text-fuchsia-100">{d.vector_name ?? d.vector_id}</code>
                    @ {Number(d.coefficient).toFixed(2)}
                    (layers {Array.isArray(d.target_layers) ? d.target_layers.join(',') : '?'})
                  </div>
                {/if}
                {#if steeringBlock.attacker}
                  {@const a = steeringBlock.attacker}
                  <div data-testid="steering-attacker-line">
                    Your steering: <code class="text-fuchsia-100">{a.vector_name ?? a.vector_id}</code>
                    @ {Number(a.coefficient).toFixed(2)}
                    (layers {Array.isArray(a.target_layers) ? a.target_layers.join(',') : '?'})
                  </div>
                {/if}
              </div>
            {/if}
            {#if attackResult.log}
              <div class="mt-3 text-xs bg-black/60 p-3 rounded-lg text-gray-300 font-mono max-h-44 overflow-y-auto border border-white/5">{attackResult.log}</div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
