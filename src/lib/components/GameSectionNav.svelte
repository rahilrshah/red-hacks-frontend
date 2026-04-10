<script lang="ts">
  type SectionId = 'hub' | 'defend' | 'attack' | 'live-events';

  let { gameId, current } = $props<{ gameId: string; current: SectionId }>();

  const sections: Array<{ id: SectionId; label: string; hrefSuffix: string }> = [
    { id: 'hub', label: 'Game Hub', hrefSuffix: '' },
    { id: 'defend', label: 'Defend', hrefSuffix: '/defend' },
    { id: 'attack', label: 'Attack', hrefSuffix: '/attack' },
    { id: 'live-events', label: 'Live Events', hrefSuffix: '/live-events' }
  ];
</script>

<nav class="border border-white/10 bg-black/30 rounded-xl p-2">
  <ul class="flex flex-wrap gap-2">
    {#each sections as section}
      <li>
        <a
          href={`/game/${gameId}${section.hrefSuffix}`}
          class={`inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${current === section.id ? 'bg-white/15 text-white border border-white/20' : 'text-gray-300 hover:text-white hover:bg-white/10 border border-transparent'}`}
          aria-current={current === section.id ? 'page' : undefined}
        >
          {section.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
