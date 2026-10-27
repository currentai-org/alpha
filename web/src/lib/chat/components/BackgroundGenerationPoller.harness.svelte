<script lang="ts">
	// Test-only wrapper: BackgroundGenerationPoller.svelte calls useConversationsStore(), which reads
	// Svelte context set by createConversationsStore() — normally done once in +layout.svelte. Mounting
	// the poller directly in a component test throws with no context provider in the tree, so this
	// harness supplies one. Not used by any production route.
	import { createConversationsStore } from "$lib/chat/stores/conversations.svelte";
	import BackgroundGenerationPoller from "./BackgroundGenerationPoller.svelte";

	createConversationsStore();
</script>

<BackgroundGenerationPoller />
