<!--
  @component
  `AppShell.Sidebar` — in-flow on desktop (expanded width or icon rail), an off-canvas drawer
  under `md` that pushes the conversation aside (AppShell.Main slides right and dims). Compose it with the `Sidebar.*` parts.

  Desktop: drag the right edge to resize (arrow keys on the focused handle; double-click resets).
  Drag it well past the minimum and the sidebar snaps to the icon rail; drag the rail's edge out and
  it opens again, following the pointer. The width is remembered per browser under `storageKey`.
  Pass `resizable={false}` to opt out.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { getAppShell } from './context.svelte.ts';

	let {
		label = 'Sidebar',
		closeLabel = 'Close sidebar',
		resizeLabel = 'Resize sidebar',
		dragOpenLabel = 'Drag to open sidebar',
		resizeTitle = 'Drag to resize · drag far left to collapse · double-click to reset',
		dragOpenTitle = 'Drag out to open',
		resizable = true,
		storageKey = 'alpha-ds:sidebar-width',
		class: className,
		children
	}: {
		label?: string;
		/** Accessible controls supplied by the application for its interface locale. */
		closeLabel?: string;
		resizeLabel?: string;
		dragOpenLabel?: string;
		/** Hover tooltip on the resize handle while the sidebar is open. */
		resizeTitle?: string;
		/** Hover tooltip on the resize handle while the sidebar is collapsed to the rail. */
		dragOpenTitle?: string;
		/** Desktop only: a drag handle on the right edge (resize; drag to collapse or expand). */
		resizable?: boolean;
		/** localStorage key the chosen width persists under. */
		storageKey?: string;
		class?: string;
		children?: Snippet;
	} = $props();

	const shell = getAppShell();

	// Resize bounds in px. The default (token `--ds-sidebar-width`) applies until the user drags.
	const MIN = 208;
	const MAX = 480;
	const STEP = 16;
	// Snap points while dragging (px from the sidebar's left edge): below COLLAPSE_AT an open sidebar
	// folds to the rail; past EXPAND_AT a rail opens up again.
	const COLLAPSE_AT = MIN - 80;
	const EXPAND_AT = 120;
	const clamp = (n: number) => Math.round(Math.min(MAX, Math.max(MIN, n)));

	let width = $state<number | undefined>(undefined);
	let dragging = $state(false);
	let desktop = $state(false);
	let aside = $state<HTMLElement>();

	$effect(() => {
		const mq = window.matchMedia('(min-width: 48rem)');
		desktop = mq.matches;
		const on = () => (desktop = mq.matches);
		mq.addEventListener('change', on);
		const saved = Number(localStorage.getItem(storageKey));
		if (saved) width = clamp(saved);
		return () => mq.removeEventListener('change', on);
	});

	const canResize = $derived(resizable && desktop && !shell.collapsed);
	const showHandle = $derived(resizable && desktop);

	function commit(next: number | undefined) {
		width = next === undefined ? undefined : clamp(next);
		if (width === undefined) localStorage.removeItem(storageKey);
		else localStorage.setItem(storageKey, String(width));
	}

	function onpointerdown(e: PointerEvent) {
		if (!aside || e.button !== 0) return;
		e.preventDefault();
		const left = aside.getBoundingClientRect().left;
		const handle = e.currentTarget as HTMLElement;
		try {
			handle.setPointerCapture(e.pointerId);
		} catch {
			// Synthetic or already-released pointer: the drag still works while over the handle.
		}
		dragging = true;
		const before = width;
		const move = (ev: PointerEvent) => {
			const x = ev.clientX - left;
			if (shell.collapsed) {
				// Pulled out of the rail: open, then keep following the pointer.
				if (x > EXPAND_AT) {
					shell.toggleSidebar();
					width = clamp(x);
				}
			} else if (x < COLLAPSE_AT) {
				// Pushed well past the minimum: fold to the rail and keep the last width for next time.
				width = before;
				shell.toggleSidebar();
			} else width = clamp(x);
		};
		const up = () => {
			dragging = false;
			if (!shell.collapsed) commit(width);
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	}

	function onhandlekey(e: KeyboardEvent) {
		if (shell.collapsed) {
			if (e.key !== 'ArrowRight' && e.key !== 'Enter') return;
			e.preventDefault();
			shell.toggleSidebar();
			return;
		}
		const current = width ?? aside?.getBoundingClientRect().width ?? MIN;
		if (e.key === 'ArrowLeft' && current <= MIN) shell.toggleSidebar();
		else if (e.key === 'ArrowLeft') commit(current - STEP);
		else if (e.key === 'ArrowRight') commit(current + STEP);
		else if (e.key === 'Home') commit(MIN);
		else if (e.key === 'End') commit(MAX);
		else return;
		e.preventDefault();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && shell.mobileOpen) shell.setMobileOpen(false);
	}

	// Mobile edge swipe: drag right from the left edge opens the drawer, drag left closes it.
	// Horizontal intent only (a mostly-vertical move is a scroll and is ignored).
	const EDGE = 24;
	const THRESHOLD = 56;
	let start: { x: number; y: number; open: boolean } | null = null;

	function ontouchstart(e: TouchEvent) {
		if (
			window.matchMedia('(min-width: 48rem)').matches ||
			document.getElementById('app')?.hasAttribute('inert')
		)
			return;
		const t = e.touches[0];
		if (shell.mobileOpen || t.clientX <= EDGE)
			start = { x: t.clientX, y: t.clientY, open: shell.mobileOpen };
	}

	function ontouchend(e: TouchEvent) {
		if (!start) return;
		const t = e.changedTouches[0];
		const dx = t.clientX - start.x;
		const dy = t.clientY - start.y;
		if (Math.abs(dx) > Math.abs(dy) * 1.5) {
			if (!start.open && dx > THRESHOLD) shell.setMobileOpen(true);
			if (start.open && dx < -THRESHOLD) shell.setMobileOpen(false);
		}
		start = null;
	}
</script>

<svelte:window {onkeydown} {ontouchstart} {ontouchend} />

<!-- Mobile: the conversation is pushed right and dimmed (AppShell.Main); tapping what's left of it
     closes the drawer. Transparent — the dimming lives on the content itself, not an overlay. -->
{#if shell.mobileOpen}
	<button
		type="button"
		aria-label={closeLabel}
		class="fixed inset-y-0 right-0 left-sidebar z-overlay bg-transparent md:hidden"
		onclick={() => shell.setMobileOpen(false)}
	></button>
{/if}

<aside
	bind:this={aside}
	aria-label={label}
	style:--ds-sidebar-width={canResize && width ? `${width}px` : undefined}
	data-resizing={dragging ? '' : undefined}
	data-surface="1"
	data-collapsed={shell.collapsed ? '' : undefined}
	data-mobile-open={shell.mobileOpen ? '' : undefined}
	class={cn(
		'group/sidebar flex min-h-0 shrink-0 flex-col border-r border-line-1 bg-surface-1',
		// Mobile: off-canvas drawer.
		'fixed inset-y-0 left-0 z-overlay w-sidebar -translate-x-full transition-transform duration-(--ds-duration-base) ease-standard',
		'data-mobile-open:translate-x-0',
		// Desktop: in-flow; rail when collapsed.
		'md:relative md:z-auto md:translate-x-0 md:transition-[width] md:data-collapsed:w-rail',
		'data-resizing:transition-none data-resizing:select-none',
		className
	)}
>
	{@render children?.()}
	{#if showHandle}
		<!-- Straddles the border: a wide invisible hit area with a hairline that lights on hover/drag.
		     A focusable separator is the ARIA window-splitter pattern, so it takes keys and focus. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={shell.collapsed ? dragOpenLabel : resizeLabel}
			aria-valuemin={MIN}
			aria-valuemax={MAX}
			aria-valuenow={Math.round(width ?? aside?.getBoundingClientRect().width ?? MIN)}
			tabindex="0"
			title={shell.collapsed ? dragOpenTitle : resizeTitle}
			data-dragging={dragging ? '' : undefined}
			class="group/resize absolute inset-y-0 -right-1.5 z-raised hidden w-3 cursor-col-resize touch-none justify-center outline-none md:flex"
			{onpointerdown}
			onkeydown={onhandlekey}
			ondblclick={() => (shell.collapsed ? shell.toggleSidebar() : commit(undefined))}
		>
			<span
				aria-hidden="true"
				class="h-full w-0.5 bg-transparent transition-colors duration-(--ds-duration-fast) group-hover/resize:bg-line-3 group-focus-visible/resize:bg-focus group-data-dragging/resize:bg-line-3"
			></span>
		</div>
	{/if}
</aside>
