<!--
  @component
  Copy edit mode's panel, bottom right: what has changed, where the changes are saved, a search for
  text the page can't offer a click on (tooltips, screen-reader labels), and the way out. Opening
  the mode asks where to save first; leaving it with changes that haven't reached a file asks again.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { locales, type Locale } from '$lib/i18n/locales';
	import { setInterfaceLocale } from '$lib/i18n/client.svelte';
	import { Badge, Button, Dialog, Input, Textarea, Toggle, ToggleGroup } from '@aipotluck/alpha-ds';
	import RiSubtractLine from '~icons/ri/subtract-line';
	import RiAddLine from '~icons/ri/add-line';
	import { placeholders } from './markers';
	import { parseEditsFile } from './editsFile';
	import {
		allKeys,
		copyEdit,
		discardAll,
		editFor,
		hasUnsaved,
		listEdits,
		loadFile,
		markStarted,
		revertEdit,
		setEdit,
		setOn,
		setTool
	} from './state.svelte';
	import {
		canSaveToFile,
		chooseFile,
		download,
		onFileStatus,
		pickFileToLoad,
		reconnect,
		stopUsingFile
	} from './fileSave';

	let { catalogs }: { catalogs: Record<string, Record<string, string>> } = $props();

	let fileStatus = $state<'none' | 'connected' | 'needs-permission'>('none');
	onMount(() => onFileStatus((s) => (fileStatus = s)));

	let collapsed = $state(false);
	let query = $state('');
	let openKey = $state<string | null>(null);
	let loadError = $state('');
	let exitOpen = $state(false);
	let discardOpen = $state(false);
	const startOpen = $derived(copyEdit.on && !copyEdit.started);

	const locale = $derived((void copyEdit.version, getLocale()));
	const edits = $derived((void copyEdit.version, listEdits()));
	const unsaved = $derived((void copyEdit.revision, void copyEdit.savedRevision, hasUnsaved()));

	const source = (loc: string, key: string) => catalogs[loc]?.[key] ?? catalogs.en?.[key] ?? '';

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];
		const out: string[] = [];
		for (const key of allKeys()) {
			const text = editFor(locale, key)?.text ?? source(locale, key);
			if (text.toLowerCase().includes(q) || key.toLowerCase().includes(q)) out.push(key);
			if (out.length >= 25) break;
		}
		return out;
	});

	// Row editor: one key, every language.
	let drafts = $state<Record<string, string>>({});
	let rowError = $state('');
	function openRow(key: string) {
		openKey = openKey === key ? null : key;
		rowError = '';
		drafts = Object.fromEntries(locales.map((l) => [l, editFor(l, key)?.text ?? source(l, key)]));
	}
	function saveRow(key: string, loc: string) {
		const want = placeholders(catalogs.en?.[key] ?? '').join();
		if (placeholders(drafts[loc] ?? '').join() !== want) {
			rowError = `Keep the same {placeholders} as the English: ${want || 'none'}.`;
			return;
		}
		rowError = '';
		setEdit(loc, key, drafts[loc] ?? '', editFor(loc, key)?.original ?? source(loc, key));
	}

	async function saveToFile() {
		const name = await chooseFile();
		if (name) markStarted(name);
	}

	async function loadFromFile() {
		loadError = '';
		const picked = await pickFileToLoad();
		if (!picked) return;
		try {
			loadFile(parseEditsFile(picked.text), picked.name);
			markStarted();
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		}
	}

	function exit() {
		if (hasUnsaved()) exitOpen = true;
		else setOn(false);
	}
</script>

<section
	class="fixed right-4 bottom-4 z-toast flex max-h-[80vh] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-card border border-line-2 bg-surface-2 text-fg-1 shadow-popover"
	aria-label="Text editing"
	data-copy-edit-panel
>
	<header class="flex items-center gap-2 border-b border-line-1 px-3 py-2">
		<span class="type-label text-fg-1">Editing text</span>
		<Badge>Dev</Badge>
		<span class="ml-auto"></span>
		<ToggleGroup
			value={[copyEdit.tool]}
			onValueChange={(v: string[]) => v[0] && setTool(v[0] as 'edit' | 'browse')}
			aria-label="Clicks on the page"
		>
			<Toggle value="edit" data-copy-edit-tool="edit">Edit</Toggle>
			<Toggle value="browse" data-copy-edit-tool="browse">Browse</Toggle>
		</ToggleGroup>
		<Button
			size="icon"
			variant="ghost"
			aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
			onclick={() => (collapsed = !collapsed)}
		>
			{#if collapsed}<RiAddLine aria-hidden="true" />{:else}<RiSubtractLine
					aria-hidden="true"
				/>{/if}
		</Button>
	</header>

	{#if !collapsed}
		<div class="flex min-h-0 scroll-fade-y flex-col gap-4 overflow-y-auto p-3">
			<p class="type-caption text-fg-3">
				Click any text on the page to change it. Hold Alt (Option on a Mac) to click through to the
				page, or switch to Browse.
			</p>

			<div
				class="flex flex-wrap items-center gap-1.5"
				role="group"
				aria-label="Language you are editing"
			>
				{#each locales as l (l)}
					<Button
						size="xs"
						casing="sentence"
						variant={l === locale ? 'primary' : 'secondary'}
						aria-pressed={l === locale}
						onclick={() => setInterfaceLocale(l as Locale)}
					>
						{l.toUpperCase()}
					</Button>
				{/each}
			</div>

			<!-- Where the edits are saved -->
			<div
				class="flex flex-col gap-2 rounded-sharp border border-line-1 p-2.5"
				data-copy-edit-save-status
			>
				{#if fileStatus === 'connected' && copyEdit.fileName}
					<p class="type-caption text-fg-2">
						{unsaved ? 'Saving to' : 'Saved to'}
						<span class="font-mono text-fg-1">{copyEdit.fileName}</span>
					</p>
				{:else if fileStatus === 'needs-permission' && copyEdit.fileName}
					<p class="type-caption text-fg-1">
						Allow saving to {copyEdit.fileName} again to keep it up to date.
					</p>
					<Button
						size="xs"
						variant="primary"
						casing="sentence"
						class="self-start"
						onclick={() => reconnect()}>Allow saving</Button
					>
				{:else}
					<p class="type-caption {unsaved ? 'text-fg-1' : 'text-fg-2'}">
						{#if unsaved}
							{copyEdit.count}
							{copyEdit.count === 1 ? 'change is' : 'changes are'} only in this browser. Save a file to
							keep them safe.
						{:else if copyEdit.count}
							All changes are in your downloaded file.
						{:else}
							No changes yet.
						{/if}
					</p>
				{/if}
				<div class="flex flex-wrap gap-1.5">
					{#if canSaveToFile() && fileStatus === 'none'}
						<Button
							size="xs"
							variant={unsaved ? 'primary' : 'secondary'}
							casing="sentence"
							onclick={saveToFile}>Save to a file…</Button
						>
					{/if}
					<Button
						size="xs"
						variant={unsaved && !canSaveToFile() ? 'primary' : 'secondary'}
						casing="sentence"
						onclick={download}
						data-copy-edit-download
					>
						Download
					</Button>
					<Button size="xs" variant="ghost" casing="sentence" onclick={loadFromFile}
						>Load a file…</Button
					>
					{#if fileStatus !== 'none'}
						<Button size="xs" variant="ghost" casing="sentence" onclick={() => stopUsingFile()}
							>Stop saving to file</Button
						>
					{/if}
				</div>
				{#if loadError}<p class="type-caption text-accent-2-text" role="alert">{loadError}</p>{/if}
			</div>

			{#snippet row(key: string)}
				<div class="flex flex-col gap-2 border-t border-line-1 pt-2">
					{#each locales as l (l)}
						<label class="flex flex-col gap-1">
							<span class="flex items-center gap-1.5 type-caption text-fg-3">
								<span class="font-mono">{l.toUpperCase()}</span>
								{#if editFor(l, key)}<Badge>Edited</Badge>{/if}
							</span>
							<Textarea minRows={1} maxRows={6} bind:value={drafts[l]} />
							<span class="flex gap-1.5">
								<Button
									size="xs"
									variant="secondary"
									casing="sentence"
									disabled={drafts[l] === (editFor(l, key)?.text ?? source(l, key))}
									onclick={() => saveRow(key, l)}
								>
									Save {l.toUpperCase()}
								</Button>
								{#if editFor(l, key)}
									<Button
										size="xs"
										variant="ghost"
										casing="sentence"
										onclick={() => {
											revertEdit(l, key);
											drafts[l] = source(l, key);
										}}>Revert</Button
									>
								{/if}
							</span>
						</label>
					{/each}
					{#if rowError}<p class="type-caption text-accent-2-text" role="alert">{rowError}</p>{/if}
				</div>
			{/snippet}

			<!-- Changes -->
			<div class="flex flex-col gap-2" data-copy-edit-changes>
				<h3 class="type-label text-fg-2">
					{edits.length}
					{edits.length === 1 ? 'change' : 'changes'}
				</h3>
				{#each edits as e (`${e.locale}:${e.key}`)}
					<div
						class="flex flex-col gap-1 rounded-sharp border border-line-1 p-2"
						data-copy-edit-change={e.key}
					>
						<div class="flex items-center gap-1.5 type-caption">
							<span class="font-mono text-fg-1">{e.locale.toUpperCase()}</span>
							<button
								type="button"
								class="min-w-0 truncate text-left font-mono text-fg-3 hover:text-fg-1"
								title={e.key}
								onclick={() => openRow(e.key)}>{e.key}</button
							>
							<Button
								size="xs"
								variant="ghost"
								casing="sentence"
								class="ml-auto"
								onclick={() => revertEdit(e.locale, e.key)}>Revert</Button
							>
						</div>
						<p class="type-caption text-fg-3 line-through">{e.original}</p>
						<p class="type-body text-fg-1">{e.text}</p>
						{#if openKey === e.key}{@render row(e.key)}{/if}
					</div>
				{/each}
			</div>

			<!-- Search, for text with nothing to click -->
			<div class="flex flex-col gap-2">
				<h3 class="type-label text-fg-2">Find text</h3>
				<Input
					size="sm"
					bind:value={query}
					placeholder="Tooltips, labels, anything you can't click"
					aria-label="Find text"
				/>
				{#each results as key (key)}
					<div class="flex flex-col gap-1">
						<button
							type="button"
							class="flex flex-col items-start gap-0.5 text-left hover:text-fg-1"
							onclick={() => openRow(key)}
						>
							<span class="type-body text-fg-1"
								>{editFor(locale, key)?.text ?? source(locale, key)}</span
							>
							<span class="type-caption font-mono text-fg-3">{key}</span>
						</button>
						{#if openKey === key}{@render row(key)}{/if}
					</div>
				{/each}
			</div>
		</div>

		<footer class="flex items-center gap-2 border-t border-line-1 px-3 py-2">
			{#if edits.length}
				<Button size="xs" variant="ghost" casing="sentence" onclick={() => (discardOpen = true)}
					>Discard all…</Button
				>
			{/if}
			<Button
				size="xs"
				variant="secondary"
				casing="sentence"
				class="ml-auto"
				onclick={exit}
				data-copy-edit-exit>Stop editing</Button
			>
		</footer>
	{/if}
</section>

<Dialog.Root open={startOpen} onOpenChange={(o) => !o && markStarted()}>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" class="ds-root" data-mode="dark" data-copy-edit-ui data-copy-edit-start>
			<Dialog.Title>Where should your changes be saved?</Dialog.Title>
			<Dialog.Description>
				Every change is kept in this browser as you make it. Save to a file as well, so the changes
				are on your computer and can be sent to the team to load into the app.
			</Dialog.Description>
			<div class="mt-4 flex flex-col gap-2">
				{#if canSaveToFile()}
					<Button variant="primary" casing="sentence" block onclick={saveToFile}
						>Choose a file to save to…</Button
					>
				{/if}
				<Button variant="secondary" casing="sentence" block onclick={loadFromFile}
					>Continue from a file I saved before…</Button
				>
				<Button
					variant="ghost"
					casing="sentence"
					block
					onclick={() => markStarted()}
					data-copy-edit-start-browser
				>
					Keep them in this browser for now
				</Button>
				{#if loadError}<p class="type-caption text-accent-2-text" role="alert">{loadError}</p>{/if}
			</div>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>

<Dialog.Root bind:open={exitOpen}>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" class="ds-root" data-mode="dark" data-copy-edit-ui>
			<Dialog.Title>Save your changes before you stop?</Dialog.Title>
			<Dialog.Description>
				{copyEdit.count}
				{copyEdit.count === 1 ? 'change hasn’t' : 'changes haven’t'} been saved to a file. They stay in
				this browser either way, and come back when you start editing again.
			</Dialog.Description>
			<div class="mt-4 flex flex-col gap-2">
				<Button
					variant="primary"
					casing="sentence"
					block
					onclick={() => {
						download();
						exitOpen = false;
						setOn(false);
					}}>Download and stop</Button
				>
				<Button
					variant="secondary"
					casing="sentence"
					block
					onclick={() => {
						exitOpen = false;
						setOn(false);
					}}>Stop, keep them in this browser</Button
				>
				<Button variant="ghost" casing="sentence" block onclick={() => (exitOpen = false)}
					>Keep editing</Button
				>
			</div>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>

<Dialog.Root bind:open={discardOpen}>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" class="ds-root" data-mode="dark" data-copy-edit-ui>
			<Dialog.Title
				>Discard all {edits.length} {edits.length === 1 ? 'change' : 'changes'}?</Dialog.Title
			>
			<Dialog.Description>
				This removes them from this browser. A file you saved or downloaded keeps them.
			</Dialog.Description>
			<div class="mt-4 flex gap-2">
				<Button
					variant="destructive"
					casing="sentence"
					onclick={() => {
						discardAll();
						discardOpen = false;
					}}>Discard</Button
				>
				<Button variant="ghost" casing="sentence" onclick={() => (discardOpen = false)}
					>Cancel</Button
				>
			</div>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
