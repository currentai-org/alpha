<!--
  @component
  Shared `Portal` part. Portals into the nearest ThemeProvider's body-level host so the popup
  escapes overflow clipping but keeps its theme, mode and runtime overrides.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Portal } from 'bits-ui';
	import { getThemeContext } from '../theme/context.ts';

	let {
		container,
		disabled = false,
		children
	}: { container?: HTMLElement | string; disabled?: boolean; children?: Snippet } = $props();

	const theme = getThemeContext();
	const to = $derived(container ?? theme?.portalTarget ?? 'body');
</script>

<Portal {to} {disabled}>
	{@render children?.()}
</Portal>
