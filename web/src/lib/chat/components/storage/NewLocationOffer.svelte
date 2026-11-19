<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Checkbox, Inline } from '@aipotluck/alpha-ds';
	import { base } from '$lib/chat/paths';
	import { m } from '$lib/paraglide/messages.js';
	import { formatBytes } from './formatBytes';
	import { ALPHA_LOCATION_ID, type LocationSummary } from './locationTypes';
	import { sendStorageJson } from './storageRequest';

	// Right after a bucket is linked or connected, offer to save new files there and to copy
	// what is already in Alpha storage. Copy only: old chats read their attachments from Alpha storage
	// (downloadFile.ts) and nothing rewrites those references, so deleting the Alpha copies would break
	// them. Each copy is checked against the original's size on the server; a copy that fails stops,
	// and Retry resumes from that file. Per-file rows with a retry follow Uppy's file list (MIT). A
	// name already taken in the bucket never stops the copy: the server keeps both (`keepBoth`).
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
				result = m.storage_offerSaveFailed();
				onChanged();
				return;
			}
		}
		if (!copyMine || rows.length === 0) {
			phase = 'done';
			result = saveThere ? m.storage_offerNewFilesGo({ label: location.label }) : '';
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
				row.why = reply?.message ?? m.storage_offerConnectionDropped();
				const made =
					copiedCount > 0
						? ' ' +
							(copiedCount === 1
								? m.storage_offerKeptOne({ label: location.label })
								: m.storage_offerKeptMany({ count: copiedCount, label: location.label }))
						: '';
				result = `${m.storage_offerStopped({ name: nameOf(row.path), why: row.why })}${made}`;
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
				return m.storage_offerRowWaiting();
			case 'copying':
				return m.storage_offerRowCopying();
			case 'copied':
				if (row.already) return m.storage_offerRowAlready();
				if (row.savedAs) return m.storage_offerRowRenamed({ name: row.savedAs });
				return m.storage_offerRowCopied();
			case 'failed':
				return m.storage_offerRowFailed({ why: row.why ?? '' });
		}
	};

	const copiedText = $derived(
		rows.length === 1
			? m.storage_offerCopiedOne()
			: rows.length === 2
				? m.storage_offerCopiedTwo()
				: m.storage_offerCopiedAll({ count: rows.length }),
	);
	const failedName = $derived(nameOf(rows.find((r) => r.state === 'failed')?.path ?? ''));
</script>

<section
	class="flex flex-col gap-3 rounded-sharp border border-line-2 bg-surface-raised p-3"
	aria-label={m.storage_offerAria({ label: location.label })}
	data-testid="storage-move-offer"
>
	{#if phase === 'choose'}
		<span class="type-body text-fg-1">{m.storage_offerTitle({ label: location.label })}</span>
		<label class="flex items-start gap-2 type-body text-fg-1">
			<Checkbox.Root bind:checked={saveThere} class="mt-0.5"><Checkbox.Indicator /></Checkbox.Root>
			<span class="flex flex-col">
				{m.storage_offerSaveNew()}
				<span class="type-caption text-fg-2">{m.storage_offerSaveNewHelp()}</span>
			</span>
		</label>
		{#if rows.length > 0}
			<label class="flex items-start gap-2 type-body text-fg-1">
				<Checkbox.Root bind:checked={copyMine} class="mt-0.5"><Checkbox.Indicator /></Checkbox.Root>
				{rows.length === 1
					? m.storage_offerCopyOne({ size: formatBytes(totalBytes) })
					: m.storage_offerCopyMany({ count: rows.length, size: formatBytes(totalBytes) })}
			</label>
			<p class="m-0 type-caption text-fg-2">
				{m.storage_offerCopyHelp()}
			</p>
		{/if}
		<Inline gap="2" justify="end">
			<Button size="sm" variant="ghost" onclick={onClose}>{m.storage_offerNotNow()}</Button>
			<Button size="sm" variant="primary" onclick={proceed} disabled={!saveThere && !copyMine}>{m.storage_offerContinue()}</Button>
		</Inline>
	{:else if phase === 'failed' || phase === 'done'}
		{#if result}
			<p class="m-0 type-body text-fg-1" role={phase === 'failed' ? 'alert' : 'status'}>{result}</p>
		{/if}
		<Inline justify="end">
			<Button size="sm" variant="ghost" onclick={onClose}>{m.storage_offerClose()}</Button>
		</Inline>
	{:else}
		{#if phase === 'copying'}
			<p class="m-0 type-body text-fg-1" role="status">
				{m.storage_offerCopying({ current: Math.min(copiedCount + 1, rows.length), total: rows.length, label: location.label })}
			</p>
		{:else if phase === 'stopped'}
			<p class="m-0 type-body text-fg-1" role="alert">{result}</p>
		{:else if phase === 'copied'}
			<p class="m-0 type-body text-fg-1" role="status">
				{m.storage_offerCopiedLine({ copied: copiedText, where })}
			</p>
		{/if}
		<ul class="m-0 flex list-none flex-col gap-1 p-0" aria-label={m.storage_offerFilesAria()}>
			{#each rows as row (row.path)}
				<li class="flex items-baseline justify-between gap-3 type-caption" data-state={row.state}>
					<span class="min-w-0 truncate text-fg-1">{nameOf(row.path)} · {formatBytes(row.size)}</span>
					<span class={row.state === 'failed' ? 'text-fg-1' : 'text-fg-2'}>{rowText(row)}</span>
				</li>
			{/each}
		</ul>
		{#if phase === 'stopped'}
			<Inline gap="2" justify="end">
				<Button size="sm" variant="ghost" onclick={onClose}>{m.storage_offerStop()}</Button>
				<Button size="sm" variant="primary" onclick={copyRemaining}>{m.storage_offerRetry({ name: failedName })}</Button>
			</Inline>
		{:else if phase === 'copied'}
			<Inline justify="end">
				<Button size="sm" variant="ghost" onclick={onClose}>{m.storage_offerClose()}</Button>
			</Inline>
		{/if}
	{/if}
</section>
