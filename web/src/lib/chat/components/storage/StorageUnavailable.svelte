<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiErrorWarningFill from '~icons/ri/error-warning-fill';
	import RiRefreshLine from '~icons/ri/refresh-line';

	// CUR-1276, from files-components.jsx's Unavailable. The list couldn't be read — this never
	// claims the files are gone, only that Alpha couldn't show them right now.
	// `busy` is the server's own line when the storage host throttled the storage token, which says
	// why and how long better than "didn't load" does. (CUR-3680)
	interface Props {
		onReload: () => void;
		busy?: string | null;
	}
	let { onReload, busy = null }: Props = $props();
</script>

<div
	class="flex flex-col items-start gap-2 rounded-[var(--ap-radius-1)] border border-[var(--ap-border-3)] bg-[var(--ap-stack-panel,var(--ap-paper))] p-4"
>
	<RiErrorWarningFill class="size-[18px] text-[var(--ap-danger)]" />
	<h3 class="m-0 font-sans text-[16px] font-bold text-[var(--ap-ink)]">
		{m.storage_unavailableTitle()}
	</h3>
	<p class="m-0 font-sans text-[13px] leading-[18px] text-[var(--ap-ink-2)]">
		{#if busy}
			{m.storage_unavailableBusy({ busy })}
		{:else}
			{m.storage_unavailableBody()}
		{/if}
	</p>
	<button
		type="button"
		onclick={onReload}
		class="mt-2 flex items-center gap-1.5 rounded-[var(--ap-radius-1)] border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-1.5 font-sans text-[13px] text-[var(--ap-ink)]"
	>
		<RiRefreshLine class="size-3.5" />
		{m.storage_tryAgain()}
	</button>
</div>
