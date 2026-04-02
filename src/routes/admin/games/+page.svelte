<script lang="ts">
  import { isGameActive } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  type RoundDraft = {
    round_index: number;
    name: string;
    type: 'pvp' | 'pve';
    required_defenses: number;
    duration_minutes: number;
    intermission_minutes: number;
    available_challenges: string[];
  };

  let games = $state<any[]>([]);
  let teams = $state<any[]>([]);
  let name = $state('');
  let start_time = $state('');
  let end_time = $state('');
  let startTimeInput = $state<HTMLInputElement | null>(null);
  let challenges_per_team = $state(5);
  let allChallenges = $state<any[]>([]);
  let selectedChallengeIds = $state<string[]>([]);
  let roundName = $state('Round 1');
  let roundType = $state<'pvp' | 'pve'>('pvp');
  let roundRequiredDefenses = $state(1);
  let roundDurationMinutes = $state(60);
  let roundIntermissionMinutes = $state(5);
  let roundChallengeIds = $state<string[]>([]);
  let roundDrafts = $state<RoundDraft[]>([]);
  let loading = $state(false);
  let errorMsg = $state('');
  let selectedGameId = $state('');
  let teamLoading = $state(false);
  let teamMessage = $state('');
  let teamError = $state(false);
  let challengeEditorGameId = $state('');
  let editorSelectedChallengeIds = $state<string[]>([]);
  let challengeEditorLoading = $state(false);
  let challengeEditorMessage = $state('');
  let challengeEditorError = $state(false);
  let draftScheduleSummary = $derived(validateScheduleFit(roundDrafts));
  let draftTimelineItems = $derived(buildDraftTimeline(roundDrafts));

  onMount(async () => {
    await fetchChallenges();
    await fetchGames();
  });

  function allChallengeIds() {
    return allChallenges.map((challenge) => challenge.id);
  }

  function resetRoundDraftFields() {
    roundName = `Round ${roundDrafts.length + 1}`;
    roundType = 'pvp';
    roundRequiredDefenses = challenges_per_team;
    roundDurationMinutes = 60;
    roundIntermissionMinutes = 5;
    roundChallengeIds = allChallengeIds();
  }

  function toggleChallengeSelection(challengeId: string) {
    if (selectedChallengeIds.includes(challengeId)) {
      selectedChallengeIds = selectedChallengeIds.filter((id) => id !== challengeId);
    } else {
      selectedChallengeIds = [...selectedChallengeIds, challengeId];
    }
  }

  function toggleRoundChallengeSelection(challengeId: string) {
    if (roundChallengeIds.includes(challengeId)) {
      roundChallengeIds = roundChallengeIds.filter((id) => id !== challengeId);
    } else {
      roundChallengeIds = [...roundChallengeIds, challengeId];
    }
  }

  function computeGameWindowMinutes(startIsoLike: string, endIsoLike: string): number | null {
    if (!startIsoLike || !endIsoLike) {
      return null;
    }

    const startMs = new Date(startIsoLike).getTime();
    const endMs = new Date(endIsoLike).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      return null;
    }

    return Math.floor((endMs - startMs) / 60000);
  }

  function computePlannedRoundMinutes(rounds: RoundDraft[]) {
    return rounds.reduce((total, round) => {
      const duration = Math.max(1, Math.trunc(Number(round.duration_minutes) || 0));
      const intermission = Math.max(0, Math.trunc(Number(round.intermission_minutes) || 0));
      return total + duration + intermission;
    }, 0);
  }

  function toDateTimeLocalString(epochMs: number) {
    const date = new Date(epochMs);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function computeRoundsBasedEndTime(startIsoLike: string, rounds: RoundDraft[]): string | null {
    if (!startIsoLike || rounds.length === 0) {
      return null;
    }

    const startMs = new Date(startIsoLike).getTime();
    if (Number.isNaN(startMs)) {
      return null;
    }

    const plannedMinutes = computePlannedRoundMinutes(rounds);
    const endMs = startMs + plannedMinutes * 60000;
    return toDateTimeLocalString(endMs);
  }

  function effectiveEndTimeForValidation(rounds: RoundDraft[]) {
    return computeRoundsBasedEndTime(start_time, rounds) ?? end_time;
  }

  function validateScheduleFit(rounds: RoundDraft[]) {
    const availableMinutes = computeGameWindowMinutes(start_time, effectiveEndTimeForValidation(rounds));
    const plannedMinutes = computePlannedRoundMinutes(rounds);

    if (availableMinutes === null) {
      return {
        ok: true,
        availableMinutes,
        plannedMinutes,
        message: ''
      };
    }

    if (plannedMinutes > availableMinutes) {
      return {
        ok: false,
        availableMinutes,
        plannedMinutes,
        message: `Round schedule exceeds game window by ${plannedMinutes - availableMinutes} minute(s).`
      };
    }

    return {
      ok: true,
      availableMinutes,
      plannedMinutes,
      message: ''
    };
  }

  function buildDraftTimeline(rounds: RoundDraft[]) {
    if (!start_time) {
      return [] as Array<{ label: string; startLabel: string; endLabel: string; type: 'round' | 'intermission' }>;
    }

    const startMs = new Date(start_time).getTime();
    if (Number.isNaN(startMs)) {
      return [] as Array<{ label: string; startLabel: string; endLabel: string; type: 'round' | 'intermission' }>;
    }

    let cursorMs = startMs;
    const items: Array<{ label: string; startLabel: string; endLabel: string; type: 'round' | 'intermission' }> = [];

    for (const round of rounds) {
      const durationMinutes = Math.max(1, Math.trunc(Number(round.duration_minutes) || 0));
      const intermissionMinutes = Math.max(0, Math.trunc(Number(round.intermission_minutes) || 0));

      const roundStartMs = cursorMs;
      const roundEndMs = roundStartMs + durationMinutes * 60000;

      items.push({
        label: `Round ${round.round_index + 1}: ${round.name}`,
        startLabel: new Date(roundStartMs).toLocaleString(),
        endLabel: new Date(roundEndMs).toLocaleString(),
        type: 'round'
      });

      if (intermissionMinutes > 0) {
        const intermissionEndMs = roundEndMs + intermissionMinutes * 60000;
        items.push({
          label: `Intermission (${intermissionMinutes}m)`,
          startLabel: new Date(roundEndMs).toLocaleString(),
          endLabel: new Date(intermissionEndMs).toLocaleString(),
          type: 'intermission'
        });
        cursorMs = intermissionEndMs;
      } else {
        cursorMs = roundEndMs;
      }
    }

    return items;
  }

  function addRoundDraft() {
    const trimmedName = roundName.trim();
    const normalizedRequiredDefenses = Number(roundRequiredDefenses);
    const normalizedDuration = Number(roundDurationMinutes);
    const normalizedIntermission = Number(roundIntermissionMinutes);

    if (!trimmedName) {
      errorMsg = 'Round name cannot be empty.';
      return;
    }

    if (!Number.isInteger(normalizedRequiredDefenses) || normalizedRequiredDefenses <= 0) {
      errorMsg = 'Required defenses must be a positive whole number.';
      return;
    }

    if (normalizedRequiredDefenses > roundChallengeIds.length) {
      errorMsg = 'Required defenses cannot be greater than the number of selected round challenges.';
      return;
    }

    if (!Number.isInteger(normalizedDuration) || normalizedDuration <= 0) {
      errorMsg = 'Duration must be a positive whole number of minutes.';
      return;
    }

    if (!Number.isInteger(normalizedIntermission) || normalizedIntermission < 0) {
      errorMsg = 'Intermission must be a non-negative whole number of minutes.';
      return;
    }

    if (roundChallengeIds.length === 0) {
      errorMsg = 'Select at least one challenge for this round.';
      return;
    }

    const nextDrafts: RoundDraft[] = [
      ...roundDrafts,
      {
        round_index: roundDrafts.length,
        name: trimmedName,
        type: roundType,
        required_defenses: normalizedRequiredDefenses,
        duration_minutes: normalizedDuration,
        intermission_minutes: normalizedIntermission,
        available_challenges: Array.from(new Set(roundChallengeIds))
      }
    ];

    const scheduleCheck = validateScheduleFit(nextDrafts);
    if (!scheduleCheck.ok) {
      errorMsg = scheduleCheck.message;
      return;
    }

    roundDrafts = nextDrafts;

    errorMsg = '';
    resetRoundDraftFields();
  }

  function removeRoundDraft(roundIndex: number) {
    roundDrafts = roundDrafts
      .filter((draft) => draft.round_index !== roundIndex)
      .map((draft, index) => ({
        ...draft,
        round_index: index
      }));
  }

  function clearRoundDrafts() {
    roundDrafts = [];
    resetRoundDraftFields();
  }

  function toggleEditorChallengeSelection(challengeId: string) {
    if (editorSelectedChallengeIds.includes(challengeId)) {
      editorSelectedChallengeIds = editorSelectedChallengeIds.filter((id) => id !== challengeId);
    } else {
      editorSelectedChallengeIds = [...editorSelectedChallengeIds, challengeId];
    }
  }

  async function fetchChallenges() {
    const { data, error } = await supabase
      .from('challenges')
      .select('id, model_name, type, description')
      .order('created_at', { ascending: true });

    if (error) {
      errorMsg = error.message;
      return;
    }

    allChallenges = data ?? [];

    if (selectedChallengeIds.length === 0) {
      selectedChallengeIds = allChallengeIds();
    }

    if (roundChallengeIds.length === 0) {
      roundChallengeIds = allChallengeIds();
    }

    if (roundDrafts.length === 0) {
      resetRoundDraftFields();
    }
  }

  async function replaceGameChallenges(gameId: string, challengeIds: string[]) {
    const uniqueChallengeIds = Array.from(new Set(challengeIds));

    const { error: deleteError } = await supabase
      .from('game_challenges')
      .delete()
      .eq('game_id', gameId);

    if (deleteError) {
      throw deleteError;
    }

    if (uniqueChallengeIds.length === 0) {
      return;
    }

    const rows = uniqueChallengeIds.map((challengeId) => ({
      game_id: gameId,
      challenge_id: challengeId
    }));

    const { error: insertError } = await supabase
      .from('game_challenges')
      .insert(rows);

    if (insertError) {
      throw insertError;
    }
  }

  async function replaceGameRounds(
    gameId: string,
    roundsToSave: Array<{ round_index: number; name: string; type: 'pvp' | 'pve'; required_defenses: number; duration_minutes: number; intermission_minutes: number; available_challenges: string[] }>
  ) {
    const normalizedRounds = roundsToSave
      .map((round, index) => ({
        round_index: index,
        name: round.name.trim(),
        type: round.type,
        required_defenses: Math.max(1, Math.trunc(round.required_defenses)),
        duration_minutes: Math.max(1, Math.trunc(round.duration_minutes)),
        intermission_minutes: Math.max(0, Math.trunc(round.intermission_minutes)),
        available_challenges: Array.from(new Set(round.available_challenges))
      }))
      .filter((round) => round.name.length > 0);

    const { error: deleteError } = await supabase
      .from('rounds')
      .delete()
      .eq('game_id', gameId);

    if (deleteError) {
      throw deleteError;
    }

    if (normalizedRounds.length === 0) {
      return;
    }

    const { error: insertError } = await supabase
      .from('rounds')
      .insert(
        normalizedRounds.map((round) => ({
          game_id: gameId,
          round_index: round.round_index,
          name: round.name,
          type: round.type,
          required_defenses: round.required_defenses,
          duration_minutes: round.duration_minutes,
          intermission_minutes: round.intermission_minutes,
          available_challenges: round.available_challenges
        }))
      );

    if (insertError) {
      throw insertError;
    }
  }

  async function openChallengeEditor(gameId: string) {
    challengeEditorLoading = true;
    challengeEditorMessage = '';
    challengeEditorError = false;
    challengeEditorGameId = gameId;

    const { data, error } = await supabase
      .from('game_challenges')
      .select('challenge_id')
      .eq('game_id', gameId);

    if (error) {
      challengeEditorMessage = error.message;
      challengeEditorError = true;
      challengeEditorLoading = false;
      return;
    }

    editorSelectedChallengeIds = (data ?? []).map((row: any) => row.challenge_id);
    challengeEditorLoading = false;
  }

  async function saveChallengeEditor() {
    if (!challengeEditorGameId) return;

    if (editorSelectedChallengeIds.length === 0) {
      challengeEditorMessage = 'Select at least one challenge for this game.';
      challengeEditorError = true;
      return;
    }

    challengeEditorLoading = true;
    challengeEditorMessage = '';
    challengeEditorError = false;

    try {
      await replaceGameChallenges(challengeEditorGameId, editorSelectedChallengeIds);
      challengeEditorMessage = 'Challenge selection saved.';
      challengeEditorError = false;
    } catch (error: any) {
      challengeEditorMessage = error.message;
      challengeEditorError = true;
    } finally {
      challengeEditorLoading = false;
    }
  }

  function closeChallengeEditor() {
    challengeEditorGameId = '';
    editorSelectedChallengeIds = [];
    challengeEditorMessage = '';
    challengeEditorError = false;
  }

  function challengeEditorGameName() {
    return games.find((game) => game.id === challengeEditorGameId)?.name ?? '';
  }

  async function fetchGames() {
    const { data, error } = await supabase.from('games').select('*').order('created_at', { ascending: false });
    if (data) {
      games = data;
      await ensureInviteCodes(data);
      if (games.length > 0) {
        const stillSelected = games.some((game) => game.id === selectedGameId);
        selectedGameId = stillSelected ? selectedGameId : games[0].id;
        await fetchTeamsForGame(selectedGameId);
      } else {
        selectedGameId = '';
        teams = [];
      }
    }
    if (error) console.error(error);
  }

  function generateInviteCode() {
    return Math.floor(Math.random() * 16777215)
      .toString(16)
      .padStart(6, '0')
      .toUpperCase();
  }

  async function fetchTeamsForGame(gameId: string) {
    if (!gameId) {
      teams = [];
      return;
    }

    teamLoading = true;
    teamMessage = '';

    const { data: teamRows, error: teamsError } = await supabase
      .from('teams')
      .select('id, game_id, name, invite_code, created_at')
      .eq('game_id', gameId)
      .order('created_at', { ascending: false });

    if (teamsError) {
      teamMessage = teamsError.message;
      teamError = true;
      teamLoading = false;
      return;
    }

    if (!teamRows || teamRows.length === 0) {
      teams = [];
      teamLoading = false;
      return;
    }

    const teamIds = teamRows.map((team) => team.id);
    const { data: memberRows, error: memberError } = await supabase
      .from('team_members')
      .select('team_id')
      .in('team_id', teamIds);

    if (memberError) {
      teamMessage = memberError.message;
      teamError = true;
      teamLoading = false;
      return;
    }

    const membersByTeam = (memberRows || []).reduce<Record<string, number>>((acc, row: any) => {
      const currentCount = acc[row.team_id] || 0;
      acc[row.team_id] = currentCount + 1;
      return acc;
    }, {});

    teams = teamRows.map((team) => ({
      ...team,
      member_count: membersByTeam[team.id] || 0
    }));
    teamLoading = false;
  }

  async function renameTeam(teamId: string, currentName: string) {
    const updatedName = window.prompt('Rename team', currentName);
    if (!updatedName || updatedName.trim() === currentName) return;

    teamLoading = true;
    teamMessage = '';
    teamError = false;

    const { error } = await supabase
      .from('teams')
      .update({ name: updatedName.trim() })
      .eq('id', teamId);

    if (error) {
      teamMessage = error.message;
      teamError = true;
      teamLoading = false;
      return;
    }

    teamMessage = 'Team renamed successfully.';
    await fetchTeamsForGame(selectedGameId);
    teamLoading = false;
  }

  async function regenerateTeamInviteCode(teamId: string) {
    teamLoading = true;
    teamMessage = '';
    teamError = false;

    let updateError: any = null;
    let nextCode = '';
    for (let i = 0; i < 5; i += 1) {
      nextCode = generateInviteCode();
      const { error } = await supabase
        .from('teams')
        .update({ invite_code: nextCode })
        .eq('id', teamId);

      if (!error) {
        updateError = null;
        break;
      }

      updateError = error;
      if (error.code !== '23505') break;
    }

    if (updateError) {
      teamMessage = updateError.message;
      teamError = true;
      teamLoading = false;
      return;
    }

    teamMessage = `Updated team invite code to TEAM:${nextCode}.`;
    await fetchTeamsForGame(selectedGameId);
    teamLoading = false;
  }

  async function deleteTeam(teamId: string, teamTitle: string) {
    if (!window.confirm(`Delete team "${teamTitle}"? This also removes all members and challenge setups.`)) {
      return;
    }

    teamLoading = true;
    teamMessage = '';
    teamError = false;

    const { error } = await supabase
      .from('teams')
      .delete()
      .eq('id', teamId);

    if (error) {
      teamMessage = error.message;
      teamError = true;
      teamLoading = false;
      return;
    }

    teamMessage = 'Team deleted successfully.';
    await fetchTeamsForGame(selectedGameId);
    teamLoading = false;
  }

  async function setInviteCodeForGame(gameId: string) {
    for (let i = 0; i < 5; i += 1) {
      const inviteCode = generateInviteCode();
      const { error } = await supabase
        .from('games')
        .update({ invite_code: inviteCode })
        .eq('id', gameId);

      if (!error) return;

      // Retry if generated code collided with existing one.
      if (error.code !== '23505') throw error;
    }

    throw new Error('Failed to generate a unique invite code after multiple attempts.');
  }

  async function ensureInviteCodes(gameRows: any[]) {
    const missingInviteCodes = gameRows.filter((g) => !g.invite_code);
    if (missingInviteCodes.length === 0) return;

    for (const game of missingInviteCodes) {
      await setInviteCodeForGame(game.id);
    }

    const { data: refreshedGames, error } = await supabase
      .from('games')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (refreshedGames) games = refreshedGames;
  }

  function formatDateTime(value: string) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Invalid date';
    return parsed.toLocaleString([], {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  async function createGame() {
    loading = true;
    errorMsg = '';

    const challengePool = Array.from(
      new Set([
        ...selectedChallengeIds,
        ...roundDrafts.flatMap((round) => round.available_challenges)
      ])
    );

    if (challengePool.length === 0) {
      errorMsg = 'Select at least one challenge for this game.';
      loading = false;
      return;
    }

    const roundsToSave: RoundDraft[] = roundDrafts.length > 0
      ? roundDrafts
      : [
          {
            round_index: 0,
            name: 'Round 1',
            type: 'pvp',
            required_defenses: challenges_per_team,
            duration_minutes: 60,
            intermission_minutes: 5,
            available_challenges: challengePool
          }
        ];

    const dateTimeLocalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    const proposedEndTime = effectiveEndTimeForValidation(roundsToSave);
    if (!dateTimeLocalPattern.test(start_time) || !proposedEndTime || !dateTimeLocalPattern.test(proposedEndTime)) {
      errorMsg = 'Please select valid start and end date/time values.';
      loading = false;
      return;
    }

    // datetime-local uses a sortable format: YYYY-MM-DDTHH:mm
    if (proposedEndTime <= start_time) {
      errorMsg = 'End time must be after start time.';
      loading = false;
      return;
    }

    const scheduleCheck = validateScheduleFit(roundsToSave);
    if (!scheduleCheck.ok) {
      errorMsg = scheduleCheck.message;
      loading = false;
      return;
    }

    const { data: user } = await supabase.auth.getUser();
    const invite_code = generateInviteCode();
    const now = Date.now();
    const startDate = new Date(start_time);
    const endDate = new Date(proposedEndTime);
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      errorMsg = 'Could not parse start/end time. Please reselect both values.';
      loading = false;
      return;
    }

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const initialIsActive = now >= startMs && now <= endMs;

    const { data: createdGame, error } = await supabase
      .from('games')
      .insert([{
        name,
        start_time: startIso,
        end_time: endIso,
        challenges_per_team,
        invite_code,
        is_active: initialIsActive,
        created_by: user?.user?.id || null
      }])
      .select()
      .single();

    if (error) {
      errorMsg = error.message;
    } else {
      try {
        await replaceGameChallenges(createdGame.id, challengePool);
        await replaceGameRounds(
          createdGame.id,
          roundsToSave
        );
      } catch (challengeError: any) {
        errorMsg = `Game created, but round or challenge mapping failed: ${challengeError.message}`;
        loading = false;
        await fetchGames();
        return;
      }

      name = '';
      start_time = '';
      end_time = '';
      challenges_per_team = 5;
      selectedChallengeIds = allChallengeIds();
      clearRoundDrafts();
      await fetchGames();
    }
    
    loading = false;
  }
</script>

<div class="p-8 max-w-5xl mx-auto space-y-8">
  <div class="flex items-center justify-between border-b border-white/10 pb-6">
    <div class="space-y-1">
      <h1 class="text-3xl font-bold tracking-tight text-white">Manage Games</h1>
      <p class="text-gray-400">Create new competition rounds and view existing games.</p>
    </div>
  </div>
  
  {#if errorMsg}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">
      {errorMsg}
    </div>
  {/if}

  <div class="border border-white/10 bg-slate-900/50 backdrop-blur-sm p-6 rounded-xl space-y-4 shadow-xl">
    <h2 class="text-xl font-semibold text-white">Create New Game</h2>
    
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2 col-span-2">
        <p class="text-sm font-medium text-gray-300">Game Name</p>
        <input id="game-name" bind:value={name} placeholder="RedHacks 2026 Season 1" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
      </div>

      <div class="space-y-2 col-span-2 md:col-span-1">
        <p class="text-sm font-medium text-gray-300">Start Time</p>
        <div class="flex gap-2">
          <input
            id="game-start-time"
            bind:this={startTimeInput}
            type="datetime-local"
            step="60"
            value={start_time}
            onchange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              start_time = input.value;
            }}
            class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all"
          />
          <button
            type="button"
            class="shrink-0 px-3 rounded-md border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 transition-colors"
            onclick={() => startTimeInput?.showPicker?.()}
            aria-label="Open start time calendar"
          >
            Pick
          </button>
        </div>
        <p class="text-xs text-gray-500">Select the game start. Round schedule will build from this time.</p>
      </div>
      <div class="space-y-2 col-span-2 md:col-span-1">
        <p class="text-sm font-medium text-gray-300">End Time {roundDrafts.length > 0 ? '(Auto from Rounds)' : ''}</p>
        {#if roundDrafts.length > 0}
          <div class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white/90 font-mono" aria-live="polite">
            {computeRoundsBasedEndTime(start_time, roundDrafts) ?? 'Set start time to calculate end time'}
          </div>
        {:else}
          <input id="game-end-time" type="datetime-local" step="60" bind:value={end_time} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
        {/if}
        {#if roundDrafts.length > 0}
          <p class="text-xs text-gray-500">End time is calculated from the round schedule.</p>
        {/if}
      </div>

      <div class="space-y-2 col-span-2 md:col-span-1">
        <p class="text-sm font-medium text-gray-300">Default Defenses Per Round</p>
        <input id="game-challenges-per-team" type="number" bind:value={challenges_per_team} min="1" max="20" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
        <p class="text-xs text-gray-500">This value becomes the default round defense count when you add a round.</p>
      </div>

      <div class="space-y-3 col-span-2">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm font-medium text-gray-300">Challenges Included In This Game</p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-2.5 py-1 rounded border border-white/15 text-xs text-gray-200 hover:bg-white/10"
              onclick={() => selectedChallengeIds = allChallengeIds()}
            >
              Select all
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded border border-white/15 text-xs text-gray-200 hover:bg-white/10"
              onclick={() => selectedChallengeIds = []}
            >
              Clear
            </button>
          </div>
        </div>

        {#if allChallenges.length === 0}
          <div class="text-sm text-gray-500 border border-white/10 rounded-lg p-3 bg-black/20">
            No challenges exist yet. Create at least one challenge before creating a game.
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto p-3 border border-white/10 rounded-lg bg-black/20">
            {#each allChallenges as challenge}
              <label class="flex items-start gap-3 p-2 rounded hover:bg-white/5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedChallengeIds.includes(challenge.id)}
                  onchange={() => toggleChallengeSelection(challenge.id)}
                  class="mt-0.5"
                />
                <span class="text-sm text-gray-200">
                  <span class="font-semibold text-white">{challenge.model_name}</span>
                  <span class="text-xs text-gray-400 ml-2">{challenge.type}</span>
                  <span class="block text-xs text-gray-500 mt-0.5">{challenge.description}</span>
                </span>
              </label>
            {/each}
          </div>
        {/if}

        <p class="text-xs text-gray-500">Selected: {selectedChallengeIds.length} / {allChallenges.length}. New games default to all challenges selected.</p>
      </div>

      <div class="space-y-4 col-span-2 border border-white/10 rounded-xl bg-black/20 p-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-sm font-medium text-gray-300">Rounds</p>
            <p class="text-xs text-gray-500">Add one or more rounds for this game before creating it.</p>
          </div>
          <button
            type="button"
            class="px-2.5 py-1 rounded border border-white/15 text-xs text-gray-200 hover:bg-white/10"
            onclick={clearRoundDrafts}
          >
            Clear rounds
          </button>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-2 col-span-2 md:col-span-1">
            <p class="text-sm font-medium text-gray-300">Round Name</p>
            <input bind:value={roundName} placeholder="Round 1" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
          </div>

          <div class="space-y-2 col-span-2 md:col-span-1">
            <p class="text-sm font-medium text-gray-300">Round Type</p>
            <select bind:value={roundType} class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all">
              <option value="pvp">PvP</option>
              <option value="pve">PvE</option>
            </select>
          </div>

          <div class="space-y-2 col-span-2 md:col-span-1">
            <p class="text-sm font-medium text-gray-300">Required Defenses</p>
            <input bind:value={roundRequiredDefenses} type="number" min="1" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
            <p class="text-xs text-gray-500">Teams must defend this many challenges in this round.</p>
          </div>

          <div class="space-y-2 col-span-2 md:col-span-1">
            <p class="text-sm font-medium text-gray-300">Round Duration (minutes)</p>
            <input bind:value={roundDurationMinutes} type="number" min="1" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
            <p class="text-xs text-gray-500">How long this round lasts.</p>
          </div>

          <div class="space-y-2 col-span-2 md:col-span-1">
            <p class="text-sm font-medium text-gray-300">Intermission (minutes)</p>
            <input bind:value={roundIntermissionMinutes} type="number" min="0" class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
            <p class="text-xs text-gray-500">Break time after this round ends.</p>
          </div>

          <div class="space-y-2 col-span-2">
            <p class="text-sm font-medium text-gray-300">Round Challenges</p>
            {#if allChallenges.length === 0}
              <div class="text-sm text-gray-500 border border-white/10 rounded-lg p-3 bg-black/20">No challenges exist yet.</div>
            {:else}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-3 border border-white/10 rounded-lg bg-black/30">
                {#each allChallenges as challenge}
                  <label class="flex items-start gap-3 p-2 rounded hover:bg-white/5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={roundChallengeIds.includes(challenge.id)}
                      onchange={() => toggleRoundChallengeSelection(challenge.id)}
                      class="mt-0.5"
                    />
                    <span class="text-sm text-gray-200">
                      <span class="font-semibold text-white">{challenge.model_name}</span>
                      <span class="text-xs text-gray-400 ml-2">{challenge.type}</span>
                      <span class="block text-xs text-gray-500 mt-0.5">{challenge.description}</span>
                    </span>
                  </label>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <p class="text-xs text-gray-500">Round draft uses {roundChallengeIds.length} challenge(s) and requires {roundRequiredDefenses} defense(s).</p>
          <button
            type="button"
            class="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-semibold"
            onclick={addRoundDraft}
            disabled={allChallenges.length === 0}
          >
            Add Round
          </button>
        </div>

        {#if roundDrafts.length > 0}
          <div class="space-y-3 border-t border-white/10 pt-4">
            <p class="text-sm font-medium text-gray-300">Draft Rounds</p>
            <div class="space-y-2">
              {#each roundDrafts as round}
                <div class="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-slate-900/50 p-3">
                  <div>
                    <p class="font-semibold text-white">{round.round_index + 1}. {round.name}</p>
                    <p class="text-xs text-gray-500 uppercase tracking-wider">{round.type} • {round.available_challenges.length} challenge(s) • {round.required_defenses} required defense(s)</p>
                    <p class="text-xs text-gray-400 mt-1">{round.duration_minutes}m round • {round.intermission_minutes}m break</p>
                  </div>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded border border-red-500/30 text-xs text-red-300 hover:bg-red-500/10"
                    onclick={() => removeRoundDraft(round.round_index)}
                  >
                    Remove
                  </button>
                </div>
              {/each}
            </div>

            <div class="rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-gray-300 space-y-1">
              <p>Planned timeline: <span class="font-semibold text-white">{draftScheduleSummary.plannedMinutes} min</span></p>
              {#if draftScheduleSummary.availableMinutes !== null}
                <p>Available game window: <span class="font-semibold text-white">{draftScheduleSummary.availableMinutes} min</span></p>
                <p class={draftScheduleSummary.ok ? 'text-emerald-300' : 'text-red-300'}>
                  {draftScheduleSummary.ok
                    ? `Fits with ${draftScheduleSummary.availableMinutes - draftScheduleSummary.plannedMinutes} min spare.`
                    : draftScheduleSummary.message}
                </p>
              {:else}
                <p class="text-amber-300">Set valid start and end times to validate schedule fit.</p>
              {/if}
            </div>

            {#if start_time}
              {#if draftTimelineItems.length > 0}
                <div class="rounded-lg border border-white/10 bg-slate-950/60 p-3 space-y-2">
                  <p class="text-xs uppercase tracking-wider text-gray-400">Timeline Preview</p>
                  {#each draftTimelineItems as item}
                    <div class="text-xs rounded border p-2 {item.type === 'round' ? 'border-blue-500/30 bg-blue-500/10 text-blue-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'}">
                      <p class="font-semibold">{item.label}</p>
                      <p class="opacity-80">{item.startLabel} → {item.endLabel}</p>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <button onclick={createGame} disabled={loading || !name || !start_time || (!end_time && roundDrafts.length === 0) || (selectedChallengeIds.length === 0 && roundDrafts.length === 0) || allChallenges.length === 0} class="w-full bg-red-600 hover:bg-red-500 text-white px-4 py-3 rounded-lg font-bold disabled:opacity-50 mt-6 transition-all shadow-lg hover:shadow-red-500/20 active:scale-[0.98]">
      {loading ? 'Creating...' : 'Create Game'}
    </button>
  </div>

  <div class="space-y-4 pt-8">
    <h2 class="text-xl font-semibold text-white">Existing Games</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each games as game}
        <div class="border border-white/10 {isGameActive(game) ? 'bg-red-500/10 border-red-500/30' : 'bg-slate-900/40 backdrop-blur-sm'} p-5 rounded-xl flex flex-col justify-between hover:border-red-500/30 transition-colors shadow-lg">
          <div>
            <div class="flex justify-between items-start">
              <h3 class="font-bold text-lg text-white">{game.name}</h3>
              {#if game.invite_code}
                <span class="font-mono text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded border border-red-500/30" title="Game Invite Code">
                  GAME:{game.invite_code}
                </span>
              {/if}
            </div>
            
            <span class="inline-block px-2.5 py-1 bg-white/10 text-xs rounded-full text-gray-300 mt-3 whitespace-nowrap font-medium">
              {formatDateTime(game.start_time)} - {formatDateTime(game.end_time)}
            </span>
            <p class="text-xs text-gray-400 mt-2 font-mono break-all">GAME:{game.id}</p>
            <p class="text-sm text-gray-400 mt-3 bg-black/20 p-2 rounded flex justify-between">
              <span>{game.challenges_per_team} Challenges</span>
              <span>{game.is_active ? 'Active' : 'Inactive'}</span>
            </p>
          </div>
          <div class="mt-5 pt-3 border-t border-white/5">
            <div class="flex items-center justify-between gap-3">
              <a href="/dashboard/{game.id}" class="text-red-400 hover:text-red-300 text-sm font-bold flex items-center gap-1 group">
                View Dashboard
                <span class="group-hover:translate-x-1 transition-transform">&rarr;</span>
              </a>
              <button
                type="button"
                class="px-2.5 py-1 rounded border border-white/15 text-xs text-gray-200 hover:bg-white/10"
                onclick={() => openChallengeEditor(game.id)}
              >
                Edit Challenges
              </button>
            </div>
          </div>
        </div>
      {/each}
      {#if games.length === 0}
        <p class="text-gray-500 text-sm col-span-full">No games created yet. Create one above to get started.</p>
      {/if}
    </div>
  </div>

  {#if challengeEditorGameId}
    <div class="space-y-4 pt-10 border-t border-white/10">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-xl font-semibold text-white">Edit Game Challenges</h2>
        <button
          type="button"
          class="px-3 py-1.5 rounded border border-white/15 text-xs text-gray-300 hover:bg-white/10"
          onclick={closeChallengeEditor}
        >
          Close
        </button>
      </div>
      <p class="text-sm text-gray-400">Game: <span class="text-white font-semibold">{challengeEditorGameName()}</span></p>

      {#if challengeEditorMessage}
        <div class="p-3 rounded-md border {challengeEditorError ? 'bg-red-500/10 border-red-500/40 text-red-400' : 'bg-green-500/10 border-green-500/40 text-green-300'}">
          {challengeEditorMessage}
        </div>
      {/if}

      <div class="border border-white/10 bg-slate-900/40 rounded-xl p-5 space-y-4">
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm font-medium text-gray-300">Included challenges</p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-2.5 py-1 rounded border border-white/15 text-xs text-gray-200 hover:bg-white/10"
              onclick={() => editorSelectedChallengeIds = allChallengeIds()}
              disabled={challengeEditorLoading}
            >
              Select all
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded border border-white/15 text-xs text-gray-200 hover:bg-white/10"
              onclick={() => editorSelectedChallengeIds = []}
              disabled={challengeEditorLoading}
            >
              Clear
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto p-3 border border-white/10 rounded-lg bg-black/20">
          {#each allChallenges as challenge}
            <label class="flex items-start gap-3 p-2 rounded hover:bg-white/5 cursor-pointer">
              <input
                type="checkbox"
                checked={editorSelectedChallengeIds.includes(challenge.id)}
                onchange={() => toggleEditorChallengeSelection(challenge.id)}
                disabled={challengeEditorLoading}
                class="mt-0.5"
              />
              <span class="text-sm text-gray-200">
                <span class="font-semibold text-white">{challenge.model_name}</span>
                <span class="text-xs text-gray-400 ml-2">{challenge.type}</span>
                <span class="block text-xs text-gray-500 mt-0.5">{challenge.description}</span>
              </span>
            </label>
          {/each}
        </div>

        <div class="flex items-center justify-between gap-3">
          <p class="text-xs text-gray-500">Selected: {editorSelectedChallengeIds.length} / {allChallenges.length}</p>
          <button
            type="button"
            class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-bold disabled:opacity-50"
            onclick={saveChallengeEditor}
            disabled={challengeEditorLoading || editorSelectedChallengeIds.length === 0}
          >
            {challengeEditorLoading ? 'Saving...' : 'Save Challenge Selection'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="space-y-4 pt-10 border-t border-white/10">
    <h2 class="text-xl font-semibold text-white">Manage Teams</h2>
    <p class="text-sm text-gray-400">View and manage teams for a specific game.</p>

    {#if teamMessage}
      <div class="p-3 rounded-md border {teamError ? 'bg-red-500/10 border-red-500/40 text-red-400' : 'bg-green-500/10 border-green-500/40 text-green-300'}">
        {teamMessage}
      </div>
    {/if}

    <div class="border border-white/10 bg-slate-900/40 rounded-xl p-5 space-y-4">
      <div class="grid grid-cols-1 gap-4">
        <div class="space-y-2">
          <p class="text-sm font-medium text-gray-300">Game</p>
          <select
            bind:value={selectedGameId}
            class="w-full bg-black/40 border border-white/10 rounded-md p-2.5 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all"
            onchange={() => fetchTeamsForGame(selectedGameId)}
          >
            <option value="" disabled selected={selectedGameId === ''}>Select a game</option>
            {#each games as game}
              <option value={game.id}>{game.name}</option>
            {/each}
          </select>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each teams as team}
        <div class="border border-white/10 bg-slate-900/40 p-4 rounded-xl space-y-3">
          <div>
            <h3 class="text-lg font-semibold text-white">{team.name}</h3>
            <p class="text-xs text-gray-400 font-mono break-all mt-1">TEAM:{team.id}</p>
          </div>

          <div class="space-y-2 text-sm text-gray-300">
            <div class="flex items-center justify-between bg-black/20 p-2 rounded">
              <span>Team Invite Code</span>
              <span class="font-mono font-semibold tracking-wider text-red-300">TEAM:{team.invite_code}</span>
            </div>
            <div class="flex items-center justify-between bg-black/20 p-2 rounded">
              <span>Members</span>
              <span>{team.member_count}</span>
            </div>
            <div class="flex items-center justify-between bg-black/20 p-2 rounded">
              <span>Created</span>
              <span>{formatDateTime(team.created_at)}</span>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2">
            <button
              class="px-2 py-1.5 rounded border border-white/20 text-xs text-gray-200 hover:bg-white/10"
              onclick={() => renameTeam(team.id, team.name)}
              disabled={teamLoading}
            >
              Rename
            </button>
            <button
              class="px-2 py-1.5 rounded border border-red-500/30 text-xs text-red-300 hover:bg-red-500/10"
              onclick={() => regenerateTeamInviteCode(team.id)}
              disabled={teamLoading}
            >
              New Code
            </button>
            <button
              class="px-2 py-1.5 rounded border border-red-500/50 text-xs text-red-400 hover:bg-red-500/20"
              onclick={() => deleteTeam(team.id, team.name)}
              disabled={teamLoading}
            >
              Delete
            </button>
          </div>
        </div>
      {/each}
      {#if selectedGameId && teams.length === 0 && !teamLoading}
        <p class="text-sm text-gray-500 col-span-full">No teams in this game yet.</p>
      {/if}
    </div>
  </div>
</div>
