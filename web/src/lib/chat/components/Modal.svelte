<!--
  Chat's shared modal, now a thin adapter over the Alpha design system's Dialog (Base UI anatomy,
  bits-ui behaviour: focus trap, Escape, outside-click, scroll lock). Every chat modal —
  delete conversation, delete everything, welcome, URL fetch, weak spots… — inherits the
  design-system popup (Background 3, hairline frame, soft elevation) from here.

  Consumers keep their existing API: render it conditionally and pass `onclose`.
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { Dialog } from '@aipotluck/alpha-ds';
	import { tap } from '$lib/chat/utils/haptics';

	interface Props {
		/** Size utilities for the popup (e.g. `max-w-sm`, or legacy `w-[…]` strings). Rendered at
		 *  `size="full"` (only the viewport inset caps it, like the old Modal's 90dvw), so width-only
		 *  strings keep their old size instead of being clamped by the popup's default max-width. */
		width?: string;
		closeButton?: boolean;
		/** Legacy: the design-system popup has one (brief) enter motion; kept for API compatibility. */
		disableFly?: boolean;
		/** When false, neither the backdrop nor Escape closes the modal (e.g. a wipe in flight). */
		closeOnBackdrop?: boolean;
		/**
		 * Legacy (CUR-704). The popup now portals into the chat ThemeProvider's body-level host, which
		 * carries the window's mode, so it always matches the chat. Accepted and ignored.
		 */
		dark?: boolean;
		onclose?: () => void;
		children?: import('svelte').Snippet;
	}

	let {
		width = 'max-w-sm',
		children,
		closeButton = false,
		closeOnBackdrop = true,
		// Accepted for API compatibility with existing callers; intentionally unused.
		disableFly: _disableFly,
		dark: _dark,
		onclose
	}: Props = $props();

	// Focus goes to the first tabbable element by default, which in a long dialog can sit below the
	// fold and scroll the title away. A child marked `data-autofocus` takes focus instead. The popup is
	// found by its own id: bits-ui never dispatches this event on an element, so `e.target` is null
	// (CUR-2744).
	const popupId = $props.id();
	function focusMarked(e: Event) {
		const target = document.querySelector<HTMLElement>(
			`[data-modal-popup="${popupId}"] [data-autofocus]`
		);
		if (!target) return;
		e.preventDefault();
		target.focus({ preventScroll: true });
	}

	// The rest of the app goes inert while a modal is open — other chat code (the new-chat shortcut,
	// the drawer swipe) checks `#app[inert]` to stand down. The popup portals outside #app.
	onMount(() => {
		document.getElementById('app')?.setAttribute('inert', 'true');
		tap();
	});
	onDestroy(() => {
		if (browser) document.getElementById('app')?.removeAttribute('inert');
	});
</script>

<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open) onclose?.();
	}}
>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup
			size="full"
			class="{width} gap-0 p-0"
			interactOutsideBehavior={closeOnBackdrop ? 'close' : 'ignore'}
			escapeKeydownBehavior={closeOnBackdrop ? 'close' : 'ignore'}
			onOpenAutoFocus={focusMarked}
			data-modal-popup={popupId}
		>
			{@render children?.()}
			{#if closeButton}
				<Dialog.Close />
			{/if}
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
