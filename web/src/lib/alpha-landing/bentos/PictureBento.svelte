<script lang="ts">
	import type { Component } from 'svelte';
	import { BentoTile } from '@aipotluck/alpha-ds';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { FEATURE_PICTURES, featurePictureSrc, type FeaturePicture } from './pictures';

	/**
	 * A feature card whose heading is live text and whose scene is a picture of the feature in Alpha,
	 * so /alpha needs none of chat's code. The heading carries the meaning, so the picture is decorative.
	 */
	let {
		name,
		icon,
		title,
		body
	}: {
		name: FeaturePicture;
		icon: Component<Record<string, unknown>>;
		title: string;
		body: string;
	} = $props();

	const size = $derived(FEATURE_PICTURES[name]);
</script>

<BentoTile {icon} {title} {body}>
	<img
		src={featurePictureSrc(name, getLocale())}
		alt=""
		width={size.width}
		height={size.height}
		loading="lazy"
		decoding="async"
		class="h-auto max-w-full"
		data-feature-picture={name}
	/>
</BentoTile>
