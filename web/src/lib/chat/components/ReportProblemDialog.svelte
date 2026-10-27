<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';
	import RiCheck from '~icons/ri/check-line';
	import RiFlagLine from '~icons/ri/flag-line';
	import { trackEvent } from '$lib/analytics';
	import { Button, Dialog, Radio, RadioGroup, Sheet, Switch, Textarea, useCompact } from '@aipotluck/alpha-ds';

	/**
	 * General "report a problem with the chat" — the SECOND report channel (not tied to a specific
	 * answer; the per-answer flag is the first). Opens from the account menu, its home
	 * for help/feedback. POSTs to /api/report → saveReport → the same `reports` table and
	 * /admin/reports as the per-answer flag, so a user never has to pick the "right" channel.
	 *
	 * Made useful for whoever triages it: each kind of problem asks its own question (so the detail
	 * that comes back is the detail needed), and — unless the person switches it off — a short,
	 * visible block of technical context (page, browser, screen, time) is appended to the detail.
	 * Nothing is attached that the person can't see. Dialog on larger screens, bottom sheet on phones.
	 */
	type Category = 'bug' | 'ux' | 'content' | 'other';

	let {
		open = $bindable(false),
		title,
		initialCategory = ''
	}: {
		open?: boolean;
		/** Contribute's "Tell us what's missing" opens this as a request, not a bug report. */
		title?: string;
		/** Preselected kind, restored on every open and by "Report something else". */
		initialCategory?: Category | '';
	} = $props();
	const heading = $derived(title ?? m.product_reportProblem());
	const CATEGORIES: { key: Category; label: string; hint: string; prompt: string }[] = $derived([
		{ key: 'bug', label: m.report_bugLabel(), hint: m.report_bugHint(), prompt: m.report_bugPrompt() },
		{ key: 'ux', label: m.report_uxLabel(), hint: m.report_uxHint(), prompt: m.report_uxPrompt() },
		{ key: 'content', label: m.report_contentLabel(), hint: m.report_contentHint(), prompt: m.report_contentPrompt() },
		{ key: 'other', label: m.report_otherLabel(), hint: m.report_otherHint(), prompt: m.report_otherPrompt() }
	]);

	/** The API accepts 2000 characters; keep room for the technical context block. */
	const DETAIL_MAX = 1600;

	let category = $state<Category | ''>('');
	const selected = $derived(CATEGORIES.find((c) => c.key === category));
	let detail = $state('');
	let includeContext = $state(true);
	let busy = $state(false);
	let done = $state(false);
	let failed = $state(false);

	const phone = useCompact();

	$effect(() => {
		if (!open) return;
		trackEvent('report_problem_clicked', {});
		// Untracked, or each pick of a kind re-ran this and counted another open.
		untrack(() => {
			if (!category) category = initialCategory;
		});
	});

	// Exactly what gets attached — shown to the person before they send, never more.
	const context = $derived.by(() => {
		if (typeof window === 'undefined') return [] as [string, string][];
		return [
			['Page', page.url.pathname],
			['Browser', navigator.userAgent],
			['Screen', `${window.innerWidth}×${window.innerHeight}`],
			['Time', new Date().toISOString()]
		] as [string, string][];
	});

	function reset() {
		category = initialCategory;
		detail = '';
		includeContext = true;
		failed = false;
		done = false;
	}

	function close() {
		open = false;
	}

	async function submit() {
		if (busy || !category) return;
		busy = true;
		failed = false;
		const text = detail.trim();
		const attached = includeContext ? `\n\n—\n${context.map(([k, v]) => `${k}: ${v}`).join('\n')}` : '';
		try {
			const res = await fetch(`${base}/api/report`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ category, detail: (text + attached).trim().slice(0, 2000) || undefined })
			});
			if (!res.ok) throw new Error(`report failed: ${res.status}`);
			done = true;
		} catch (err) {
			console.error(err);
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

{#snippet body()}
	{#if done}
		<div class="flex flex-col items-start gap-3 py-2" role="status">
			<span class="grid size-9 place-items-center rounded-pill border border-line-2 bg-surface-2">
				<RiCheck class="size-4 text-positive-text" aria-hidden="true" />
			</span>
			<p class="type-body text-fg-1">{m.report_sent()}</p>
			<p class="type-caption text-fg-2">
				{m.report_sentHelpReports()}
				<a href={`${base}/settings/reports`} class="underline underline-offset-2" onclick={close} data-own-reports-link
					>{m.product_yourReports()}</a
				>.
			</p>
			<div class="flex gap-2 pt-1">
				<Button variant="secondary" casing="sentence" onclick={reset}>{m.report_another()}</Button>
				<Button variant="primary" casing="sentence" onclick={close}>{m.report_done()}</Button>
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-5">
			<p class="flex items-start gap-2 type-caption text-fg-3">
				<RiFlagLine aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
				{m.report_useFlag()}
			</p>

			<fieldset class="flex flex-col gap-2">
				<legend class="mb-2 type-label text-fg-2">{m.report_kind()}</legend>
				<RadioGroup
					value={category}
					onValueChange={(v) => (category = v as Category)}
					aria-label={m.report_kind()}
					class="flex flex-col gap-2"
				>
					{#each CATEGORIES as c (c.key)}
						<label
							class="flex cursor-pointer items-start gap-3 rounded-field border border-line-2 bg-surface-raised px-3 py-2.5 transition-control hover:border-line-3 has-[[aria-checked=true]]:border-fg-1"
							data-report-category={c.key}
						>
							<Radio.Root value={c.key} class="mt-0.5"><Radio.Indicator /></Radio.Root>
							<span class="flex min-w-0 flex-col gap-0.5">
								<span class="type-body text-fg-1">{c.label}</span>
								<span class="type-caption text-fg-3">{c.hint}</span>
							</span>
						</label>
					{/each}
				</RadioGroup>
			</fieldset>

			{#if selected}
				<div class="flex flex-col gap-2">
					<label for="report-detail" class="type-body text-fg-1">{selected.prompt}</label>
					<Textarea
						id="report-detail"
						bind:value={detail}
						maxlength={DETAIL_MAX}
						minRows={3}
						maxRows={8}
						placeholder={m.report_detailPlaceholder()}
					/>
					<span class="self-end type-caption text-fg-3 tabular-nums">{detail.length}/{DETAIL_MAX}</span>
				</div>

				<div class="flex flex-col gap-2 rounded-field border border-line-1 bg-surface-2 p-3">
					<label class="flex items-center justify-between gap-3">
						<span class="flex flex-col">
							<span class="type-body text-fg-1">{m.report_includeDetails()}</span>
							<span class="type-caption text-fg-3">{m.report_includeDetailsHelp()}</span>
						</span>
						<Switch.Root bind:checked={includeContext} aria-label={m.report_includeDetails()}><Switch.Thumb /></Switch.Root>
					</label>
					{#if includeContext}
						<dl class="flex flex-col gap-0.5 type-caption" data-report-context>
							{#each context as [k, v] (k)}
								<div class="flex gap-3">
									<dt class="w-14 shrink-0 text-fg-3">{k}</dt>
									<dd class="min-w-0 truncate text-fg-2" title={v}>{v}</dd>
								</div>
							{/each}
						</dl>
					{/if}
				</div>
			{/if}

			<!-- CUR-3399: filled in, the form is taller than a laptop window. In the dialog, the error and
			     the buttons stay pinned to its bottom edge while the form scrolls above them. -->
			<div
				class={[
					'flex flex-col gap-3',
					!phone.current && 'sticky bottom-0 -mx-6 -mb-6 border-t border-line-1 bg-surface-3 px-6 py-4'
				]}
				data-report-footer
			>
				{#if failed}
					<p class="type-caption text-accent-2-text" role="alert">{m.message_reportFailed()}</p>
				{/if}
				<div class="flex justify-end gap-2 max-sm:flex-col-reverse">
					<Button variant="ghost" casing="sentence" onclick={close}>{m.message_cancel()}</Button>
					<Button variant="primary" casing="sentence" disabled={busy || !category} onclick={submit}>
						{busy ? m.report_sending() : m.report_send()}
					</Button>
				</div>
			</div>
		</div>
	{/if}
{/snippet}

{#if phone.current}
	<Sheet.Root bind:open onOpenChangeComplete={(o) => !o && reset()}>
		<Sheet.Portal>
			<Sheet.Backdrop />
			<Sheet.Popup aria-label={heading} data-report-sheet>
				<Sheet.Header title={heading} />
				<Sheet.Body>{@render body()}</Sheet.Body>
			</Sheet.Popup>
		</Sheet.Portal>
	</Sheet.Root>
{:else}
	<Dialog.Root bind:open onOpenChangeComplete={(o) => !o && reset()}>
		<Dialog.Portal>
			<Dialog.Backdrop />
			<!-- Anchored to the top: picking a kind adds the question below the options, and a centred
			     popup would re-centre and slide the options out from under the pointer. -->
			<Dialog.Popup size="md" placement="top" data-report-dialog>
				<Dialog.Title>{heading}</Dialog.Title>
				{@render body()}
				<Dialog.Close />
			</Dialog.Popup>
		</Dialog.Portal>
	</Dialog.Root>
{/if}
