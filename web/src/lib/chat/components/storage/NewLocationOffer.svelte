<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Checkbox, Inline } from '@aipotluck/alpha-ds';
	import { base } from '$lib/chat/paths';
	import { formatBytes } from './formatBytes';
	import { ALPHA_LOCATION_ID, type LocationSummary } from './locationTypes';
	import { sendStorageJson } from './storageRequest';

	// Right after a bucket is linked or connected, offer to save new files there and to copy
	// what is already in Alpha storage. Copy only: old chats read their attachments from Alpha storage
	// (downloadFile.ts) and nothing rewrites those references, so deleting the Alpha copies would break
	// them. Each copy is checked against the original's size on the server; a copy that fails stops,
	// and Retry resumes from that file. Per-file rows with a retry follow Uppy's file list (MIT). A
	// name already taken in the bucket never stops the copy: the server keeps both (`keepBoth`). (CUR-2941)
	interface Props {
		location: LocationSummary;
		onChanged: () => void;
		onClose: () => void;
	}
	let { location, onChanged, onClose }: Props = $props();

	type RowState = 'waiting' | 'copying' | 'copied' | 'failed';
	type Row = { path: string; size: number; state: RowState; why?: string; savedAs?: string; already?: boolean };
	let rows = $state<Row[]>([]);
	let saveThere = $state(true);
	let copyMine = $state(false);
	let phase = $state<'choose' | 'copying' | 'stopped' | 'copied' | 'done' | 'failed'>('choose');
	let result = $state('');

	const totalBytes = $derived(rows.reduce((sum, r) => sum + r.size, 0));
	const copiedCount = $derived(rows.filter((r) => r.state === 'copied').length);
	const fileWord = (n: number) => (n === 1 ? 'file' : 'files');
	const nameOf = (path: string) => path.split('/').pop() || path;
	const where = $derived(location.detail ? `${location.label} (${location.detail})` : location.label);

	// The copy runs from this tab, so closing it mid-copy stops it. Ask the browser to warn first;
	// nothing is lost either way, since a copy never deletes and Retry resumes.
	$effect(() => {
		if (phase !== 'copying') return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener('beforeunload', warn);
		return () => window.removeEventListener('beforeunload', warn);
	});

	onMount(async () => {
		const res = await fetch(`${base}/api/storage`).catch(() => null);
		if (!res?.ok) return;
		const { files } = (await res.json()) as { files: { path: string; size: number }[] };
		rows = files.map((f) => ({ path: f.path, size: f.size, state: 'waiting' }));
	});

	async function proceed() {
		if (saveThere) {
			const saved = await sendStorageJson('locations/default', 'PUT', { location: location.id });
			if (!saved?.ok) {
				phase = 'failed';
				result = 'Couldn’t save that choice, so nothing was copied. Try again from the list below.';
				onChanged();
				return;
			}
		}
		if (!copyMine || rows.length === 0) {
			phase = 'done';
			result = saveThere ? `New files now go to ${location.label}.` : '';
			onChanged();
			if (!saveThere) onClose();
			return;
		}
		await copyRemaining();
	}

	// Copies every row not yet copied, in order, so a Retry picks up at the file that failed.
	async function copyRemaining() {
		phase = 'copying';
		for (const row of rows) {
			if (row.state === 'copied') continue;
			row.state = 'copying';
			row.why = undefined;
			const reply = await sendStorageJson('transfer', 'POST', {
				from: ALPHA_LOCATION_ID,
				to: location.id,
				path: row.path,
				mode: 'copy',
				ifNameTaken: 'keepBoth',
			});
			if (!reply?.ok) {
				row.state = 'failed';
				row.why = reply?.message ?? 'The connection dropped.';
				const made =
					copiedCount > 0
						? ` The ${copiedCount} ${fileWord(copiedCount)} already copied stay in ${location.label}.`
						: '';
				result = `${nameOf(row.path)} didn’t copy: ${row.why} Nothing in Alpha storage changed.${made}`;
				phase = 'stopped';
				onChanged();
				return;
			}
			row.state = 'copied';
			row.already = reply.outcome === 'alreadyThere';
			row.savedAs = reply.outcome === 'renamed' && reply.path ? nameOf(reply.path) : undefined;
		}
		phase = 'copied';
		onChanged();
	}

	const rowText = (row: Row): string => {
		switch (row.state) {
			case 'waiting':
				return 'Waiting';
			case 'copying':
				return 'Copying…';
			case 'copied':
				if (row.already) return 'Already there, the same file';
				if (row.savedAs) return `Copied as ${row.savedAs}, since that name was taken`;
				return 'Copied, same size as the original';
			case 'failed':
				return `Didn’t copy: ${row.why}`;
		}
	};

	const copiedText = $derived(
		rows.length === 1 ? 'Your file is copied' : rows.length === 2 ? 'Both files are copied' : `All ${rows.length} files are copied`,
	);
	const failedName = $derived(nameOf(rows.find((r) => r.state === 'failed')?.path ?? ''));
</script>

<section
	class="flex flex-col gap-3 rounded-sharp border border-line-2 bg-surface-raised p-3"
	aria-label={`Use ${location.label}`}
	data-testid="storage-move-offer"
>
	{#if phase === 'choose'}
		<span class="type-body text-fg-1">Use {location.label} for your files?</span>
		<label class="flex items-start gap-2 type-body text-fg-1">
			<Checkbox.Root bind:checked={saveThere} class="mt-0.5"><Checkbox.Indicator /></Checkbox.Root>
			<span class="flex flex-col">
				Save new files there
				<span class="type-caption text-fg-2">Only files you add from now on. This by itself copies nothing.</span>
			</span>
		</label>
		{#if rows.length > 0}
			<label class="flex items-start gap-2 type-body text-fg-1">
				<Checkbox.Root bind:checked={copyMine} class="mt-0.5"><Checkbox.Indicator /></Checkbox.Root>
				Also copy my {rows.length}
				{fileWord(rows.length)} ({formatBytes(totalBytes)}) from Alpha storage
			</label>
			<p class="m-0 type-caption text-fg-2">
				Each file is copied and checked. Alpha storage keeps its copies, so your chats still open their attachments.
			</p>
		{/if}
		<Inline gap="2" justify="end">
			<Button size="sm" variant="ghost" onclick={onClose}>Not now</Button>
			<Button size="sm" variant="primary" onclick={proceed} disabled={!saveThere && !copyMine}>Continue</Button>
		</Inline>
	{:else if phase === 'failed' || phase === 'done'}
		{#if result}
			<p class="m-0 type-body text-fg-1" role={phase === 'failed' ? 'alert' : 'status'}>{result}</p>
		{/if}
		<Inline justify="end">
			<Button size="sm" variant="ghost" onclick={onClose}>Close</Button>
		</Inline>
	{:else}
		{#if phase === 'copying'}
			<p class="m-0 type-body text-fg-1" role="status">
				Copying {Math.min(copiedCount + 1, rows.length)} of {rows.length} to {location.label}…
			</p>
		{:else if phase === 'stopped'}
			<p class="m-0 type-body text-fg-1" role="alert">{result}</p>
		{:else if phase === 'copied'}
			<p class="m-0 type-body text-fg-1" role="status">
				{copiedText} to {where}. Alpha storage keeps its copies, so your chats still open their attachments.
			</p>
		{/if}
		<ul class="m-0 flex list-none flex-col gap-1 p-0" aria-label="Files being copied">
			{#each rows as row (row.path)}
				<li class="flex items-baseline justify-between gap-3 type-caption" data-state={row.state}>
					<span class="min-w-0 truncate text-fg-1">{nameOf(row.path)} · {formatBytes(row.size)}</span>
					<span class={row.state === 'failed' ? 'text-fg-1' : 'text-fg-2'}>{rowText(row)}</span>
				</li>
			{/each}
		</ul>
		{#if phase === 'stopped'}
			<Inline gap="2" justify="end">
				<Button size="sm" variant="ghost" onclick={onClose}>Stop here</Button>
				<Button size="sm" variant="primary" onclick={copyRemaining}>Retry from {failedName}</Button>
			</Inline>
		{:else if phase === 'copied'}
			<Inline justify="end">
				<Button size="sm" variant="ghost" onclick={onClose}>Close</Button>
			</Inline>
		{/if}
	{/if}
</section>
