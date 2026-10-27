<!--
  @component
  `Sheet.Popup` — the sheet itself: anchored to the bottom, rounded top corners, a grab handle, up to
  90% of the viewport, safe-area padding. Drag the handle or header down to dismiss (or tap the
  backdrop, press Escape, or use the header's close button).
-->
<script lang="ts">
	import { Dialog as Engine, type DialogContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { getSheet } from './context.ts';

	let { class: className, children, ...rest }: DialogContentProps = $props();

	const sheet = getSheet();
	let dy = $state(0);
	let startY = 0;
	let startT = 0;
	let dragging = $state(false);

	function down(e: PointerEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('[data-sheet-drag]') || target.closest('button, a, input, textarea'))
			return;
		dragging = true;
		startY = e.clientY;
		startT = performance.now();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (!dragging) return;
		dy = Math.max(0, e.clientY - startY);
	}
	function up() {
		if (!dragging) return;
		dragging = false;
		const velocity = dy / Math.max(1, performance.now() - startT);
		if (dy > 96 || velocity > 0.6) sheet?.close();
		dy = 0;
	}
</script>

<Engine.Content
	{...rest}
	data-surface="3"
	data-sheet
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	style={dy ? `transform: translateY(${dy}px)` : undefined}
	class={cn(
		'fixed inset-x-0 bottom-0 z-overlay flex max-h-[90dvh] flex-col border-t border-line-2 bg-surface-3 text-fg-1 shadow-popover outline-none',
		'motion-sheet rounded-t-[max(var(--ds-radius-field),16px)] pb-[env(safe-area-inset-bottom)]',
		dragging ? 'transition-none' : 'transition-transform duration-(--ds-duration-base)',
		className
	)}
>
	<div
		data-sheet-drag
		class="flex shrink-0 cursor-grab touch-none justify-center pt-2 pb-1"
		aria-hidden="true"
	>
		<span class="h-1 w-10 rounded-pill bg-line-3"></span>
	</div>
	{@render children?.()}
</Engine.Content>
