<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import AnswerFooter from './AnswerFooter.svelte';

	// The footer's tooltips need the Tooltip.Provider that ThemeProvider mounts in the app.
	let props: ComponentProps<typeof AnswerFooter> = $props();
</script>

<ThemeProvider>
	<AnswerFooter {...props} />
</ThemeProvider>
