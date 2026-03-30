<script lang="ts">
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  type AttackMessage = {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  };

  let gameId = $derived($page.params.gameId);
  let defendedChallengeId = $derived($page.params.defendedChallengeId);

  let target = $state<any>(null);
  let messages = $state<AttackMessage[]>([]);
  let promptInput = $state('');
  let secretKeyGuess = $state('');
  let loading = $state(false);
  let pageLoading = $state(true);
  let attackResult = $state<any>(null);
  let userId = $state('');
  let statusError = $state('');

  const chatStorageKey = $derived(`attack-chat:${defendedChallengeId}`);

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

    const { data, error } = await supabase
      .from('defended_challenges')
      .select('id, team_id, teams!inner(name, game_id), challenges!inner(id, model_name, description, type, attack_steal_coins)')
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

  async function invokeAttack(args: { guess?: string } = {}) {
    if (!target || !userId) {
      attackResult = { error: 'You must be signed in and have a valid target selected.' };
      return;
    }

    console.log('Starting attack')
    const { data, error } = await supabase.functions.invoke('attack', {
      body: {
        defended_challenge_id: defendedChallengeId,
        prompt: messages.length > 0 ? messages[messages.length - 1].content : '',
        guess: args.guess || '',
        messages: toChatMessages()
      }
    });

    if (error) {
      const parsedError = await parseFunctionError(error);
      attackResult = { error: parsedError, success: false };
      return;
    }

    attackResult = data;

    if (data?.assistant) {
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: data.assistant,
          timestamp: new Date().toISOString()
        }
      ];
      persistChatHistory();
    }
  }

  async function sendPrompt() {
    console.log('Sending prompt:', promptInput);
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
      console.log('Attack result:', attackResult);
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
      <p class="text-gray-400 text-lg">Target team: <span class="text-red-400 font-semibold">{target.teams?.name}</span> • Challenge: <span class="text-white font-semibold">{target.challenges?.model_name}</span></p>
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
        <button onclick={clearChatHistory} class="w-full border border-white/20 hover:border-white/40 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors">Clear Chat History</button>
      </div>

      <div class="col-span-1 md:col-span-2 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl p-6 space-y-5">
        <div class="border border-white/10 bg-black/40 rounded-lg h-[360px] overflow-y-auto p-4 space-y-3">
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
