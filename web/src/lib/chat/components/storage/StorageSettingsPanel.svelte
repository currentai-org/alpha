<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import { Button } from '@aipotluck/alpha-ds';
	import { base } from '$lib/chat/paths';
	import { STORAGE_BUSY_MESSAGE } from '$lib/chat/constants/custodialUpload';
	import StorageUsage from './StorageUsage.svelte';
	import StorageLocations from './StorageLocations.svelte';
	import { ALPHA_LOCATION_ID, type LocationsState } from './locationTypes';

	// Settings → Storage holds the storage settings. The files themselves are on the rail's
	// Files page (FilesPanel), which this page links to. It says how much is used, which places files live in and where new ones
	// go, how to link a bucket of your own, and where files are kept. Same load and gate as the Files page. (CUR-4363)
	type ListedFile = { path: string; size: number };
	interface Props {
		/** Alpha storage's listing, from the shared files-page load. */
		initialFiles: ListedFile[];
		initialUnavailable?: boolean;
		initialBusy?: boolean;
		/** Null when the `storage-locations` flag is off: then there are no locations to set. */
		initialLocations?: LocationsState | null;
	}
	let { initialFiles, initialUnavailable = false, initialBusy = false, initialLocations = null }: Props = $props();

	let locState = $state<LocationsState | null>(initialLocations);
	const hasLinkedBucket = $derived(locState?.locations.some((l) => l.kind !== 'alpha') ?? false);
	const fileCount = $derived(initialFiles.length);
	const totalBytes = $derived(initialFiles.reduce((sum, f) => sum + f.size, 0));

	// Alpha storage's count comes with the page; a linked bucket's is read from its own listing, and a
	// place whose listing fails shows no count rather than a wrong one.
	let counts = $state<Record<string, number>>(initialUnavailable ? {} : { [ALPHA_LOCATION_ID]: initialFiles.length });

	async function countLinked() {
		const linked = locState?.locations.filter((l) => l.kind !== 'alpha' && l.status === 'ok') ?? [];
		const read = await Promise.all(
			linked.map(async (l) => {
				const res = await fetch(`${base}/api/storage?location=${encodeURIComponent(l.id)}`).catch(() => null);
				if (!res?.ok) return null;
				const data = (await res.json().catch(() => null)) as { files?: unknown[] } | null;
				return Array.isArray(data?.files) ? ([l.id, data.files.length] as const) : null;
			}),
		);
		const next: Record<string, number> = counts[ALPHA_LOCATION_ID] !== undefined ? { [ALPHA_LOCATION_ID]: counts[ALPHA_LOCATION_ID] } : {};
		for (const entry of read) if (entry) next[entry[0]] = entry[1];
		counts = next;
	}

	async function reloadLocations() {
		const res = await fetch(`${base}/api/storage/locations`).catch(() => null);
		if (res?.ok) locState = await res.json();
		await countLinked();
	}

	onMount(() => {
		if (locState) void countLinked();
	});
</script>

<div class="flex flex-col gap-10" data-testid="storage-settings">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="m-0 type-body text-fg-2">{m.storage_filesAreElsewhere()}</p>
		<Button variant="secondary" size="sm" href={`${base}/storage`} data-testid="open-your-files"
			>{m.storage_openYourFiles()}</Button
		>
	</div>

	<section class="flex flex-col gap-3" aria-labelledby="storage-usage-heading" data-testid="storage-usage">
		<div class="flex flex-col gap-1">
			<h2 id="storage-usage-heading" class="m-0 type-label text-fg-1">{m.storage_usageTitle()}</h2>
			<p class="m-0 type-caption text-fg-2">{m.storage_usageHelp()}</p>
		</div>
		{#if initialUnavailable}
			<p class="m-0 type-body text-fg-2" role="status">
				{initialBusy ? STORAGE_BUSY_MESSAGE : m.storage_unavailableTitle()}
			</p>
		{:else}
			<StorageUsage {fileCount} {totalBytes} showWarning />
		{/if}
	</section>

	<!-- CUR-2930: linked buckets, the default location, and linking a bucket of your own (CUR-415),
	     behind the `storage-locations` flag. -->
	{#if locState}
		<StorageLocations locations={locState} {counts} onChanged={reloadLocations} />
	{/if}

	<section class="flex flex-col gap-3" aria-labelledby="storage-where-kept-heading" data-testid="storage-where-kept-section">
		<h2 id="storage-where-kept-heading" class="m-0 type-label text-fg-1">{m.storage_whereKept()}</h2>
		<!-- Only what is true today (CUR-415): the files sit in a Hugging Face storage bucket
		     Current AI holds (custodialStorage.ts, custodialBucketRepo), not "inside Alpha". Nothing
		     here claims per-person isolation or where Hugging Face's own servers are (CUR-1288, CUR-416).
		     It says who Current AI is, since the sentence is the first place a visitor meets it
		     (CUR-2070). Once a bucket of the person's own is linked, "you don't need a Hugging Face
		     account" is false for that bucket, so the sentence speaks of Alpha storage alone (CUR-2930). -->
		<p class="m-0 type-body text-fg-2" data-testid="storage-where-kept">
			{hasLinkedBucket ? m.storage_whereKeptBodyLinked() : m.storage_whereKeptBody()}
		</p>
	</section>
</div>
