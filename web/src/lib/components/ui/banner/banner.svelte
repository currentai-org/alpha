<script lang="ts" module>
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import { type VariantProps, tv } from 'tailwind-variants';

	export const bannerVariants = tv({
		base: 'flex w-full items-center gap-3 border-b px-4 py-2.5 text-base font-medium leading-snug md:px-5',
		variants: {
			variant: {
				// Amber "heads up" — the default; used for the maintenance / service-interruption
				// notice. A SOLID amber bar with dark ink text so it reads the same (and stays
				// legible) on both the light site and the dark-scoped chat card — a warning should
				// be prominent, not a subtle theme-tinted wash.
				warning: 'border-amber-500 bg-amber-400 text-amber-950',
				// Solid red, for harder failures if ever needed.
				destructive: 'border-red-700 bg-red-500 text-white'
			}
		},
		defaultVariants: {
			variant: 'warning'
		}
	});

	export type BannerVariant = VariantProps<typeof bannerVariants>['variant'];

	export type BannerProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: BannerVariant;
		/** When true, render a dismiss button and fire `ondismiss` when clicked. */
		dismissible?: boolean;
		ondismiss?: () => void;
	};
</script>

<script lang="ts">
	import CarbonWarning from '~icons/carbon/warning';
	import CarbonClose from '~icons/carbon/close';

	let {
		class: className,
		variant = 'warning',
		dismissible = false,
		ondismiss,
		ref = $bindable(null),
		children,
		...restProps
	}: BannerProps = $props();
</script>

<div
	bind:this={ref}
	data-slot="banner"
	role="status"
	aria-live="polite"
	class={cn(bannerVariants({ variant }), className)}
	{...restProps}
>
	<CarbonWarning class="size-4 shrink-0" aria-hidden="true" />
	<div class="min-w-0 flex-1">
		{@render children?.()}
	</div>
	{#if dismissible}
		<button
			type="button"
			aria-label="Dismiss"
			class="-mr-0.5 shrink-0 cursor-pointer rounded p-0.5 opacity-70 transition hover:opacity-100"
			onclick={() => ondismiss?.()}
		>
			<CarbonClose class="size-4" aria-hidden="true" />
		</button>
	{/if}
</div>
