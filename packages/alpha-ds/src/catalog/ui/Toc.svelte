<!--
  @component
  "On this page" — highlights the section in view.
-->
<script lang="ts">
	import { cn } from '@aipotluck/alpha-ds';

	let { items }: { items: { id: string; label: string; depth?: number }[] } = $props();
	let active = $state('');

	$effect(() => {
		const els = items
			.map((i) => document.getElementById(i.id))
			.filter((e): e is HTMLElement => !!e);
		const io = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((e) => e.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible[0]) active = visible[0].target.id;
			},
			{ rootMargin: '-120px 0px -60% 0px' }
		);
		els.forEach((e) => io.observe(e));
		return () => io.disconnect();
	});
</script>

<nav aria-label="On this page" class="flex flex-col gap-2">
	<p class="type-label text-fg-3">On this page</p>
	<ul role="list" class="flex flex-col border-l border-line-2">
		{#each items as item (item.id)}
			<li>
				<a
					href="#{item.id}"
					class={cn(
						'-ml-px block border-l py-1 type-caption transition-control',
						item.depth ? 'pl-6' : 'pl-3',
						active === item.id
							? 'border-fg-1 text-fg-1'
							: 'border-transparent text-fg-3 hover:text-fg-1'
					)}>{item.label}</a
				>
			</li>
		{/each}
	</ul>
</nav>
