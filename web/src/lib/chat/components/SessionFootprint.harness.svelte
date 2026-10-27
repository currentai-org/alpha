<!--
  Test harness: SessionFootprint reads its store from context, which the chat shell creates. Creating
  it here lets a server render show what the trigger looks like before the browser's store loads.
-->
<script lang="ts">
	import { createSessionFootprintStore } from '$lib/chat/stores/sessionFootprint.svelte';
	import SessionFootprint from './SessionFootprint.svelte';

	createSessionFootprintStore();
</script>

<SessionFootprint forget={false} />
