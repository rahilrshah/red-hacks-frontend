<script lang="ts">
  import { isGameActive } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';

  let inviteCode = $derived($page.params.inviteCode ?? '');
  let game = $state<any>(null);
  
  // Forms state
  let newTeamName = $state('');
  let teamInviteCode = $state('');
  
  let loading = $state(true);
  let actionMessage = $state('');
  let actionError = $state(false);
  let userId = $state('');
  let existingTeam = $state<any>(null);
  
  onMount(async () => {
    // Basic auto-auth for players
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) await supabase.auth.signInAnonymously();
    const { data: currentUser } = await supabase.auth.getUser();
    
    if (currentUser?.user) {
      userId = currentUser.user.id;
      
      // Load game details
      const { data: gameData, error: gameError } = await supabase
        .from('games')
        .select('*')
        .eq('invite_code', inviteCode.toUpperCase().trim())
        .single();
        
      if (gameError || !gameData) {
        actionMessage = 'Invalid or expired Game Invite Code.';
        actionError = true;
        loading = false;
        return;
      }

      if (!isGameActive(gameData)) {
        actionMessage = 'This game is currently inactive.';
        actionError = true;
        loading = false;
        return;
      }
      
      game = gameData;
      
      // Check if user is already in a team for this game
      const { data: memberData } = await supabase
        .from('team_members')
        .select('teams(*)')
        .eq('user_id', userId);
        
      if (memberData && memberData.length > 0) {
        const teamForGame = (memberData as any[]).find((m: any) => {
          const team = Array.isArray(m.teams) ? m.teams[0] : m.teams;
          return team?.game_id === game.id;
        });
        if (teamForGame) {
          existingTeam = Array.isArray((teamForGame as any).teams)
            ? (teamForGame as any).teams[0]
            : (teamForGame as any).teams;
          // Optionally auto-redirect
          // goto(`/game/${game.id}`);
        }
      }
      loading = false;
    }
  });

  async function createTeam() {
    if (!newTeamName || !game) return;
    if (!isGameActive(game)) {
      actionMessage = 'This game is currently inactive.';
      actionError = true;
      return;
    }
    loading = true;
    actionError = false;
    
    const newInviteCode = Math.floor(Math.random()*16777215).toString(16).padStart(6, '0').toUpperCase();

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .insert([{
        game_id: game.id,
        name: newTeamName,
        invite_code: newInviteCode
      }])
      .select()
      .single();

    if (teamError) {
      actionMessage = teamError.message;
      actionError = true;
      loading = false;
    } else if (team) {
      await supabase.from('team_members').insert([{
        team_id: team.id,
        user_id: userId,
        role: 'leader'
      }]);
      goto(`/game/${game.id}`);
    }
  }

  async function joinTeam() {
    if (!teamInviteCode) return;
    if (!game || !isGameActive(game)) {
      actionMessage = 'This game is currently inactive.';
      actionError = true;
      return;
    }
    loading = true;
    actionError = false;
    
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('invite_code', teamInviteCode.toUpperCase().trim())
      .single();
        
    if (teamError || !team) {
      actionMessage = 'Invalid Team Invite Code.';
      actionError = true;
      loading = false;
      return;
    }
    
    if (team.game_id !== game.id) {
      actionMessage = 'This team belongs to a different game.';
      actionError = true;
      loading = false;
      return;
    }

    const { error: memberError } = await supabase
      .from('team_members')
      .insert({
        team_id: team.id,
        user_id: userId,
        role: 'member'
      });
        
    if (memberError && memberError.code !== '23505') { 
      actionMessage = memberError.message;
      actionError = true;
      loading = false;
    } else {
      goto(`/game/${game.id}`);
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-12">
  <div class="border-b border-white/10 pb-6 flex items-center justify-between">
    <div>
      <h1 class="text-4xl font-black tracking-tight text-white flex items-center gap-3">
        <span class="text-blue-500">🎯</span> Setup Team
      </h1>
      {#if game}
        <p class="text-gray-400 mt-2 text-lg">You are joining: <span class="text-white font-bold">{game.name}</span></p>
      {:else}
        <p class="text-gray-400 mt-2 text-lg">Loading game details...</p>
      {/if}
    </div>
    <a href="/play" class="text-gray-400 hover:text-white transition-colors flex items-center gap-2 bg-white/5 px-4 py-2 rounded-lg">
      <span>←</span> Back to Hub
    </a>
  </div>
  
  {#if actionMessage}
    <div class="p-4 rounded-xl border {actionError ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-green-500/10 border-green-500/50 text-green-400'}">
      {actionMessage}
    </div>
  {/if}

  {#if loading}
    <div class="text-center py-12">
      <div class="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
      <p class="text-gray-400">Loading...</p>
    </div>
  {:else if !game}
    <!-- Error State handled in actionMessage usually -->
  {:else if existingTeam}
    <div class="border border-green-500/30 bg-green-500/10 backdrop-blur-md p-8 rounded-2xl shadow-xl text-center max-w-2xl mx-auto">
      <div class="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">✓</div>
      <h2 class="text-2xl font-bold text-white mb-2">You are already on a team!</h2>
      <p class="text-gray-300 mb-6">You have already joined <span class="font-bold text-white">{existingTeam.name}</span> for this game.</p>
      
      <a href={`/game/${game.id}`} class="inline-block bg-green-600 hover:bg-green-500 text-white px-8 py-4 rounded-xl font-bold transition-all text-lg shadow-[0_0_15px_rgba(34,197,94,0.3)] hover:shadow-[0_0_25px_rgba(34,197,94,0.5)]">
        GO TO GAME
      </a>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
      <!-- Create Team -->
      <div class="border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl shadow-xl flex flex-col justify-between">
        <div>
          <div class="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4 ring-1 ring-red-500/30 text-2xl">🛡️</div>
          <h2 class="text-2xl font-bold text-white mb-2">Create a New Team</h2>
          <p class="text-gray-400 mb-6">Start a new squad. You will be the team leader and receive an invite code to share with your friends.</p>
          
          <div class="space-y-4">
            <div class="space-y-2">
              <label for="new-team-name" class="text-sm font-semibold text-gray-300">Team Name</label>
              <input id="new-team-name" bind:value={newTeamName} placeholder="e.g. Protocol Breakers" class="w-full bg-black/60 border border-white/10 rounded-xl p-3 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" />
            </div>
          </div>
        </div>
        <button onclick={createTeam} disabled={loading || !newTeamName} class="w-full bg-red-600 hover:bg-red-500 text-white px-6 py-4 rounded-xl font-bold disabled:opacity-50 transition-all text-lg tracking-wide shadow-[0_0_15px_rgba(220,38,38,0.3)] hover:shadow-[0_0_25px_rgba(220,38,38,0.5)] active:scale-[0.98] mt-6">
          CREATE TEAM
        </button>
      </div>
      
      <!-- Join Team -->
      <div class="border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl shadow-xl flex flex-col justify-between">
        <div>
          <div class="w-12 h-12 bg-blue-500/10 rounded-full flex items-center justify-center mb-4 ring-1 ring-blue-500/30 text-2xl">🤝</div>
          <h2 class="text-2xl font-bold text-white mb-2">Join a Team</h2>
          <p class="text-gray-400 mb-6">Have an invite code from your team leader? Enter it here to join their squad.</p>
          
          <div class="space-y-4">
            <label for="team-invite-code" class="text-sm font-semibold text-gray-300">Team Invite Code</label>
            <input id="team-invite-code" bind:value={teamInviteCode} placeholder="E.g. A1B2C3" class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white text-center text-xl tracking-[0.3em] font-mono uppercase focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all" maxlength="6" />
          </div>
        </div>
        <button onclick={joinTeam} disabled={loading || teamInviteCode.length < 6} class="w-full bg-blue-600 hover:bg-blue-500 text-white px-6 py-4 rounded-xl font-bold disabled:opacity-50 transition-all text-lg tracking-wide shadow-[0_0_15px_rgba(37,99,235,0.3)] hover:shadow-[0_0_25px_rgba(37,99,235,0.5)] active:scale-[0.98] mt-6">
          JOIN TEAM
        </button>
      </div>
    </div>
  {/if}
</div>
