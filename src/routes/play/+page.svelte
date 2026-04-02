<script lang="ts">
  import { isGameActive } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let gameInviteCode = $state('');
  
  let loading = $state(false);
  let actionMessage = $state('');
  let actionError = $state(false);
  let userId = $state('');

  onMount(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) await supabase.auth.signInAnonymously();
    const { data: currentUser } = await supabase.auth.getUser();
    if (currentUser?.user) {
      userId = currentUser.user.id;
      await supabase.from('profiles').upsert({ id: userId, username: 'Player_' + userId.substring(0, 5) }, { onConflict: 'id' }).select();
    }
  });

  async function joinGame() {
    if (!gameInviteCode) return;
    loading = true;
    actionError = false;

    // Verify game invite code exists
    const { data: game, error: gameError } = await supabase
      .from('games')
      .select('id, is_active, start_time, end_time')
      .eq('invite_code', gameInviteCode.toUpperCase().trim())
      .single();
      
    if (gameError || !game || !isGameActive(game)) {
      actionMessage = 'Invalid or inactive game invite code.';
      actionError = true;
      loading = false;
      return;
    }
    
    // Redirect to team creation/join screen for this game
    goto(`/play/${gameInviteCode.toUpperCase().trim()}`);
  }
</script>

<div class="p-8 max-w-6xl mx-auto space-y-12">
  <div class="border-b border-white/10 pb-6">
    <h1 class="text-4xl font-black tracking-tight text-white flex items-center gap-3">
      <span class="text-red-500">🎮</span> Player Hub
    </h1>
    <p class="text-gray-400 mt-2 text-lg">Join a game with an invite code, then create or join your team.</p>
  </div>

  {#if actionMessage}
    <div class="p-4 rounded-xl border {actionError ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-green-500/10 border-green-500/50 text-green-400'}">
      {actionMessage}
    </div>
  {/if}

  <div class="max-w-md border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl shadow-xl">
    <div class="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4 ring-1 ring-red-500/30 text-2xl">🎟️</div>
    <h2 class="text-xl font-bold text-white mb-2">Join a Game</h2>
    <p class="text-gray-400 mb-6">Enter the game invite code from your admin. On the next page, you can create or join a team.</p>

    <div class="space-y-4">
      <input bind:value={gameInviteCode} placeholder="E.g. X9Y8Z7" class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white text-center text-xl tracking-[0.2em] font-mono uppercase focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all" maxlength="6" />
    </div>

    <button onclick={joinGame} disabled={loading || gameInviteCode.length < 6} class="w-full bg-red-600 hover:bg-red-500 text-white px-6 py-4 rounded-xl font-bold disabled:opacity-50 transition-all text-lg tracking-wide shadow-[0_0_15px_rgba(220,38,38,0.3)] hover:shadow-[0_0_25px_rgba(220,38,38,0.5)] active:scale-[0.98] mt-6">
      {loading ? 'Joining Game...' : 'CONTINUE TO TEAMS'}
    </button>
  </div>
</div>
