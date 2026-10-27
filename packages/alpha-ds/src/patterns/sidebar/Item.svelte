<!--
  @component
  `Sidebar.Item` — a navigation row. Icon + label; in the collapsed rail it shows the icon only
  and exposes the label as a tooltip and accessible name. `current` marks the open conversation
  (ink tint tile, spec §5 active state). `emphasis` is for the top actions (New chat) — Font 2
  uppercase nav type. Renders an `<a>` with `href`, else a `<button>`. `trailing` is a hover- and focus-revealed
  slot (row menu).
-->
<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { Tooltip } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { getAppShell } from '../app-shell/context.svelte.ts';

	let {
		href,
		icon: Glyph,
		current = false,
		emphasis = false,
		tall = false,
		leading,
		onclick,
		trailing,
		marker,
		class: className,
		children,
		label,
		triggerProps,
		'aria-label': ariaLabel,
		...rest
	}: {
		href?: string;
		icon?: Component<Record<string, unknown>>;
		current?: boolean;
		emphasis?: boolean;
		/** Two-line rows (account: avatar + name + status) — grows instead of clipping. */
		tall?: boolean;
		/** Visual that stays visible in the collapsed rail (e.g. the account avatar). */
		leading?: Snippet;
		onclick?: (e: MouseEvent) => void;
		/** Trailing slot (e.g. a row Menu), revealed while the row is hovered or has keyboard focus. */
		trailing?: Snippet;
		/** Always-visible status chip, sitting left of `trailing`. Unlike `trailing` it never hides: it
		 *  reports something about the row that stays true whether or not the pointer is here. */
		marker?: Snippet;
		class?: string;
		children?: Snippet;
		/** Plain-text label, used for the rail tooltip / aria-label. Defaults to children. */
		label?: string;
		/** Props from a floating part's `child` snippet, to make this row a Popover/Menu trigger. */
		triggerProps?: Record<string, unknown>;
		/** An accessible name that says more than the label. Overrides the rail's label-as-name. */
		'aria-label'?: string;
		/** Any other attribute (data-sveltekit-*, title…) lands on the row element. */
		[key: string]: unknown;
	} = $props();

	const shell = getAppShell();
	const rail = $derived(shell.collapsed);

	const rowClass = $derived(
		cn(
			'group/item relative flex w-full min-w-0 items-center gap-2.5 rounded-sharp px-2 text-left transition-control',
			emphasis ? 'h-control-md type-nav text-fg-1' : 'h-control-sm type-body text-fg-2',
			tall &&
				'h-auto min-h-control-lg py-1.5 md:group-data-collapsed/sidebar:min-h-0 md:group-data-collapsed/sidebar:py-0',
			// Phones: 44px touch targets and body-size labels.
			'max-md:min-h-11 max-md:gap-3 max-md:px-3 max-md:[&_svg]:size-5',
			'hover:bg-tint-subtle hover:text-fg-1',
			current && 'bg-tint-hover text-fg-1 hover:bg-tint-hover',
			'[&_svg]:size-4 [&_svg]:shrink-0',
			'md:group-data-collapsed/sidebar:size-control-md md:group-data-collapsed/sidebar:justify-center md:group-data-collapsed/sidebar:px-0',
			className
		)
	);
</script>

{#snippet inner()}
	{#if Glyph}<Glyph aria-hidden="true" />{/if}
	{@render leading?.()}
	<span
		class={cn(
			'min-w-0 flex-1 truncate md:group-data-collapsed/sidebar:sr-only',
			// A marker is permanent, so the title stops before it rather than running underneath. The
			// hover-only trailing slot never needed this: transient overlap is fine, constant is not.
			//
			// 40px is arithmetic, not taste. The trailing container sits `right-1` (4px) and holds the
			// marker (20px) + `gap-1` (4px) + an icon-xs trigger (24px), so the marker's left edge is
			// 52px from the row's edge; this padding is measured from inside the row's own px-2, so
			// 8 + 40 leaves the title 4px clear of the marker -- the same 4px rhythm as the gap between
			// marker and trigger. A marker much wider than 20px would need this raised with it.
			marker && 'pr-10'
		)}
	>
		{#if children}{@render children()}{:else}{label}{/if}
	</span>
{/snippet}

<li class="group/row relative flex items-center md:group-data-collapsed/sidebar:justify-center">
	<Tooltip.Root disabled={!rail}>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				{#if href}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- consumer passes a resolved href -->
					<a
						{...rest}
						{...props}
						{href}
						{onclick}
						class={rowClass}
						aria-current={current ? 'page' : undefined}
						aria-label={ariaLabel ?? (rail ? label : undefined)}
					>
						{@render inner()}
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else}
					<button
						{...rest}
						{...props}
						{...triggerProps}
						type="button"
						{onclick}
						class={rowClass}
						aria-current={current ? 'page' : undefined}
						aria-label={ariaLabel ?? (rail ? label : undefined)}
					>
						{@render inner()}
					</button>
				{/if}
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content
			side="right"
			sideOffset={8}
			class="z-tooltip motion-popup rounded-sharp border border-line-2 bg-surface-3 px-2 py-1 type-caption text-fg-1 shadow-popover"
		>
			{label}
		</Tooltip.Content>
	</Tooltip.Root>
	{#if (trailing || marker) && !rail}
		<div class="absolute right-1 flex items-center gap-1">
			{#if marker}{@render marker()}{/if}
			{#if trailing}
				<!-- The reveal is opacity, never display, so the menu keeps its space while hidden and a
				     marker beside it does not jump sideways when the row is hovered. -->
				<div
					class={cn(
						'flex items-center opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-[[data-state=open]]:opacity-100',
						current && 'opacity-100'
					)}
				>
					{@render trailing()}
				</div>
			{/if}
		</div>
	{/if}
</li>
