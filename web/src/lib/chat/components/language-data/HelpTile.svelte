<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';

	/**
	 * One way to help, as a tile: an icon, a short title, one line on what it involves, and a glyph for
	 * where it goes (a partner site in a new tab, or a form that opens in place). With `href` it is a
	 * link out; without, a button. `children` carries extra accessible text, such as which partner opens.
	 */
	type Props = {
		icon: Component<Record<string, unknown>>;
		title: string;
		hint: string;
		children?: Snippet;
	} & (
		| ({ href: string } & Omit<HTMLAnchorAttributes, 'href' | 'children'>)
		| ({ href?: undefined } & Omit<HTMLButtonAttributes, 'children'>)
	);

	let { icon: Icon, title, hint, children, ...rest }: Props = $props();
	const tile =
		'flex items-start gap-3 rounded-card border border-line-2 bg-surface-1 px-3 py-2.5 text-left transition-control hover:border-line-3 hover:bg-tint-hover';
</script>

{#snippet body(external: boolean)}
	<Icon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-accent-1-text" />
	<span class="flex min-w-0 flex-1 flex-col">
		<span class="type-caption font-medium text-fg-1">{title}</span>
		<span class="truncate type-caption text-fg-3">{hint}</span>
	</span>
	{#if external}
		<RiArrowRightUpLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-3" />
	{:else}
		<RiArrowRightSLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-3" />
	{/if}
	{@render children?.()}
{/snippet}

{#if rest.href !== undefined}
	<a target="_blank" rel="noreferrer" {...rest as HTMLAnchorAttributes} class={tile}>{@render body(true)}</a>
{:else}
	<button type="button" {...rest as HTMLButtonAttributes} class={tile}>{@render body(false)}</button>
{/if}
