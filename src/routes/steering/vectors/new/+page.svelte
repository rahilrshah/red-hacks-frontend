<script lang="ts">
  // /steering/vectors/new — thin wrapper around the shared editor in
  // create mode. All guidance, validation, and submission logic lives
  // in $lib/steering/VectorEditor.svelte so the edit page can reuse it.

  import VectorEditor from '$lib/steering/VectorEditor.svelte';
</script>

<VectorEditor mode="create" />
