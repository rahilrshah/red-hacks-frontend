<script lang="ts">
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabaseClient';
  import { onDestroy, onMount } from 'svelte';

  type EventRow = {
    id: string;
    type: 'attack' | 'defense';
    at: string;
    title: string;
    detail: string;
  };

  type TopPlayerRow = {
    userId: string;
    username: string;
    totalStolen: number;
    successfulAttacks: number;
  };

  let gameId = $derived($page.params.gameId ?? '');
  let gameName = $state('');
  let loading = $state(true);
  let statusError = $state('');

  let eventFeed = $state<EventRow[]>([]);
  let topPlayers = $state<TopPlayerRow[]>([]);
  let topTeams = $state<Array<{ id: string; name: string; coins: number }>>([]);

  let attacksCache = $state<any[]>([]);
  let defensesCache = $state<any[]>([]);

  function extractStolenCoins(logData: any) {
    const value = logData?.stolen_coins;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function formatDateTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function buildTopPlayers(rows: any[]) {
    const byUser = new Map<string, TopPlayerRow>();

    for (const row of rows) {
      if (!row?.is_successful || !row?.attacker_user_id) continue;

      const userId = row.attacker_user_id as string;
      const username = row.profiles?.username || `User ${userId.slice(0, 8)}`;
      const stolen = Math.max(0, extractStolenCoins(row.log));

      const existing = byUser.get(userId);
      if (existing) {
        existing.totalStolen += stolen;
        existing.successfulAttacks += 1;
      } else {
        byUser.set(userId, {
          userId,
          username,
          totalStolen: stolen,
          successfulAttacks: 1
        });
      }
    }

    return Array.from(byUser.values())
      .sort((a, b) => b.totalStolen - a.totalStolen || b.successfulAttacks - a.successfulAttacks)
      .slice(0, 10);
  }

  function buildEventFeed(attacks: any[], defenses: any[]) {
    const attackEvents: EventRow[] = (attacks ?? [])
      .filter((row: any) => row?.is_successful)
      .map((row: any) => {
        const attacker = row.profiles?.username || 'Unknown attacker';
        const defenderTeam = row.defended_challenge?.teams?.name || 'Unknown team';
        const challengeName = row.defended_challenge?.challenges?.model_name || 'Challenge';
        const stolen = extractStolenCoins(row.log);

        return {
          id: `attack-${row.id}`,
          type: 'attack',
          at: row.created_at,
          title: `${attacker} compromised ${defenderTeam}`,
          detail: `Successful attack on ${challengeName}. Stolen coins: ${stolen}.`
        };
      });

    const defenseEvents: EventRow[] = (defenses ?? []).map((row: any) => {
      const teamName = row.teams?.name || 'Unknown team';
      const challengeName = row.challenges?.model_name || 'Challenge';

      return {
        id: `defense-${row.id}`,
        type: 'defense',
        at: row.created_at,
        title: `${teamName} deployed a defense`,
        detail: `Configured defense for ${challengeName}.`
      };
    });

    return [...attackEvents, ...defenseEvents]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 100);
  }

  async function loadGameMeta() {
    const { data, error } = await supabase
      .from('games')
      .select('name')
      .eq('id', gameId)
      .maybeSingle();

    if (error) throw error;
    gameName = data?.name ?? 'Game';
  }

  async function loadAttacksAndTopPlayers() {
    const { data, error } = await supabase
      .from('attacks')
      .select('id, created_at, is_successful, attacker_user_id, log, profiles!attacks_attacker_user_id_fkey(username), defended_challenge:defended_challenges!inner(id, team_id, challenge_id, teams!inner(game_id, name), challenges!inner(model_name))')
      .eq('defended_challenge.teams.game_id', gameId)
      .order('created_at', { ascending: false })
      .limit(300);

    if (error) throw error;

    attacksCache = data ?? [];
    topPlayers = buildTopPlayers(attacksCache);
    eventFeed = buildEventFeed(attacksCache, defensesCache);
  }

  async function loadDefenses() {
    const { data, error } = await supabase
      .from('defended_challenges')
      .select('id, created_at, team_id, challenge_id, teams!inner(game_id, name), challenges!inner(model_name)')
      .eq('teams.game_id', gameId)
      .order('created_at', { ascending: false })
      .limit(300);

    if (error) throw error;

    defensesCache = data ?? [];
    eventFeed = buildEventFeed(attacksCache, defensesCache);
  }

  async function loadTopTeams() {
    const { data, error } = await supabase
      .from('teams')
      .select('id, name, coins')
      .eq('game_id', gameId)
      .order('coins', { ascending: false })
      .limit(10);

    if (error) throw error;
    topTeams = data ?? [];
  }

  async function loadAll() {
    loading = true;
    statusError = '';

    try {
      await loadGameMeta();
      await Promise.all([loadAttacksAndTopPlayers(), loadDefenses(), loadTopTeams()]);
    } catch (error: any) {
      statusError = error?.message || 'Could not load live events.';
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await loadAll();

    const attacksChannel = supabase
      .channel(`live-events-attacks-${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attacks' }, async () => {
        await loadAttacksAndTopPlayers();
      })
      .subscribe();

    const defensesChannel = supabase
      .channel(`live-events-defenses-${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'defended_challenges' }, async () => {
        await loadDefenses();
      })
      .subscribe();

    const teamsChannel = supabase
      .channel(`live-events-teams-${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `game_id=eq.${gameId}` }, async () => {
        await loadTopTeams();
      })
      .subscribe();

    onDestroy(() => {
      supabase.removeChannel(attacksChannel);
      supabase.removeChannel(defensesChannel);
      supabase.removeChannel(teamsChannel);
    });
  });
</script>

<div class="p-8 max-w-7xl mx-auto space-y-8">
  <div class="border-b border-white/10 pb-6">
    <a href={`/game/${gameId}`} class="inline-flex items-center text-sm text-gray-400 hover:text-white transition-colors mb-4">&larr; Back to Game Hub</a>
    <h1 class="text-4xl font-black tracking-tight text-white mb-2 flex items-center gap-3">
      <span class="text-red-500">📡</span> Live Events
    </h1>
    <p class="text-gray-400 text-lg">Real-time monitor for attacks, defenses, and leaderboards in {gameName}.</p>
  </div>

  {#if statusError}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">{statusError}</div>
  {/if}

  {#if loading}
    <div class="border border-white/10 bg-black/40 rounded-xl p-8 text-gray-300">Loading live event stream...</div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2 border border-white/10 bg-slate-900/50 rounded-xl overflow-hidden">
        <div class="p-4 border-b border-white/10 bg-black/40">
          <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Event Feed</h2>
        </div>
        {#if eventFeed.length === 0}
          <div class="p-6 text-gray-400">No events yet.</div>
        {:else}
          <div class="divide-y divide-white/5 max-h-144 overflow-y-auto">
            {#each eventFeed as event}
              <div class="p-4">
                <div class="flex items-center justify-between gap-3">
                  <p class="font-semibold {event.type === 'attack' ? 'text-red-300' : 'text-blue-300'}">{event.title}</p>
                  <p class="text-xs text-gray-500">{formatDateTime(event.at)}</p>
                </div>
                <p class="text-sm text-gray-300 mt-2">{event.detail}</p>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-6">
        <div class="border border-white/10 bg-slate-900/50 rounded-xl overflow-hidden">
          <div class="p-4 border-b border-white/10 bg-black/40">
            <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Top Players by Stolen Coins</h2>
          </div>
          {#if topPlayers.length === 0}
            <div class="p-4 text-gray-400 text-sm">No successful attacks yet.</div>
          {:else}
            <div class="divide-y divide-white/5">
              {#each topPlayers as player, index}
                <div class="p-4 flex items-center justify-between gap-3">
                  <div>
                    <p class="text-white font-semibold">#{index + 1} {player.username}</p>
                    <p class="text-xs text-gray-500 mt-1">Successful attacks: {player.successfulAttacks}</p>
                  </div>
                  <p class="text-red-300 font-bold">{player.totalStolen}</p>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="border border-white/10 bg-slate-900/50 rounded-xl overflow-hidden">
          <div class="p-4 border-b border-white/10 bg-black/40">
            <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Top Teams by Coins</h2>
          </div>
          {#if topTeams.length === 0}
            <div class="p-4 text-gray-400 text-sm">No team data yet.</div>
          {:else}
            <div class="divide-y divide-white/5">
              {#each topTeams as team, index}
                <div class="p-4 flex items-center justify-between gap-3">
                  <p class="text-white font-semibold">#{index + 1} {team.name}</p>
                  <p class="text-red-300 font-bold">{team.coins ?? 0}</p>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
