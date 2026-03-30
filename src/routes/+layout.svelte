<script lang="ts">
import './layout.css';
import favicon from '$lib/assets/favicon.svg';
import { supabase } from '$lib/supabaseClient';
import { onMount } from 'svelte';
import { goto } from '$app/navigation';

let { children } = $props();

let user = $state<any>(null);
let profile = $state<any>(null);

function buildDefaultUsername(userData: any) {
const base = (userData?.user_metadata?.full_name || userData?.email?.split('@')[0] || 'player')
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, '_')
	.replace(/^_+|_+$/g, '')
	.slice(0, 20) || 'player';
return `${base}_${userData.id.substring(0, 5)}`;
}

function needsProfileCompletion(profileData: any) {
return !profileData?.full_name || !profileData?.college || !profileData?.graduation_year;
}

async function loadProfile(userData: any) {
if (!userData) {
profile = null;
return;
}

if (userData.is_anonymous) {
profile = null;
return;
}

await supabase
	.from('profiles')
	.upsert(
		{
			id: userData.id,
			username: buildDefaultUsername(userData)
		},
		{ onConflict: 'id' }
	)
	.select();

const { data } = await supabase
	.from('profiles')
	.select('role, username, full_name, college, graduation_year')
	.eq('id', userData.id)
	.maybeSingle();

profile = data;

if (needsProfileCompletion(data) && window.location.pathname !== '/profile') {
goto('/profile');
}
}

onMount(() => {
let unsubscribed = false;
let authListener: { subscription: { unsubscribe: () => void } } | null = null;

async function init() {
const { data: { session } } = await supabase.auth.getSession();
if (unsubscribed) return;

user = session?.user || null;
await loadProfile(user);
if (unsubscribed) return;

const listener = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
user = nextSession?.user || null;
await loadProfile(user);
});

authListener = listener.data;
}

init();

return () => {
unsubscribed = true;
authListener?.subscription.unsubscribe();
};
});

async function loginWithGoogle() {
await supabase.auth.signInWithOAuth({
provider: 'google',
options: {
redirectTo: window.location.origin
}
});
}

async function logout() {
await supabase.auth.signOut();
}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex min-h-screen flex-col">
<header class="sticky top-0 z-50 w-full border-b border-white/10 bg-slate-950/80 backdrop-blur-md">
<div class="max-w-6xl mx-auto flex h-16 items-center px-8">
<a href="/" class="flex items-center gap-2 font-black text-xl tracking-tight text-white hover:text-red-400 transition-colors">
<span class="text-red-500">⚡</span> RedHacks
</a>
<nav class="ml-auto flex items-center space-x-6 text-sm font-semibold text-gray-300">
<a href="/play" class="hover:text-white transition-colors">Player Hub</a>
{#if user && !user.is_anonymous}
<a href="/profile" class="hover:text-white transition-colors">Profile</a>
{/if}
{#if profile?.role === 'admin'}
<a href="/admin" class="hover:text-white transition-colors border border-red-500/30 text-red-400 bg-red-500/10 px-3 py-1 rounded-md">Admin Dashboard</a>
{/if}
{#if user && !user.is_anonymous}
<div class="flex items-center space-x-4">
<span class="text-gray-400 font-normal">{user.email}</span>
<button onclick={logout} class="border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-white px-3 py-1.5 rounded-md transition-colors font-bold">Sign Out</button>
</div>
{:else}
<button onclick={loginWithGoogle} class="bg-white text-black hover:bg-gray-200 px-3 py-1.5 rounded-md transition-colors font-bold flex items-center gap-2 shadow-lg">
<svg viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
Google Login
</button>
{/if}
</nav>
</div>
</header>

<main class="flex-1">
{@render children()}
</main>
</div>
