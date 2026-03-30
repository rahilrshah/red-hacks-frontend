<script lang="ts">
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let gameId = $derived($page.params.gameId);
  let challenges = $state<any[]>([]);
  let defended = $state<any[]>([]);
  let loading = $state(true);
  let teamId = $state('');
  let statusError = $state('');

  onMount(async () => {
    await loadPage();
  });

  async function loadPage() {
    loading = true;
    statusError = '';

    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      statusError = 'You must be signed in to configure defenses.';
      loading = false;
      return;
    }

    const { data: member, error: memberError } = await supabase
      .from('team_members')
      .select('team_id, teams!inner(game_id)')
      .eq('user_id', userData.user.id)
      .eq('teams.game_id', gameId)
      .single();

    if (memberError || !member) {
      statusError = 'Could not find your team for this game.';
      loading = false;
      return;
    }

    teamId = member.team_id;

    const [{ data: gameChallengeRows }, { data: defendedRows }] = await Promise.all([
      supabase
        .from('game_challenges')
        .select('challenge_id, challenges!inner(id, model_name, description, type, defense_reward_coins, attack_steal_coins, created_at)')
        .eq('game_id', gameId),
      supabase
        .from('defended_challenges')
        .select('id, challenge_id, system_prompt, is_active, created_at')
        .eq('team_id', teamId)
    ]);

    challenges = (gameChallengeRows ?? [])
      .map((row: any) => row.challenges)
      .filter((row: any) => !!row)
      .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    defended = defendedRows ?? [];

    loading = false;
  }
</script>

<div class="p-8 max-w-7xl mx-auto space-y-8">
  <div class="border-b border-white/10 pb-6">
    <h1 class="text-4xl font-black tracking-tight text-white mb-2">Blue Team: Defense Console</h1>
    <p class="text-gray-400 text-lg">Choose a challenge to open its dedicated defense options page.</p>
  </div>

  {#if loading}
    <div class="border border-white/10 bg-black/40 rounded-xl p-8 text-gray-300">Loading challenges...</div>
  {:else if statusError && !teamId}
    <div class="border border-red-500/40 bg-red-500/10 rounded-xl p-6 text-red-300">{statusError}</div>
  {:else}
    <div class="border border-white/10 bg-slate-900/50 rounded-xl overflow-hidden">
      <div class="p-4 border-b border-white/10 bg-black/40">
        <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Challenges</h2>
      </div>
      {#if challenges.length === 0}
        <div class="p-6 text-gray-400">No challenges are available for this game yet.</div>
      {:else}
        <div class="divide-y divide-white/5">
          {#each challenges as challenge}
            {@const challengeDefense = defended.find((d) => d.challenge_id === challenge.id)}
            <a
              href={`/game/${gameId}/defend/${challenge.id}`}
              class="block p-5 hover:bg-white/5 transition"
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div class="font-semibold text-white">{challenge.model_name}</div>
                  <div class="text-xs text-gray-400 mt-1">{challenge.type}</div>
                </div>
                <div class="text-xs">
                  {#if challengeDefense}
                    <span class="text-emerald-300">Deployed • +{challenge.defense_reward_coins ?? 0} defense coins</span>
                  {:else}
                    <span class="text-gray-500">Not defended yet</span>
                  {/if}
                </div>
              </div>
              <div class="text-xs text-gray-500 mt-2">Steal value if breached: {challenge.attack_steal_coins ?? 0} coins</div>
              <div class="text-sm text-gray-500 mt-3">{challenge.description}</div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
