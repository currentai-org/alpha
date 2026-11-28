<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { Tooltip } from '@aipotluck/alpha-ds';
	import FilesPanel from './FilesPanel.svelte';

	let props: ComponentProps<typeof FilesPanel> = $props();
</script>

<!-- Every ThemeProvider mounts a Tooltip.Provider and the location tabs' tooltips need one; a bare
     render has none. The column is 420px (`w-105`), the Files page's width on a laptop. -->
<Tooltip.Provider delayDuration={0}>
	<div class="w-105">
		<FilesPanel {...props} />
	</div>
</Tooltip.Provider>
