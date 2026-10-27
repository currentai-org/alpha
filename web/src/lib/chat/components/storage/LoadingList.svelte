<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	// CUR-1276, from files-components.jsx's LoadingList. Three inert placeholder rows — flat and
	// still, no shimmer or entrance animation, matching the rest of this design system.
	const widths = [70, 48, 60];
</script>

<div class="flex flex-col gap-3" aria-busy="true">
	<span class="font-mono text-[11px] tracking-wide text-[var(--ap-ink-3)] uppercase">
		{m.storage_loadingFiles()}
	</span>
	{#each widths as w (w)}
		<div
			class="flex flex-col gap-2 rounded-[var(--ap-radius-1)] border border-[var(--ap-border-3)] bg-[var(--ap-stack-panel,var(--ap-paper))] p-2.5 opacity-50"
		>
			<span class="block h-2.5 bg-[var(--ap-ink)]/10" style={`width: ${w}%`}></span>
			<span class="block h-2 w-[28%] bg-[var(--ap-ink)]/10"></span>
		</div>
	{/each}
</div>
