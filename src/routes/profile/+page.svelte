<script lang="ts">
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let loading = $state(true);
  let saving = $state(false);
  let message = $state('');
  let isError = $state(false);

  let userId = $state('');
  let username = $state('');
  let fullName = $state('');
  let college = $state('');
  let graduationYear = $state<number | null>(null);

  const currentYear = new Date().getFullYear();

  function buildDefaultUsername(userData: any) {
    const base = (userData?.user_metadata?.full_name || userData?.email?.split('@')[0] || 'player')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'player';
    return `${base}_${userData.id.substring(0, 5)}`;
  }

  function isProfileComplete() {
    return Boolean(fullName.trim() && college.trim() && graduationYear);
  }

  onMount(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user || session.user.is_anonymous) {
      goto('/');
      return;
    }

    const user = session.user;
    userId = user.id;

    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('username, full_name, college, graduation_year')
      .eq('id', user.id)
      .maybeSingle();

    username = existingProfile?.username || buildDefaultUsername(user);
    fullName = existingProfile?.full_name || '';
    college = existingProfile?.college || '';
    graduationYear = existingProfile?.graduation_year || null;

    loading = false;
  });

  async function saveProfile() {
    if (!userId) return;

    const cleanName = fullName.trim();
    const cleanCollege = college.trim();

    if (!cleanName || !cleanCollege || !graduationYear) {
      isError = true;
      message = 'Please complete name, college, and graduation year.';
      return;
    }

    if (graduationYear < currentYear - 10 || graduationYear > currentYear + 10) {
      isError = true;
      message = `Graduation year must be between ${currentYear - 10} and ${currentYear + 10}.`;
      return;
    }

    saving = true;
    message = '';

    const { error } = await supabase
      .from('profiles')
      .upsert(
        {
          id: userId,
          username,
          full_name: cleanName,
          college: cleanCollege,
          graduation_year: graduationYear
        },
        { onConflict: 'id' }
      )
      .select();

    saving = false;

    if (error) {
      isError = true;
      message = error.message || 'Unable to save profile.';
      return;
    }

    isError = false;
    message = 'Profile saved.';
  }
</script>

<div class="max-w-2xl mx-auto p-8 space-y-8">
  <div class="border-b border-white/10 pb-6">
    <h1 class="text-4xl font-black tracking-tight text-white">Your Profile</h1>
    <p class="text-gray-400 mt-2 text-lg">Complete your profile before playing. You can update this any time.</p>
  </div>

  {#if loading}
    <div class="text-gray-400">Loading profile...</div>
  {:else}
    <form class="border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl shadow-xl space-y-5" onsubmit={(event) => { event.preventDefault(); saveProfile(); }}>
      <div class="space-y-2">
        <label class="block text-sm text-gray-300 font-semibold" for="full-name">Name</label>
        <input
          id="full-name"
          bind:value={fullName}
          type="text"
          placeholder="Your full name"
          class="w-full bg-black/60 border border-white/10 rounded-xl p-3 text-white outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500"
          required
        />
      </div>

      <div class="space-y-2">
        <label class="block text-sm text-gray-300 font-semibold" for="college">College</label>
        <input
          id="college"
          bind:value={college}
          type="text"
          placeholder="Your college or university"
          class="w-full bg-black/60 border border-white/10 rounded-xl p-3 text-white outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500"
          required
        />
      </div>

      <div class="space-y-2">
        <label class="block text-sm text-gray-300 font-semibold" for="graduation-year">Graduation Year</label>
        <input
          id="graduation-year"
          bind:value={graduationYear}
          type="number"
          min={currentYear - 10}
          max={currentYear + 10}
          placeholder={String(currentYear)}
          class="w-full bg-black/60 border border-white/10 rounded-xl p-3 text-white outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500"
          required
        />
      </div>

      {#if message}
        <div class="p-3 rounded-lg border text-sm {isError ? 'bg-red-500/10 border-red-500/50 text-red-400' : 'bg-green-500/10 border-green-500/50 text-green-400'}">
          {message}
        </div>
      {/if}

      <div class="flex items-center justify-between gap-3 pt-2">
        <p class="text-gray-400 text-sm">
          {#if isProfileComplete()}
            Profile is complete.
          {:else}
            Complete all fields to continue.
          {/if}
        </p>
        <button
          type="submit"
          disabled={saving}
          class="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white px-5 py-2.5 rounded-lg font-bold transition-colors"
        >
          {saving ? 'Saving...' : 'Save Profile'}
        </button>
      </div>
    </form>
  {/if}
</div>
