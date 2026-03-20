<script lang="ts">
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let gameId = $derived($page.params.gameId);
  let challenges = $state<any[]>([]);
  let selectedChallengeId = $state('');
  let attackPrompt = $state('');
  let secretKeyGuess = $state('');
  let loading = $state(false);
  let attackResult = $state<any>(null);

  onMount(async () => {
    // Fetch challenges currently defended by other teams
    const { data } = await supabase
      .from('defended_challenges')
      .select('id, lives_remaining, teams(name), challenges(id, description, type, model_name)')
      .eq('is_active', true)
      .gt('lives_remaining', 0);
      
    if (data) challenges = data;
  });

  async function performAttack() {
    loading = true;
    attackResult = null;

    const { data: user } = await supabase.auth.getUser();

    // In a real implementation this should call a Supabase Edge Function to securely
    // combine the system prompt and call the LLM to prevent leaking.
    try {
      const response = await fetch('/api/attack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defended_challenge_id: selectedChallengeId,
          attacker_user_id: user?.user?.id,
          prompt: attackPrompt,
          guess: secretKeyGuess
        })
      });

      attackResult = await response.json();
    } catch (e) {
      attackResult = { error: 'Failed to connect to attack server' };
    }

    loading = false;
  }
</script>

<div class="p-8 max-w-4xl mx-auto space-y-8">
  <h1 class="text-3xl font-bold tracking-tight text-white mb-2">Red Team: Attack Interface</h1>
  <p class="text-gray-400">Select an opponent's defended challenge to attack. Bypass their system prompt to extract the secret key or trigger the forbidden tool!</p>
  
  <div class="grid grid-cols-3 gap-6">
    <div class="col-span-1 border border-white/10 bg-black/40 rounded-lg overflow-hidden h-[500px] overflow-y-auto">
      <div class="p-4 border-b border-white/10 bg-white/5 top-0 sticky">
        <h2 class="text-sm font-bold text-gray-400 uppercase">Available Targets</h2>
      </div>
      <div class="divide-y divide-white/5">
        {#each challenges as target}
          <button 
            class="w-full text-left p-4 hover:bg-white/5 transition block {selectedChallengeId === target.id ? 'bg-red-500/10 border-l-2 border-red-500' : 'border-l-2 border-transparent'}"
            onclick={() => selectedChallengeId = target.id}
          >
            <div class="font-bold text-white mb-1">{target.teams?.name}</div>
            <div class="text-xs text-gray-400 mb-2 truncate">{target.challenges?.model_name} • {target.challenges?.type}</div>
            <div class="flex items-center space-x-1">
              {#each Array(target.lives_remaining) as _}
                <div class="w-2 h-2 rounded-full bg-red-500"></div>
              {/each}
            </div>
          </button>
        {/each}
      </div>
    </div>

    <div class="col-span-2 border border-white/10 bg-black/40 rounded-lg p-6 flex flex-col">
      {#if selectedChallengeId}
        {@const selected = challenges.find(c => c.id === selectedChallengeId)}
        <div class="mb-4 pb-4 border-b border-white/10">
          <h2 class="text-xl font-bold text-white mb-1">Attacking: {selected.teams?.name}</h2>
          <p class="text-sm text-gray-400">{selected.challenges?.description}</p>
        </div>

        <div class="flex-1 space-y-4">
          <div class="space-y-2">
            <label class="text-sm text-gray-400">Your Attack Prompt (User Message)</label>
            <textarea 
              bind:value={attackPrompt} 
              class="w-full bg-white/5 border border-white/10 rounded-md p-3 text-white h-40 focus:border-red-500 focus:outline-none transition" 
              placeholder="Ignore previous instructions..."></textarea>
          </div>

          {#if selected.challenges?.type === 'secret-key'}
            <div class="space-y-2">
              <label class="text-sm text-gray-400">Secret Key Guess</label>
              <input 
                bind:value={secretKeyGuess} 
                class="w-full bg-white/5 border border-white/10 rounded-md p-3 text-white focus:border-red-500 focus:outline-none transition" 
                placeholder="Enter the secret word if you found it..." />
            </div>
          {/if}
        </div>

        <div class="mt-6 pt-4 border-t border-white/10 flex justify-between items-center">
          <button 
            onclick={performAttack} 
            disabled={loading || !attackPrompt} 
            class="bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-md font-bold disabled:opacity-50 transition w-full"
          >
            {loading ? 'Executing Attack...' : 'LAUNCH ATTACK'}
          </button>
        </div>

        {#if attackResult}
          <div class="mt-4 p-4 rounded bg-white/5 border {attackResult.success ? 'border-green-500 text-green-400' : 'border-red-500 text-red-500'}">
            <div class="font-bold mb-1">{attackResult.success ? 'TARGET COMPROMISED!' : 'ATTACK FAILED'}</div>
            <div class="text-sm">{attackResult.message || attackResult.error}</div>
            {#if attackResult.log}
              <div class="mt-2 text-xs bg-black/50 p-2 rounded text-gray-300 font-mono h-24 overflow-y-auto">
                {attackResult.log}
              </div>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="flex-1 flex items-center justify-center text-gray-500">
          Select a target from the list to begin.
        </div>
      {/if}
    </div>
  </div>
</div>
