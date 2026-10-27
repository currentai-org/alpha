<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { fade, fly } from 'svelte/transition';
	import Portal from './Portal.svelte';
	import { getThemeContext } from '@aipotluck/alpha-ds';
	import { browser } from '$app/environment';
	import { setupDialogChrome } from '$lib/chat/utils/dialogChrome';

	interface Props {
		/** The trigger element the panel drops down from. The panel's top-left is pinned to the
		 *  anchor's bottom-left so it reads as attached to the button (per the Alpha mockup), or its
		 *  bottom to the anchor's top when the content only fits above. */
		anchor?: HTMLElement;
		/** Natural panel width in px (clamped to the viewport on small screens). */
		widthPx?: number;
		/** Horizontal edge the panel aligns to. "left" (default) pins the panel's left to the trigger's
		 *  left; "right" pins the panel's right to the trigger's right (for triggers on the right edge,
		 *  so the card opens leftward instead of overflowing). */
		align?: "left" | "right";
		/** When false, clicking the backdrop will not close the panel. */
		closeOnBackdrop?: boolean;
		/** Render the panel in the opposite colour mode — the spec's one deliberate "always dark"
		 *  exception (the footprint card flips to a light surface). */
		inverse?: boolean;
		onclose?: () => void;
		children?: import('svelte').Snippet;
	}

	let {
		anchor,
		widthPx = 320,
		align = "left",
		closeOnBackdrop = true,
		inverse = false,
		onclose,
		children
	}: Props = $props();

	const theme = getThemeContext();
	const flippedMode = $derived(theme?.resolvedMode === "dark" ? "light" : "dark");

	let backdropEl: HTMLDivElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();
	// The content's natural height, read to decide whether it fits below the trigger. The panel's own
	// height is capped by maxHeight, so it can't answer that.
	let contentEl: HTMLDivElement | undefined = $state();

	// Gap from the viewport edges so the card never touches the screen border.
	const MARGIN = 8;

	let top = $state(0);
	let left = $state(0);
	// One-time seed from the prop; updatePosition() owns `width` after mount (it reads the live
	// widthPx there), so a reactive link isn't wanted here.
	// svelte-ignore state_referenced_locally
	let width = $state(widthPx);
	let maxHeight = $state<number | undefined>(undefined);
	// clip-path that punches a rectangular hole in the blur/tint layer exactly over the trigger, so
	// the (crisp, active) button shows through unblurred and untinted — matching the Alpha mockup
	// where the button sits on top of the blurred backdrop. Empty = no hole (whole layer blurred).
	let clipPath = $state('');
	// The blur/tint is scoped to the encapsulated chat WINDOW (`.chat-window` ancestor of the
	// anchor) rather than the whole viewport, so opening a modal dims only the product window and
	// leaves the site header / welcome band crisp. Falls back to the full viewport when there is no
	// window ancestor (AnchoredModal used elsewhere).
	let winBox = $state<{ top: number; left: number; width: number; height: number } | null>(null);

	function updatePosition() {
		if (!browser || !anchor) return;
		const rect = anchor.getBoundingClientRect();
		// If the anchor has been hidden while the panel is open (e.g. both a desktop and a mobile
		// footprint bar are mounted and a resize crosses the `md` breakpoint, toggling `display:none`),
		// getBoundingClientRect() returns an all-zero rect. Positioning against that would collapse the
		// panel to a zero-width sliver in the top-left corner — keep the last good position instead.
		if (rect.width === 0 && rect.height === 0) return;
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		width = Math.min(widthPx, vw - MARGIN * 2);
		// Attach directly beneath the trigger, aligned to its left or right edge (per `align`), then
		// clamp so the card stays fully on-screen.
		let l = align === "right" ? rect.right - width : rect.left;
		if (l + width > vw - MARGIN) l = vw - MARGIN - width;
		if (l < MARGIN) l = MARGIN;
		left = l;
		// Below the trigger by default. When the content doesn't fit there and there is more room
		// above, open upward instead, the panel's bottom on the trigger's top, so it stays attached.
		// Capping the height at the space below would leave a trigger near the foot of the viewport (the
		// account page's "Delete account") a few pixels of height and a scrollbar, so a person could confirm
		// a deletion without reading it (CUR-1990).
		const below = vh - rect.bottom - MARGIN;
		const above = rect.top - MARGIN;
		// The panel's own border adds to its content, so the natural height includes it; otherwise the
		// panel overshoots the trigger by the border's width when it opens upward.
		const chrome = panelEl ? panelEl.offsetHeight - panelEl.clientHeight : 0;
		const natural = (contentEl?.offsetHeight ?? 0) + chrome;
		if (natural > below && above > below) {
			const h = Math.min(natural, above);
			top = rect.top - h;
			maxHeight = above;
		} else {
			top = rect.bottom;
			maxHeight = below;
		}
		// Never off-screen. A trigger scrolled near or past the viewport's edge (a long settings page, or
		// one whose content shifted above the trigger) left the card mostly outside the viewport, where it
		// is fixed and so cannot be scrolled to. Keep the whole card on screen, even if that detaches it
		// from the trigger by a little.
		const fit = Math.min(natural, vh - MARGIN * 2);
		if (top + fit > vh - MARGIN) top = vh - MARGIN - fit;
		if (top < MARGIN) top = MARGIN;
		maxHeight = Math.max(maxHeight ?? 0, Math.min(fit, vh - MARGIN - top));

		// Scope the tint/blur to the chat window when the anchor lives inside one; else full viewport.
		const winEl = anchor.closest(".chat-window") as HTMLElement | null;
		const box = winEl?.getBoundingClientRect();
		winBox = box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null;

		// evenodd: an outer rectangle (the backdrop box) + an inner button rectangle = a hole over the
		// button, so the active trigger shows through crisp/untinted. Coordinates are relative to the
		// backdrop element's own box (the window box when scoped, else the viewport). The bridge back to
		// the origin is a zero-area seam (traversed both ways) so it stays invisible.
		const ox = box ? box.left : 0;
		const oy = box ? box.top : 0;
		const ow = box ? `${box.width}px` : "100vw";
		const oh = box ? `${box.height}px` : "100vh";
		clipPath =
			`polygon(evenodd,` +
			` 0px 0px, ${ow} 0px, ${ow} ${oh}, 0px ${oh}, 0px 0px,` +
			` ${rect.left - ox}px ${rect.top - oy}px, ${rect.right - ox}px ${rect.top - oy}px,` +
			` ${rect.right - ox}px ${rect.bottom - oy}px, ${rect.left - ox}px ${rect.bottom - oy}px,` +
			` ${rect.left - ox}px ${rect.top - oy}px)`;
	}

	// Shared dialog lifecycle (inert app, focus, tap, Escape + backdrop dismissal). Escape and
	// backdrop clicks are both gated on closeOnBackdrop, so the panel can't be aborted mid-wipe.
	const { handleKeydown, handleBackdropClick } = setupDialogChrome({
		focusTarget: () => panelEl,
		backdrop: () => backdropEl,
		onclose: () => onclose?.(),
		canClose: () => closeOnBackdrop
	});

	// Position-specific setup, on top of the shared chrome: pin the panel under the anchor and keep it
	// pinned as the viewport changes.
	// Re-place when the content changes size, e.g. a confirm step swapping to a longer receipt.
	let contentObserver: ResizeObserver | undefined;
	// The anchor can also move with no resize or scroll: the page above it re-renders (a wipe empties
	// the Data & privacy usage section above "Forget everything", lifting the button and leaving the
	// card below the viewport). Follow its position every frame while open; cheap, and only re-places
	// when the anchor actually moved.
	let frame = 0;
	let lastAnchor = '';
	function followAnchor() {
		const r = anchor?.getBoundingClientRect();
		const key = r ? `${r.top}|${r.left}|${r.width}|${r.height}` : '';
		if (key !== lastAnchor) {
			lastAnchor = key;
			updatePosition();
		}
		frame = requestAnimationFrame(followAnchor);
	}

	onMount(() => {
		updatePosition();
		window.addEventListener('resize', updatePosition);
		// Capture-phase so it still fires while scrolling inside nested containers.
		window.addEventListener('scroll', updatePosition, true);
		if (contentEl && typeof ResizeObserver !== 'undefined') {
			contentObserver = new ResizeObserver(() => updatePosition());
			contentObserver.observe(contentEl);
		}
		frame = requestAnimationFrame(followAnchor);
	});

	onDestroy(() => {
		if (!browser) return;
		window.removeEventListener('resize', updatePosition);
		window.removeEventListener('scroll', updatePosition, true);
		contentObserver?.disconnect();
		cancelAnimationFrame(frame);
	});
</script>

<Portal>
	<div
		role="presentation"
		tabindex="-1"
		bind:this={backdropEl}
		onclick={(e) => {
			e.stopPropagation();
			handleBackdropClick(e);
		}}
		class="fixed inset-0 z-40"
	>
		<!-- A subtle darkening (no blur — per design), with a hole cut over the trigger so the active
		     button stays crisp/untinted. pointer-events-none so clicks in the backdrop (and through the
		     hole) fall to the container above, which closes the modal. Scoped to the chat window box when
		     available, else the full viewport. When scoped, an overflow-hidden + rounded-lg wrapper trims
		     the tint's square clip-path corners to the card's rounded edge. Gated on clipPath so the first
		     frame (before updatePosition() runs) doesn't flash an unclipped full-box tint. -->
		{#if clipPath}
			{#if winBox}
				<div
					class="pointer-events-none fixed overflow-hidden rounded-lg"
					style="top:{winBox.top}px; left:{winBox.left}px; width:{winBox.width}px; height:{winBox.height}px;"
					transition:fade|local={{ easing: cubicOut, duration: 200 }}
				>
					<div class="absolute inset-0 bg-black/20" style="clip-path: {clipPath};"></div>
				</div>
			{:else}
				<div
					class="pointer-events-none absolute inset-0 bg-black/20"
					style="clip-path: {clipPath};"
					transition:fade|local={{ easing: cubicOut, duration: 200 }}
				></div>
			{/if}
		{/if}
		<div
			role="dialog"
			tabindex="-1"
			bind:this={panelEl}
			onkeydown={handleKeydown}
			in:fly={{ y: -6, duration: 160, easing: cubicOut }}
			style="top: {top}px; left: {left}px; width: {width}px; max-height: {maxHeight}px;"
			data-surface="3"
			data-mode={inverse ? flippedMode : undefined}
			class="scrollbar-custom fixed overflow-x-hidden overflow-y-auto border border-line-2 bg-surface-3 text-fg-1 shadow-popover outline-hidden rounded-sharp"
		>
			<div bind:this={contentEl}>
				{@render children?.()}
			</div>
		</div>
	</div>
</Portal>
