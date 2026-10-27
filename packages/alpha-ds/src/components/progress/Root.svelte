<!--
  @component
  Base UI `Progress.Root` — task completion. `value={null}` is indeterminate.
  Anatomy: Root › Label + Value + Track › Indicator. Also backs `Meter.Root` (role="meter").
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { setRange } from './context.ts';

	let {
		value = null,
		min = 0,
		max = 100,
		format,
		role = 'progressbar',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & {
		value?: number | null;
		min?: number;
		max?: number;
		/** Intl options, or a function, for the Value part. */
		format?: Intl.NumberFormatOptions | ((value: number) => string);
		role?: 'progressbar' | 'meter';
	} = $props();

	const uid = $props.id();
	const percent = $derived(value == null ? null : ((value - min) / (max - min)) * 100);
	const formatted = $derived.by(() => {
		if (value == null) return '';
		if (typeof format === 'function') return format(value);
		if (format) return new Intl.NumberFormat(undefined, format).format(value);
		return new Intl.NumberFormat(undefined, { style: 'percent' }).format((percent ?? 0) / 100);
	});

	setRange({
		get value() {
			return value;
		},
		get min() {
			return min;
		},
		get max() {
			return max;
		},
		get percent() {
			return percent;
		},
		get formatted() {
			return formatted;
		},
		labelId: `${uid}-label`
	});
</script>

<div
	{...rest}
	{role}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={value ?? undefined}
	aria-valuetext={formatted || undefined}
	aria-labelledby={`${uid}-label`}
	data-indeterminate={value == null ? '' : undefined}
	data-complete={value != null && value >= max ? '' : undefined}
	class={cn('grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5', className)}
>
	{@render children?.()}
</div>
