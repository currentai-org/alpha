<!--
  @component
  Copy edit mode, on the page: every interface message is outlined on hover and edited in place on
  click. The editor sits exactly over the text, in the text's own type, and shows the message's
  template (`{placeholders}` included) in the language the page is in. Edits re-render the page at
  once, are kept in this browser on every change, and are written to the chosen file when there is
  one. Alt/Option-click, or Browse in the panel, uses the page normally.

  Dev and preview builds only; the root layout mounts this lazily when the mode is on.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { Button, Kbd } from '@aipotluck/alpha-ds';
	import { hasMarker, placeholders, segmentAt, segments, stripMarkers } from './markers';
	import { copyEdit, editFor, hasUnsaved, keyAt, setEdit } from './state.svelte';
	import { loadCatalogs, sourceTemplate } from './catalogs';
	import { download, restoreFile } from './fileSave';
	import CopyEditPanel from './CopyEditPanel.svelte';

	type Catalogs = Record<string, Record<string, string>>;
	let catalogs = $state<Catalogs>({});

	interface Hit {
		key: string;
		rects: DOMRect[];
		box: DOMRect;
		host: HTMLElement;
	}

	interface Editing {
		key: string;
		locale: string;
		box: DOMRect;
		style: string;
		/** Catalog text for this language (or English when untranslated): what Reset returns to. */
		source: string;
		/** English template: the placeholders every language must keep. */
		english: string;
	}

	let hover = $state<Hit | null>(null);
	let editing = $state<Editing | null>(null);
	let draft = $state('');
	let error = $state('');
	let editorEl = $state<HTMLTextAreaElement | null>(null);

	const isUi = (el: Element | null) => !!el?.closest('[data-copy-edit-ui]');

	type CaretDocument = Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};

	function caretAt(x: number, y: number): { node: Node; offset: number } | null {
		const doc = document as CaretDocument;
		if (doc.caretPositionFromPoint) {
			const p = doc.caretPositionFromPoint(x, y);
			return p ? { node: p.offsetNode, offset: p.offset } : null;
		}
		const r = doc.caretRangeFromPoint?.(x, y);
		return r ? { node: r.startContainer, offset: r.startOffset } : null;
	}

	/** Text nodes under `root`, in order, with their offset into `root.textContent`. */
	function textNodes(root: Node): { node: Text; at: number }[] {
		const out: { node: Text; at: number }[] = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let at = 0;
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			out.push({ node: n as Text, at });
			at += (n as Text).data.length;
		}
		return out;
	}

	function pointAt(nodes: { node: Text; at: number }[], offset: number): [Text, number] {
		for (let i = nodes.length - 1; i >= 0; i--) {
			if (nodes[i].at <= offset)
				return [nodes[i].node, Math.min(offset - nodes[i].at, nodes[i].node.data.length)];
		}
		return [nodes[0].node, 0];
	}

	const inside = (r: DOMRect, x: number, y: number) =>
		x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;

	/**
	 * The message under a point. A message split across elements (a sentence with a link in it) has its
	 * tag spread over several text nodes, so the search widens to ancestors until one holds both ends.
	 */
	function hitAt(x: number, y: number): Hit | null {
		const el = document.elementFromPoint(x, y) as HTMLElement | null;
		if (!el || isUi(el)) return null;
		const field = el.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
		if (field && !field.value && hasMarker(field.placeholder)) {
			const seg = segments(field.placeholder).find((s) => s.depth === 0);
			const key = seg && keyAt(seg.index);
			const box = field.getBoundingClientRect();
			return key ? { key, rects: [box], box, host: field } : null;
		}
		const pos = caretAt(x, y);
		const exact = pos && pos.node.nodeType === Node.TEXT_NODE ? hitInText(pos, x, y) : null;
		return exact ?? wholeElement(el);
	}

	/**
	 * An element whose visible text is exactly one message (a heading, a button label) is that message
	 * wherever it is clicked, including the space beside a short label.
	 */
	function wholeElement(el: HTMLElement): Hit | null {
		for (let n: HTMLElement | null = el, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
			const text = n.textContent ?? '';
			const top = segments(text).filter((s) => s.depth === 0);
			if (top.length !== 1) continue;
			if (
				stripMarkers(text).trim() !==
				stripMarkers(text.slice(top[0].contentStart, top[0].contentEnd)).trim()
			)
				continue;
			const key = keyAt(top[0].index);
			if (!key) return null;
			const nodes = textNodes(n);
			const range = document.createRange();
			range.setStart(...pointAt(nodes, top[0].contentStart));
			range.setEnd(...pointAt(nodes, top[0].contentEnd));
			const rects = [...range.getClientRects()].filter((r) => r.width > 0);
			return {
				key,
				rects,
				box: range.getBoundingClientRect(),
				host: (nodes[0]?.node.parentElement ?? n) as HTMLElement
			};
		}
		return null;
	}

	function hitInText(pos: { node: Node; offset: number }, x: number, y: number): Hit | null {
		let scope: HTMLElement | null = pos.node.parentElement;
		for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
			const nodes = textNodes(scope);
			const mine = nodes.find((n) => n.node === pos.node);
			if (!mine) break;
			const seg = segmentAt(scope.textContent ?? '', mine.at + pos.offset);
			if (!seg) continue;
			const key = keyAt(seg.index);
			if (!key) return null;
			const range = document.createRange();
			range.setStart(...pointAt(nodes, seg.contentStart));
			range.setEnd(...pointAt(nodes, seg.contentEnd));
			const rects = [...range.getClientRects()].filter((r) => r.width > 0);
			if (!rects.some((r) => inside(r, x, y))) return null;
			return { key, rects, box: range.getBoundingClientRect(), host: pos.node.parentElement! };
		}
		return null;
	}

	function effectiveBackground(el: Element | null): string {
		for (let n = el; n; n = n.parentElement) {
			const bg = getComputedStyle(n).backgroundColor;
			if (bg && !/rgba\([^)]*,\s*0\)$/.test(bg) && bg !== 'transparent') return bg;
		}
		return getComputedStyle(document.body).backgroundColor || 'Canvas';
	}

	async function open(hit: Hit) {
		// The layer mounts before its lazy source catalogs finish loading. A click in that window
		// must wait for the templates, or it opens a blank draft and loses placeholder validation.
		catalogs = await loadCatalogs();
		const locale = getLocale();
		const cs = getComputedStyle(hit.host);
		const props = [
			'font-family',
			'font-size',
			'font-weight',
			'font-style',
			'letter-spacing',
			'line-height',
			'text-transform',
			'color',
			'text-align'
		];
		const style =
			props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';') +
			`;background:${effectiveBackground(hit.host)}`;
		const source = sourceTemplate(catalogs, locale, hit.key);
		editing = {
			key: hit.key,
			locale,
			box: hit.box,
			style,
			source,
			english: catalogs.en?.[hit.key] ?? source
		};
		draft = editFor(locale, hit.key)?.text ?? source;
		error = '';
		hover = null;
		void tick().then(() => {
			editorEl?.focus();
			editorEl?.select();
		});
	}

	function save() {
		if (!editing) return;
		const want = placeholders(editing.english);
		const got = placeholders(draft);
		if (want.join() !== got.join()) {
			const missing = want.filter((p) => !got.includes(p));
			const extra = got.filter((p) => !want.includes(p));
			error = [
				missing.length
					? `Keep ${missing.map((p) => `{${p}}`).join(', ')}: the app fills it in.`
					: '',
				extra.length
					? `${extra.map((p) => `{${p}}`).join(', ')} isn’t something this text can show.`
					: ''
			]
				.filter(Boolean)
				.join(' ');
			return;
		}
		setEdit(
			editing.locale,
			editing.key,
			draft,
			editFor(editing.locale, editing.key)?.original ?? editing.source
		);
		editing = null;
	}

	function reset() {
		if (!editing) return;
		draft = editing.source;
		error = '';
	}

	// ── Pointer handling: in Edit, a press on a message opens its editor and never reaches the page ──
	let frame = 0;
	function onMove(e: PointerEvent) {
		if (editing || copyEdit.tool !== 'edit' || e.altKey) {
			hover = null;
			return;
		}
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => (hover = hitAt(e.clientX, e.clientY)));
	}

	function intercept(e: MouseEvent | PointerEvent) {
		if (copyEdit.tool !== 'edit' || e.altKey || isUi(e.target as Element)) return;
		if (editing) return;
		const hit = hitAt(e.clientX, e.clientY);
		if (!hit) return;
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		if (e.type === 'click') void open(hit);
	}

	// ── Highlights: every message faintly, edited ones clearly (CSS Custom Highlight API) ──
	type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
	const highlights = () =>
		(globalThis.CSS as unknown as { highlights?: HighlightRegistry })?.highlights;
	const HighlightCtor = () =>
		(globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

	function paintHighlights() {
		const registry = highlights();
		const Ctor = HighlightCtor();
		if (!registry || !Ctor) return;
		const all: Range[] = [];
		const changed: Range[] = [];
		const locale = getLocale();
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			if (!hasMarker(n.data) && !n.data.includes('⁤')) continue;
			if (isUi(n.parentElement)) continue;
			const segs = segments(n.data);
			const add = (start: number, end: number, key?: string) => {
				if (end <= start) return;
				const r = document.createRange();
				r.setStart(n, start);
				r.setEnd(n, end);
				(key && editFor(locale, key) ? changed : all).push(r);
			};
			for (const s of segs) add(s.contentStart, s.contentEnd, keyAt(s.index));
			if (!segs.length) {
				// A fragment of a message split across elements: highlight what is visible here.
				const visible = stripMarkers(n.data);
				if (visible.trim()) add(0, n.data.length);
			}
		}
		registry.set('copy-edit', new Ctor(...all));
		registry.set('copy-edit-changed', new Ctor(...changed));
	}

	let paintTimer: ReturnType<typeof setTimeout> | undefined;
	function schedulePaint() {
		clearTimeout(paintTimer);
		paintTimer = setTimeout(paintHighlights, 150);
	}

	$effect(() => {
		void copyEdit.version;
		schedulePaint();
	});

	// ── Never lose edits: warn before leaving with edits that haven't reached a file ──
	function beforeUnload(e: BeforeUnloadEvent) {
		if (hasUnsaved()) {
			e.preventDefault();
			e.returnValue = '';
		}
	}

	function onKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			if (copyEdit.fileName && !hasUnsaved()) return;
			download();
		}
	}

	// ::highlight() rules can't live in a component <style> block, so the sheet is added while the mode is on.
	// Literal colours: light-dark() tokens don't resolve inside ::highlight(). Coral is the accent.
	const HIGHLIGHT_CSS = `
		::highlight(copy-edit) { text-decoration: underline dotted; text-decoration-color: color-mix(in oklab, currentColor 45%, transparent); text-underline-offset: 3px; }
		::highlight(copy-edit-changed) { background-color: rgb(239 125 102 / 0.3); text-decoration: underline solid rgb(239 125 102); text-underline-offset: 3px; }`;

	onMount(() => {
		const sheet = Object.assign(document.createElement('style'), { textContent: HIGHLIGHT_CSS });
		sheet.dataset.copyEditStyle = '';
		document.head.append(sheet);
		void loadCatalogs().then((c) => (catalogs = c));
		void restoreFile();
		const opts = { capture: true } as const;
		const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const;
		for (const t of events) window.addEventListener(t, intercept, opts);
		window.addEventListener('pointermove', onMove, { passive: true });
		window.addEventListener('beforeunload', beforeUnload);
		window.addEventListener('keydown', onKey);
		const observer = new MutationObserver(schedulePaint);
		observer.observe(document.body, { subtree: true, childList: true, characterData: true });
		const clearHover = () => (hover = null);
		window.addEventListener('scroll', clearHover, { capture: true, passive: true });
		return () => {
			for (const t of events) window.removeEventListener(t, intercept, opts);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('beforeunload', beforeUnload);
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('scroll', clearHover, { capture: true });
			observer.disconnect();
			sheet.remove();
			highlights()?.delete('copy-edit');
			highlights()?.delete('copy-edit-changed');
		};
	});

	function onEditorKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			editing = null;
		} else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			save();
		}
	}
</script>

<div data-copy-edit-ui class="ds-root" data-mode="dark">
	{#if hover && !editing}
		{#each hover.rects as r, i (i)}
			<div
				class="pointer-events-none fixed z-tooltip rounded-sharp outline-2 outline-offset-2 outline-accent-1"
				style="left:{r.left}px;top:{r.top}px;width:{r.width}px;height:{r.height}px"
			></div>
		{/each}
		<div
			class="pointer-events-none fixed z-tooltip rounded-sharp bg-surface-3 px-1.5 py-0.5 type-caption text-fg-2 shadow-popover"
			style="left:{hover.box.left}px;top:{Math.max(0, hover.box.top - 26)}px"
		>
			Click to edit{editFor(getLocale(), hover.key) ? ' · edited' : ''}
		</div>
	{/if}

	{#if editing}
		{@const b = editing.box}
		<!-- The bar goes under the text, or over it when the text sits near the bottom of the window. -->
		{@const below = b.bottom + 180 < window.innerHeight}
		{@const width = Math.min(Math.max(b.width + 12, 280), window.innerWidth - 16)}
		<div
			class="fixed z-tooltip flex gap-1.5 {below ? 'flex-col' : 'flex-col-reverse'}"
			style="left:{Math.min(Math.max(8, b.left - 6), window.innerWidth - width - 8)}px;{below
				? `top:${Math.max(8, b.top - 4)}px`
				: `bottom:${Math.max(8, window.innerHeight - b.bottom - 4)}px`};width:{width}px"
			data-copy-edit-editor
		>
			<textarea
				bind:this={editorEl}
				bind:value={draft}
				onkeydown={onEditorKey}
				rows="1"
				spellcheck="true"
				aria-label="Edit text ({editing.locale.toUpperCase()})"
				class="block field-sizing-content min-h-0 w-full resize-none overflow-hidden rounded-sharp px-1.5 py-1 outline-2 outline-accent-1"
				style="{editing.style};min-height:{b.height + 8}px"></textarea>
			<div
				class="flex flex-col gap-1.5 rounded-sharp bg-surface-3 p-2 type-caption text-fg-2 shadow-popover"
			>
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span class="font-mono text-fg-1">{editing.locale.toUpperCase()}</span>
					<span class="truncate font-mono text-fg-3" title={editing.key}>{editing.key}</span>
				</div>
				{#if placeholders(editing.english).length}
					<p>
						Keep {placeholders(editing.english)
							.map((p) => `{${p}}`)
							.join(', ')}: the app fills these in.
					</p>
				{/if}
				{#if draft !== editing.source}
					<p class="text-fg-3">Was: {editing.source}</p>
				{/if}
				{#if error}<p class="text-accent-2-text" role="alert">{error}</p>{/if}
				<div class="flex items-center gap-1.5">
					<Button size="xs" variant="primary" casing="sentence" onclick={save} data-copy-edit-save
						>Save <Kbd>↵</Kbd></Button
					>
					<Button size="xs" variant="ghost" casing="sentence" onclick={() => (editing = null)}
						>Cancel <Kbd>Esc</Kbd></Button
					>
					{#if draft !== editing.source}
						<Button size="xs" variant="ghost" casing="sentence" class="ml-auto" onclick={reset}
							>Back to original</Button
						>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<CopyEditPanel {catalogs} />
</div>
