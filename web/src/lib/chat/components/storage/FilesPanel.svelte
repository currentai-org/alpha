<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';
	import { sendStorageJson } from './storageRequest';
	import { sendUpload } from './sendUpload';
	import { myFilesChanged } from '$lib/chat/utils/myFilesHeadroom';
	import { storablePhoto } from '$lib/chat/utils/shrinkImage';
	import {
		custodialMaxBytesPerFile,
		STORAGE_BUSY_MESSAGE,
		storageRefusalMessage,
		storageRefusalRecovery,
		storageUsage,
	} from '$lib/chat/constants/custodialUpload';
	import DropZone from './DropZone.svelte';
	import FileRow from './FileRow.svelte';
	import LoadingList from './LoadingList.svelte';
	import StorageUnavailable from './StorageUnavailable.svelte';
	import StorageNotice from './StorageNotice.svelte';
	import ConfirmDeleteDialog from './ConfirmDeleteDialog.svelte';
	import StorageUsage from './StorageUsage.svelte';
	import ChooseLocationDialog from './ChooseLocationDialog.svelte';
	import TransferDialog from './TransferDialog.svelte';
	import { ALPHA_LOCATION_ID, ASK_EVERY_TIME, type LocationsState, locationLabel } from './locationTypes';
	import FilePreviewDialog from './FilePreviewDialog.svelte';
	import { THUMBNAIL_MAX_BYTES } from './previewKind';
	import { Button, Tabs } from '@aipotluck/alpha-ds';
	import { formatBytes } from './formatBytes';
	import RiRefreshLine from '~icons/ri/refresh-line';

	// CUR-1276. The Files destination, built on the real --ap-* tokens (see design-system.md) and the
	// real API contract (web/src/routes/chat/api/storage/). Self-contained — it owns its own fetch
	// calls and state — so an in-chat overlay entry point (matching XRAY VIEW's slide-in mechanics in
	// ChatWindow.svelte) can mount this same component rather than duplicate it. It ships as its own
	// route; see +page.svelte.
	//
	// Deliberately simpler than the design:
	//  - No per-row "issue" banner for a failed download — a
	//    failed download surfaces as a panel-level Notice instead, same as delete.
	//  - No client-side file-type pre-check. custodialStorage.ts sniffs magic bytes, never the
	//    filename or a declared MIME (see custodialUpload.ts) — duplicating that sniff here would be
	//    a second, weaker copy of a check the server already owns. Size IS pre-checked client-side
	//    (cheap, exact, and avoids burning an upload attempt on a file that can't fit).

	type StoredRow = {
		kind: 'stored';
		id: string;
		name: string;
		sizeBytes: number;
		addedAt?: string;
		conversationId?: string;
	};
	type ListedFile = { path: string; size: number; addedAt?: string };
	type UploadingRow = { kind: 'uploading'; id: string; name: string; sizeBytes: number; progress: number };
	type ErrorRow = {
		kind: 'error';
		id: string;
		name: string;
		sizeBytes: number;
		message: string;
		recovery: 'retry' | 'remove';
		file?: File;
		/** Where the failed upload was going, so a retry goes there too rather than to whatever is open. */
		target?: string;
	};
	type Row = StoredRow | UploadingRow | ErrorRow;

	interface Props {
		initialFiles: ListedFile[];
		/** True when +page.server.ts's own listCustodialFiles call failed — the page still renders,
		 *  starting in the Unavailable state instead of claiming an empty list. */
		initialUnavailable?: boolean;
		/** The server-side listing failed because Hugging Face throttled the storage token. (CUR-3680) */
		initialBusy?: boolean;
		/** The account's storage locations, or null when the `storage-locations` flag is off (CUR-2930)
		 *  for them — the panel is then Alpha storage only, exactly as before. */
		initialLocations?: LocationsState | null;
		/** The `chunked-uploads` flag for this account. On, a file up to the chunked ceiling (CUR-1780)
		 *  is sent in chunks, and the picker and refusals name that ceiling. */
		chunkedUploads?: boolean;
	}
	let {
		initialFiles,
		initialUnavailable = false,
		initialBusy = false,
		initialLocations = null,
		chunkedUploads = false,
	}: Props = $props();
	// The ceiling shown is the ceiling sent: one number for the picker, the refusal and the check.
	const maxBytesPerFile = $derived(custodialMaxBytesPerFile(chunkedUploads));

	let locState = $state<LocationsState | null>(initialLocations);
	// The location being browsed. Opens on the default when that is a place still in the list, and
	// uploads go to whichever location is open, so the default decides where a file lands unless the
	// person switches. `initialFiles` is always Alpha storage's listing, so a linked default starts
	// empty and loads its own list on mount rather than showing Alpha's files under its name.
	// `uploadsGoTo` already resolves "Last used" to a place (CUR-3077).
	const initialTarget = initialLocations?.uploadsGoTo;
	let viewing = $state(
		initialTarget &&
			initialTarget !== ASK_EVERY_TIME &&
			initialLocations?.locations.some((l) => l.id === initialTarget)
			? initialTarget
			: ALPHA_LOCATION_ID,
	);
	const openedOnAlpha = viewing === ALPHA_LOCATION_ID;
	const viewingAlpha = $derived(viewing === ALPHA_LOCATION_ID);
	const viewingLabel = $derived(locState?.locations.find((l) => l.id === viewing)?.label ?? 'Alpha storage');
	let pendingFiles = $state<File[]>([]);
	let chooseOpen = $state(false);

	/** `location=…` for a linked location, nothing for Alpha storage, so requests for Alpha storage carry no location. */
	function locationQuery(loc: string): string {
		return loc === ALPHA_LOCATION_ID ? '' : `location=${encodeURIComponent(loc)}`;
	}

	async function reloadLocations() {
		const res = await fetch(`${base}/api/storage/locations`).catch(() => null);
		if (res?.ok) {
			locState = await res.json();
			if (!locState?.locations.some((l) => l.id === viewing)) viewing = ALPHA_LOCATION_ID;
		}
	}

	// Each place's file count once its list has been read, so a tab can say how many files
	// it holds. Places never opened in this visit show no count rather than a guess. (CUR-4363)
	let counts = $state<Record<string, number>>(
		openedOnAlpha && !initialUnavailable ? { [ALPHA_LOCATION_ID]: initialFiles.length } : {},
	);
	function countFor(id: string): number | undefined {
		return id === viewing && loadState === 'ready' ? storedRows.length : counts[id];
	}

	function switchTo(id: string) {
		if (id === viewing) return;
		if (loadState === 'ready') counts = { ...counts, [viewing]: storedRows.length };
		viewing = id;
		rows = [];
		void reloadList();
	}

	function basenameOf(path: string): string {
		return path.split('/').pop() || path;
	}

	// The listing's full bucket keys, keyed by row id. The id is the full key too, never the basename:
	// two chats can each hold a shapes.png, and a basename id would give both rows one key and blank the
	// whole list (CUR-3198). Round-tripped to download/delete; never rebuilt by hand client-side, per
	// this API's own warning about CUR-928.
	let pathById = $state<Record<string, string>>(
		openedOnAlpha ? Object.fromEntries(initialFiles.map((f) => [f.path, f.path])) : {},
	);

	// A file attached in chat is kept at `users/<id>/conversations/<conversation>/…`, so the
	// conversation it came from is the segment after `conversations` (CUR-3289).
	function conversationOf(path: string): string | undefined {
		const parts = path.split('/');
		const at = parts.indexOf('conversations');
		return at >= 0 && parts.length > at + 2 ? parts[at + 1] : undefined;
	}

	function toStoredRow(f: ListedFile): StoredRow {
		return {
			kind: 'stored',
			id: f.path,
			name: basenameOf(f.path),
			sizeBytes: f.size,
			addedAt: f.addedAt,
			conversationId: conversationOf(f.path),
		};
	}

	let rows = $state<Row[]>(openedOnAlpha ? initialFiles.map(toStoredRow) : []);

	let loadState = $state<'ready' | 'loading' | 'unavailable'>(
		!openedOnAlpha ? 'loading' : initialUnavailable ? 'unavailable' : 'ready',
	);
	let notice = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	let confirmTarget = $state<StoredRow | null>(null);
	let confirmBusy = $state(false);
	let confirmError = $state<string | undefined>(undefined);

	const storedRows = $derived(rows.filter((r): r is StoredRow => r.kind === 'stored'));
	// Newest first, so a file just attached in chat is at the top rather than below every older one
	// (CUR-4355). Uploads in flight and failed ones go above the stored files, in the order they began.
	const shownRows = $derived([
		...rows.filter((r) => r.kind !== 'stored'),
		...[...storedRows].sort((a, b) => (Date.parse(b.addedAt ?? '') || 0) - (Date.parse(a.addedAt ?? '') || 0)),
	]);
	const totalBytes = $derived(storedRows.reduce((sum, r) => sum + r.sizeBytes, 0));
	const usage = $derived(storageUsage(totalBytes, storedRows.length));

	// Set when the listing answered that Hugging Face is throttling the storage token. (CUR-3680)
	let listBusy = $state<string | null>(openedOnAlpha && initialBusy ? STORAGE_BUSY_MESSAGE : null);

	async function reloadList() {
		loadState = 'loading';
		listBusy = null;
		try {
			const q = locationQuery(viewing);
			const res = await fetch(`${base}/api/storage${q ? `?${q}` : ''}`);
			if (res.status === 503) {
				const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
				if (body?.message === STORAGE_BUSY_MESSAGE) listBusy = STORAGE_BUSY_MESSAGE;
			}
			if (!res.ok) throw new Error(String(res.status));
			const data: { files: ListedFile[] } = await res.json();
			pathById = Object.fromEntries(data.files.map((f) => [f.path, f.path]));
			counts = { ...counts, [viewing]: data.files.length };
			const stored: Row[] = data.files.map(toStoredRow);
			// Keep any rows still mid-upload or mid-error — they aren't in a listing yet.
			rows = [...stored, ...rows.filter((r) => r.kind !== 'stored')];
			loadState = 'ready';
		} catch {
			loadState = 'unavailable';
			// A linked location that stopped answering is marked for reconnecting server side.
			if (!viewingAlpha) void reloadLocations();
		}
	}

	onMount(() => {
		if (!openedOnAlpha) void reloadList();
	});

	function toErrorRow(id: string, file: File, message: string, target?: string): ErrorRow {
		return { kind: 'error', id, name: file.name, sizeBytes: file.size, message, recovery: 'retry', file, target };
	}

	async function uploadOne(picked: File, target: string = viewing) {
		// An iPhone HEIC goes up as a JPEG, since the scanner cannot hash a HEIC. (CUR-4665)
		const file = await storablePhoto(picked);
		const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		if (file.size > maxBytesPerFile) {
			const tooLarge = toErrorRow(id, file, storageRefusalMessage(413, '', undefined, maxBytesPerFile));
			rows = [...rows, { ...tooLarge, recovery: 'remove' }];
			return;
		}

		rows = [...rows, { kind: 'uploading', id, name: file.name, sizeBytes: file.size, progress: 0 }];

		const result = await sendUpload(
			file,
			{ folder: 'documents', ...(locState ? { location: target } : {}) },
			chunkedUploads,
			(progress) => {
				rows = rows.map((r) => (r.id === id && r.kind === 'uploading' ? { ...r, progress } : r));
			},
		);
		if (result.status === 0) {
			const errored = toErrorRow(id, file, m.storage_uploadFailed(), target);
			rows = rows.map((r): Row => (r.id === id ? errored : r));
			return;
		}
		if (result.status >= 200 && result.status < 300) {
			// The composer's reused headroom no longer matches what is stored. (CUR-3681)
			myFilesChanged();
			rows = rows.filter((r) => r.id !== id);
			if (target !== viewing) {
				const where = locState?.locations.find((l) => l.id === target)?.label ?? m.storage_storage();
				notice = { tone: 'ok', text: m.storage_added({ name: file.name, where }) };
			}
			// "Last used" in the locations card now points here.
			if (locState) void reloadLocations();
			await reloadList();
			return;
		}
		let fallback = '';
		try {
			fallback = JSON.parse(result.body)?.message || '';
		} catch {
			// non-JSON error body — storageRefusalMessage supplies a line for the status
		}
		const errored = toErrorRow(
			id,
			file,
			storageRefusalMessage(result.status, fallback, result.retryAfter, maxBytesPerFile),
			target,
		);
		const recovery = storageRefusalRecovery(result.status);
		rows = rows.map((r): Row => (r.id === id ? { ...errored, recovery } : r));
	}

	function onFiles(files: File[]) {
		// "Ask every time" asks before anything is sent, then sends every dropped file to the one choice.
		// The server reports "ask" only while there is more than one place (CUR-3077): with Alpha storage
		// the only place, there is nothing to ask.
		if (locState?.uploadsGoTo === ASK_EVERY_TIME) {
			pendingFiles = files;
			chooseOpen = true;
			return;
		}
		for (const file of files) void uploadOne(file);
	}

	function onChosen(target: string) {
		for (const file of pendingFiles) void uploadOne(file, target);
		pendingFiles = [];
	}

	function retryRow(row: ErrorRow) {
		if (!row.file) return;
		rows = rows.filter((r) => r.id !== row.id);
		void uploadOne(row.file, row.target);
	}

	function removeRow(row: ErrorRow) {
		rows = rows.filter((r) => r.id !== row.id);
	}

	function fileUrl(row: StoredRow): string | undefined {
		const path = pathById[row.id];
		if (!path) return undefined;
		const q = locationQuery(viewing);
		return `${base}/api/storage/file?path=${encodeURIComponent(path)}${q ? `&${q}` : ''}`;
	}

	// The file a row opened in place. (CUR-3289)
	let previewTarget = $state<StoredRow | null>(null);
	let previewOpen = $state(false);
	function openRow(row: StoredRow) {
		previewTarget = row;
		previewOpen = true;
	}
	const chatHrefFor = (row: StoredRow) => (row.conversationId ? `${base}/conversation/${row.conversationId}` : undefined);

	function downloadRow(row: StoredRow) {
		const href = fileUrl(row);
		if (!href) return;
		const a = document.createElement('a');
		a.href = href;
		a.rel = 'noopener';
		// Without `download`, SvelteKit's client router takes this same-origin click as a page
		// navigation: the URL changes to the file endpoint and nothing is saved. `download` makes the
		// router leave it to the browser, and names the saved file.
		a.download = row.name;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	// Copy or move a stored file to another of the person's locations. (CUR-2931)
	let transferTarget = $state<StoredRow | null>(null);
	let transferOpen = $state(false);
	let transferBusy = $state(false);
	let transferError = $state<string | undefined>(undefined);
	const destinations = $derived(locState?.locations.filter((l) => l.id !== viewing) ?? []);
	const canTransfer = $derived(destinations.some((l) => l.status === 'ok'));

	function requestTransfer(row: StoredRow) {
		transferError = undefined;
		transferTarget = row;
		transferOpen = true;
	}

	async function runTransfer(to: string, mode: 'copy' | 'move') {
		if (!transferTarget) return;
		const path = pathById[transferTarget.id];
		if (!path) return;
		transferBusy = true;
		transferError = undefined;
		try {
			const reply = await sendStorageJson('transfer', 'POST', { from: viewing, to, path, mode });
			if (!reply?.ok) {
				transferError = reply?.message ?? m.storage_didntWork();
				return;
			}
			myFilesChanged();
			// The destination's count is stale now; it is read again when its tab is opened.
			counts = Object.fromEntries(Object.entries(counts).filter(([id]) => id !== to));
			const where = locState?.locations.find((l) => l.id === to)?.label ?? m.storage_otherLocation();
			notice = reply.warning
				? { tone: 'error', text: reply.warning }
				: { tone: 'ok', text: mode === 'move' ? m.storage_moved({ name: transferTarget.name, where }) : m.storage_copied({ name: transferTarget.name, where }) };
			transferOpen = false;
			transferTarget = null;
			await reloadList();
		} finally {
			transferBusy = false;
		}
	}

	function requestDelete(row: StoredRow) {
		confirmError = undefined;
		confirmTarget = row;
	}

	async function confirmDelete() {
		if (!confirmTarget) return;
		const path = pathById[confirmTarget.id];
		if (!path) return;
		confirmBusy = true;
		confirmError = undefined;
		try {
			const q = locationQuery(viewing);
			const res = await fetch(`${base}/api/storage/file?path=${encodeURIComponent(path)}${q ? `&${q}` : ''}`, {
				method: 'DELETE',
			});
			if (!res.ok) throw new Error(String(res.status));
			myFilesChanged();
			const deletedName = confirmTarget.name;
			rows = rows.filter((r) => r.id !== confirmTarget?.id);
			confirmTarget = null;
			notice = { tone: 'ok', text: m.storage_deleted({ name: deletedName }) };
		} catch {
			confirmError = m.storage_didntWork();
		} finally {
			confirmBusy = false;
		}
	}
</script>

<div class="relative flex h-full flex-col gap-4 overflow-y-auto bg-[var(--ap-stack-panel,var(--ap-paper))] p-4">
	<div class="flex items-center justify-between">
		<h1 class="m-0 font-sans text-[18px] font-bold text-[var(--ap-ink)]">{m.storage_yourFiles()}</h1>
		<button
			type="button"
			aria-label={m.storage_refreshList()}
			title={m.storage_refreshList()}
			onclick={reloadList}
			class="grid size-[30px] place-items-center rounded-[var(--ap-radius-1)] text-[var(--ap-ink-2)] hover:bg-[var(--ap-ink)]/5"
		>
			<RiRefreshLine class="size-4" />
		</button>
	</div>

	{#if notice}
		<StorageNotice tone={notice.tone} text={notice.text} onDismiss={() => (notice = null)} />
	{/if}

	<!-- CUR-4363: the places a person's files live are peers of one view, so they are tabs (Apple HIG tab
	     views; iOS Files' Locations): a real tablist with arrow, Home and End keys and a roving tab stop
	     (bits-ui's Tabs engine), each tab with its file count once known, and the list as its panel. The
	     open tab is where a dropped file goes, so the panel needs no separate "Adding to" line. -->
	{#if locState && locState.locations.length > 0}
		<!-- A segmented control: the places are few, and each is a whole view of the files. -->
		<Tabs.Root value={viewing} onValueChange={switchTo} variant="segment" class="gap-3">
			<Tabs.List aria-label={m.storage_location()} data-testid="location-tabs">
				{#each locState.locations as loc (loc.id)}
					{@const count = countFor(loc.id)}
					<Tabs.Tab value={loc.id} data-location-id={loc.id}>
						<span class="max-w-64 truncate">{locationLabel(loc)}</span>
						{#if count !== undefined}
							<span class="tabular-nums opacity-70" aria-hidden="true" data-testid="location-count"
								>{count}</span
							>
							<span class="sr-only">{count === 1 ? m.account_oneFile() : m.account_nFiles({ count })}</span>
						{/if}
					</Tabs.Tab>
				{/each}
			</Tabs.List>
			{#each locState.locations as loc (loc.id)}
				<Tabs.Panel value={loc.id} tabindex={-1} class="flex flex-col gap-4">
					{#if loc.id === viewing}{@render fileView()}{/if}
				</Tabs.Panel>
			{/each}
		</Tabs.Root>
	{:else}
		{@render fileView()}
	{/if}

	<!-- CUR-4363: where files are kept, where new ones go and linking a bucket are settings, so they live
	     in Settings → Storage; this page keeps the files and links there. -->
	<div class="flex justify-end">
		<Button variant="secondary" size="sm" href={`${base}/settings/storage`} data-testid="manage-storage"
			>{m.storage_manageStorage()}</Button
		>
	</div>
</div>

{#snippet fileView()}
	{#if loadState === 'loading'}
		<LoadingList />
	{:else if loadState === 'unavailable'}
		<StorageUnavailable onReload={reloadList} busy={listBusy} />
	{:else}
		{#if rows.length === 0}
			<div class="py-2 pb-3 text-center">
				<h3 class="m-0 mb-2 font-sans text-[16px] font-bold text-[var(--ap-ink)]">{m.storage_noFiles()}</h3>
				<p class="m-0 font-sans text-[13px] leading-[18px] text-[var(--ap-ink-3)]">
					{viewingAlpha
						? m.storage_noFilesHelp()
						: m.storage_nothingIn({ where: viewingLabel })}
				</p>
			</div>
		{:else if viewingAlpha}
			<StorageUsage fileCount={storedRows.length} {totalBytes} />
		{/if}

		<div class="flex flex-col gap-3">
			{#each shownRows as row (row.id)}
				{#if row.kind === 'stored'}
					<FileRow
						name={row.name}
						size={formatBytes(row.sizeBytes)}
						added={row.addedAt}
						chatHref={chatHrefFor(row)}
						thumbnailUrl={row.sizeBytes <= THUMBNAIL_MAX_BYTES ? fileUrl(row) : undefined}
						onOpen={() => openRow(row)}
						onDelete={() => requestDelete(row)}
						onDownload={() => downloadRow(row)}
						onTransfer={canTransfer ? () => requestTransfer(row) : undefined}
					/>
				{:else if row.kind === 'uploading'}
					<FileRow name={row.name} size={formatBytes(row.sizeBytes)} status="uploading" progress={row.progress} />
				{:else}
					<FileRow
						name={row.name}
						size={formatBytes(row.sizeBytes)}
						status="error"
						error={row.message}
						recovery={row.recovery}
						onRetry={() => retryRow(row)}
						onRemove={() => removeRow(row)}
					/>
				{/if}
			{/each}
		</div>

		<!-- CUR-2382: with no CSAM scanner configured every upload is refused, so none is offered. -->
		{#if !page.data.attachmentsEnabled}
			<p class="m-0 font-sans text-micro text-fg-3">
				{m.storage_addingOff()}
			</p>
		{:else}
			<!-- A file dropped here goes to the place whose tab is open (or, under "Ask every time", to the
			     place chosen in the dialog). -->
			<DropZone
				compact={rows.length > 0}
				accept={m.storage_acceptedTypes()}
				maxSize={formatBytes(maxBytesPerFile)}
				disabled={viewingAlpha && usage.fraction >= 1}
				{onFiles}
			/>
		{/if}
		{#if usage.warning}
			<p class="m-0 text-small text-fg-2" role="status" data-testid="storage-warning">
				{usage.warning}
			</p>
		{/if}
	{/if}
{/snippet}

{#if locState}
	<ChooseLocationDialog
		bind:open={chooseOpen}
		locations={locState.locations}
		count={pendingFiles.length}
		onChoose={onChosen}
	/>
{/if}

{#if transferTarget}
	<TransferDialog
		bind:open={transferOpen}
		name={transferTarget.name}
		fromLabel={viewingLabel}
		{destinations}
		busy={transferBusy}
		error={transferError}
		onTransfer={runTransfer}
	/>
{/if}

{#if previewTarget}
	{@const target = previewTarget}
	<FilePreviewDialog
		bind:open={previewOpen}
		name={target.name}
		fileUrl={fileUrl(target) ?? ''}
		chatHref={chatHrefFor(target)}
		onDownload={() => downloadRow(target)}
	/>
{/if}

{#if confirmTarget}
	<ConfirmDeleteDialog
		name={confirmTarget.name}
		busy={confirmBusy}
		error={confirmError}
		onConfirm={confirmDelete}
		onCancel={() => (confirmTarget = null)}
	/>
{/if}
