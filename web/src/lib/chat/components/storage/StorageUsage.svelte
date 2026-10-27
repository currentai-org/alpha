<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { Meter } from '@aipotluck/alpha-ds';
	import { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER, storageUsage } from '$lib/chat/constants/custodialUpload';
	import { formatBytes } from './formatBytes';

	// How much of Alpha storage's quota a person's files use: the file count and the bytes against the
	// ceiling. One piece, so the Files page and Settings → Storage say the same thing (CUR-4363).
	interface Props {
		fileCount: number;
		totalBytes: number;
		/** Also say the warning line when the quota is nearly or fully used. */
		showWarning?: boolean;
	}
	let { fileCount, totalBytes, showWarning = false }: Props = $props();

	const usage = $derived(storageUsage(totalBytes, fileCount));
</script>

<Meter.Root
	value={usage.fraction}
	max={1}
	format={() => m.usage_ofMax({ value: formatBytes(totalBytes), max: formatBytes(CUSTODIAL_MAX_TOTAL_BYTES_PER_USER) })}
	data-testid="storage-meter"
>
	<Meter.Label>
		{fileCount === 1 ? m.account_oneFile() : m.account_nFiles({ count: fileCount })}
	</Meter.Label>
	<Meter.Value />
	<Meter.Track><Meter.Indicator tone={usage.warning ? 'accent' : 'default'} /></Meter.Track>
</Meter.Root>
{#if showWarning && usage.warning}
	<p class="m-0 text-small text-fg-2" role="status" data-testid="storage-warning">
		{usage.warning}
	</p>
{/if}
