<script lang="ts">
	import { cn } from '@aipotluck/alpha-ds';

	/**
	 * The AI Potluck mark (the four-diamond cluster from the site logo), used as Alpha's app logo.
	 * Drawn in the theme's accent — which in the Alpha theme is exactly the brand coral — so it sits
	 * naturally in every theme. Decorative by default; pass `label` when it stands alone.
	 */
	let { class: className, label }: { class?: string; label?: string } = $props();
</script>

<svg
	viewBox="0 0 35.55 35.55"
	fill="currentColor"
	class={cn('shrink-0 text-accent-1', className)}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	data-potluck-mark
>
	<path d="M11.8134 0L0 11.8134L5.92823 17.7416L17.7416 5.92823L11.8134 0Z" />
	<path d="M29.6181 17.8027L17.8047 29.6161L23.7329 35.5443L35.5463 23.731L29.6181 17.8027Z" />
	<path d="M5.92929 17.7422L0.0195312 23.6519L11.8821 35.5146L17.7919 29.6048L5.92929 17.7422Z" />
	<path d="M23.6559 0.0253906L17.7461 5.93515L29.6087 17.7978L35.5185 11.888L23.6559 0.0253906Z" />
</svg>
