<script lang="ts">
	import { fade } from 'svelte/transition';
	import { on } from 'svelte/events';
	import { Button, cn } from '@aipotluck/alpha-ds';
	import RiArrowDownLine from '~icons/ri/arrow-down-line';

	/**
	 * "Jump to bottom" — shown only while the conversation is scrolled away from the latest message
	 * (more than ~200px up), so it never sits over the composer for no reason. Watches scrolls and
	 * size changes (a streaming answer or an opened composer panel both change the distance).
	 */
	interface Props {
		scrollNode: HTMLElement;
		class?: string;
		/** Whether the button is showing, bound out so the parent can cover the text beneath it. */
		visible?: boolean;
	}

	let { scrollNode, class: className = '', visible = $bindable(false) }: Props = $props();

	function update() {
		if (!scrollNode) return;
		visible = Math.ceil(scrollNode.scrollTop) + 200 < scrollNode.scrollHeight - scrollNode.clientHeight;
	}

	$effect(() => {
		if (!scrollNode) return;
		update();
		const off = on(scrollNode, 'scroll', update, { passive: true });
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
		ro?.observe(scrollNode);
		// Content growth (streaming) changes scrollHeight without resizing the node itself.
		const mo = new MutationObserver(update);
		mo.observe(scrollNode, { childList: true, subtree: true, characterData: true });
		return () => {
			off();
			ro?.disconnect();
			mo.disconnect();
		};
	});
</script>

{#if visible}
	<div transition:fade={{ duration: 150 }} class={cn('absolute', className)}>
		<Button
			variant="secondary"
			size="icon-sm"
			shape="pill"
			aria-label="Jump to bottom"
			title="Jump to bottom"
			onclick={() => scrollNode.scrollTo({ top: scrollNode.scrollHeight, behavior: 'smooth' })}
			data-jump-to-bottom
		>
			<RiArrowDownLine aria-hidden="true" />
		</Button>
	</div>
{/if}
