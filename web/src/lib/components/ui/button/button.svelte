<script lang="ts" module>
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { type VariantProps, tv } from 'tailwind-variants';

	// The site styles' shared type; each piece below is a literal so Tailwind's scanner emits it.
	const SITE_TYPE = 'font-jakarta font-semibold leading-[1.5]';
	// The filled pills. Their hover background comes from the wipe (`sweep.ts`), not from here.
	const PILL = `${SITE_TYPE} h-auto px-5 pt-2 pb-2.5`;
	// These keep their `border-2`. It reads as invisible against the button's own background, but
	// the icon box has a background of its own, so the border is what frames that box against the
	// page — drop it and the chevron floats free of the button.
	// `bg-clip-border` (over the base's `bg-clip-padding`) runs the button's background under that
	// border, so the border's inner edge and the icon box's edge sit on solid colour. Clipped at the
	// padding edge instead, the three would all end on one row, and when ScrollSmoother's transform
	// leaves the button between device pixels the page shows through as a light line along the box's
	// top or bottom edge (CUR-4031).
	const CHEVRON = `relative h-auto items-stretch justify-start gap-0 overflow-hidden border-2 bg-clip-border p-0 ${SITE_TYPE} no-underline hover:no-underline`;

	export const buttonVariants = tv({
		base: "rounded-none focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 border border-transparent bg-clip-padding text-lg font-medium focus-visible:ring-3 active:not-aria-[haspopup]:translate-y-px aria-invalid:ring-3 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-pre-line transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		// NOTE: `size` is declared BEFORE `variant` on purpose. tailwind-variants
		// emits classes in declaration order, so listing `variant` last lets the
		// default variant's padding/height win the tailwind-merge
		// over `size.default` — without having to touch the shared size scale.
		variants: {
			size: {
				default:
					'h-9 gap-1.5 px-2.5 text-base has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: 'h-8 gap-1 px-2.5 text-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
				lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				icon: 'size-9',
				'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
				'icon-sm': 'size-8',
				'icon-lg': 'size-10'
			},
			variant: {
				// `bg-dark-blue` / `text-dark-blue` rather than the semantic --primary and
				// --secondary-foreground: these two must read identically to `chevron-dark` and
				// `chevron-salmon`, which name the palette directly. Pinned here rather than on the
				// tokens so the panel backgrounds and `link` that also read --primary keep --dark-blue.
				default: `bg-dark-blue text-white ${PILL}`,
				secondary: `bg-secondary text-dark-blue ${PILL}`,
				tertiary: `bg-tertiary text-tertiary-foreground ${PILL}`,
				light: `border-0 bg-white text-dark-blue shadow-none ${PILL}`,
				outline:
					'border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-expanded:bg-muted aria-expanded:text-foreground shadow-xs',
				transparent:
					'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
				link: 'text-primary underline-offset-4 hover:underline',
				cta: 'relative h-auto w-full items-start justify-start overflow-hidden border-0 bg-dark-blue pt-[13px] pr-3.5 pb-2.5 pl-3 text-left font-jakarta leading-[1.4] font-bold text-white no-underline hover:no-underline after:absolute after:inset-0 after:z-0 after:origin-top-left after:scale-0 after:bg-salmon after:transition-transform after:duration-[800ms] after:ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:after:scale-100 motion-reduce:transition-none motion-reduce:after:transition-none',
				// Payload's Button Outline; `outline-salmon` is its dark-background twin. Unrelated to
				// shadcn's `outline` above, which only app controls (tables, dialogs) use.
				'outline-dark': `relative h-auto border-2 border-dark-blue bg-white px-4.5 pt-1.5 pb-2 ${SITE_TYPE} text-dark-blue no-underline hover:bg-pale-grey hover:no-underline`,
				// `outline-dark` for a dark-blue background: the panel shows through, framed in salmon.
				'outline-salmon': `relative h-auto border-2 border-salmon bg-transparent px-4.5 pt-1.5 pb-2 ${SITE_TYPE} text-salmon no-underline hover:no-underline`,
				'chevron-dark': `${CHEVRON} border-dark-blue bg-dark-blue text-white`,
				'chevron-light': `${CHEVRON} border-white bg-white text-dark-blue`,
				'chevron-salmon': `${CHEVRON} border-salmon bg-salmon text-dark-blue`
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	import SweepBlocks from './sweep-blocks.svelte';
	import { SWEEP_CLASSES, SWEEP_LABEL } from './sweep';

	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();

	// The filled and outlined site styles wipe on hover wherever they're used, so a plain
	// `<Button>` matches the CMS buttons without each caller rebuilding the effect.
	const sweep = $derived(variant ? SWEEP_CLASSES[variant] : undefined);
</script>

{#snippet content()}
	{#if sweep}
		<SweepBlocks fill={sweep.blocks} />
		<span class={cn(SWEEP_LABEL, sweep.label)}>{@render children?.()}</span>
	{:else}
		{@render children?.()}
	{/if}
{/snippet}

{#if href}
	<!-- eslint-disable svelte/no-navigation-without-resolve -- generic shadcn Button passes through any href (internal or external); resolve() cannot apply to an arbitrary prop -->
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), sweep?.button, className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? 'link' : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render content()}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), sweep?.button, className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render content()}
	</button>
{/if}
