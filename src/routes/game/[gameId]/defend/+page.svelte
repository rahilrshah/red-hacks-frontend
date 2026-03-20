<script lang="ts">
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let gameId = $derived($page.params.gameId);
  let challenges = $state<any[]>([]);
  let defended = $state<any[]>([]);
  let loading = $state(false);
  let teamId = $state('');

  onMount(async () => {
    // Basic setup - fetch challenges and already defended ones
    const { data: c } = await supabase.from('challenges').select('*');
    if (c) challenges = c;

    // Get current user's team for this game
    const { data: user } = await supabase.auth.getUser();
    if (user.user) {
      const { data: member } = await supabase.from('team_members')
        .select('team_id, teams!inner(game_id)')
        .eq('user_id', user.user.id)
        .eq('teams.game_id', gameId)
        .single();
      
      if (member) {
        teamId = member.team_id;
        const { data: d } = await supabase.from('defended_challenges').select('*').eq('team_id', teamId);
        if (d) defended = d;
      }
    }
  });

  async function defendChallenge(challengeId: string) {
    // In a real app we'd open a modal. Doing it directly for simplicity.
    const prompt = window.prompt("Enter your system prompt to defend this challenge:");
    if (!prompt) return;

    const { data, error } = await supabase.from('defended_challenges').insert([{
      team_id: teamId,
      challenge_id: challengeId,
      system_prompt: prompt,
      lives_remaining: 3 // Should normally come from games.lives_per_challenge
    }]);

    if (!error) {
      alert("Defense deployed!");
      window.location.reload();
    } else {
      alert("Error: " + error.message);
    }
  }
</script>

<div class="p-8 max-w-4xl mx-auto space-y-8">
  <h1 class="text-3xl font-bold tracking-tight text-white">Blue Team: Defend Challenges</h1>
  <p class="text-gray-400">Select up to 5 challenges to protect. Write a robust system prompt to prevent attackers from finding the secret key or calling the forbidden tool.</p>

  <div class="grid grid-cols-1 gap-4 mt-8">
    {#each challenges as challenge}
      {@const isDefended = defended.find(d => d.challenge_id === challenge.id)}
      <div class="border border-white/10 bg-black/40 p-6 rounded-lg flex justify-between items-center">
        <div>
          <h3 class="text-xl font-bold text-white">{challenge.model_name} <span class="text-sm font-normal text-gray-400">({challenge.type})</span></h3>
          <p class="text-gray-400 mt-2">{challenge.description}</p>
          {#if isDefended}
            <div class="mt-4 p-3 bg-white/5 border border-white/10 rounded-md">
              <p class="text-xs text-red-500 font-bold mb-1">YOUR CURRENT SYSTEM PROMPT:</p>
              <p class="text-sm text-gray-300 font-mono">"{isDefended.system_prompt}"</p>
              <div class="mt-2 text-xs text-gray-500">Lives Remaining: {isDefended.lives_remaining}</div>
            </div>
          {/if}
        </div>
        
        <div class="ml-6 flex-shrink-0">
          {#if isDefended}
            <button class="bg-gray-700 text-gray-300 px-4 py-2 rounded-md font-bold cursor-not-allowed">DEFENDED</button>
          {:else}
            <button onclick={() => defendChallenge(challenge.id)} class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-bold transition">DEPLOY DEFENSE</button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
