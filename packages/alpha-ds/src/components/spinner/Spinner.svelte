<!--
  @component
  Spinner — indeterminate activity. Alpha addition. Brutalist: a square stepping around a square
  track, not a soft ring. Respects reduced motion.
-->
<script lang="ts">
	import { cn } from '../../internal/cn.ts';

	let {
		size = 'md',
		label = 'Loading',
		class: className
	}: { size?: 'sm' | 'md' | 'lg'; label?: string; class?: string } = $props();
</script>

<span
	role="status"
	aria-label={label}
	class={cn(
		'relative inline-grid shrink-0 grid-cols-2 grid-rows-2 gap-px',
		size === 'sm' && 'size-3',
		size === 'md' && 'size-4',
		size === 'lg' && 'size-6',
		className
	)}
>
	{#each [0, 1, 3, 2] as i (i)}
		<span class="ds-spinner-cell bg-current" style:animation-delay="{i * 150}ms"></span>
	{/each}
</span>

<style>
	.ds-spinner-cell {
		opacity: 0.2;
		animation: ds-spinner-step 600ms steps(1, end) infinite;
	}
	@keyframes ds-spinner-step {
		0%,
		24% {
			opacity: 1;
		}
		25%,
		100% {
			opacity: 0.2;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ds-spinner-cell {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
