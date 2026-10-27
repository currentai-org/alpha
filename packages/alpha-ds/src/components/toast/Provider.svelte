<!--
  @component
  Base UI `Toast.Provider` — scopes a toast manager to a subtree (defaults to the app-wide one).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setToastManager, toastManager, type ToastManager } from './manager.svelte.ts';

	let { manager = toastManager, children }: { manager?: ToastManager; children?: Snippet } =
		$props();
	setToastManager(manager);
</script>

{@render children?.()}
