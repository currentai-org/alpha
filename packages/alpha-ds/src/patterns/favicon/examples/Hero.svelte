<script lang="ts">
	import { Favicon } from '@aipotluck/alpha-ds';

	// The app's own icon stands in for a site's; the second row's image is missing and the third
	// has none, so both draw the globe.
	const sources = [
		{ n: 1, title: 'AI Potluck — an open alternative to closed AI', src: '/favicon.svg' },
		{ n: 2, title: 'A site whose icon fails to load', src: '/no-such-icon.ico' },
		{ n: 3, title: 'A page with no icon to ask for', src: null }
	];
</script>

<ol class="flex w-80 flex-col gap-2">
	{#each sources as source (source.n)}
		<li class="flex min-w-0 items-center gap-2 type-caption">
			<span class="text-fg-3 tabular-nums">[{source.n}]</span>
			<Favicon src={source.src} />
			<a
				href="#top"
				class="min-w-0 truncate text-fg-1 underline decoration-line-3 underline-offset-2"
				>{source.title}</a
			>
		</li>
	{/each}
</ol>
