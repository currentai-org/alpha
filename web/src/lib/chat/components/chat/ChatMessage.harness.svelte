<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import ChatMessage from './ChatMessage.svelte';

	// ChatMessage's answer footer uses the design system's tooltips, which need the Tooltip.Provider that
	// ThemeProvider mounts in the app. Tests render it inside one, as the app does.
	let props: ComponentProps<typeof ChatMessage> = $props();
</script>

<ThemeProvider>
	<ChatMessage {...props} />
</ThemeProvider>
