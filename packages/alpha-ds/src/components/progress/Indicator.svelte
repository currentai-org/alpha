<!--
  @component
  Base UI `Progress.Indicator` — width follows the value; slides while indeterminate.
-->
<script lang="ts">
	import { cn } from '../../internal/cn.ts';
	import { getRange } from './context.ts';

	let { tone = 'default', class: className }: { tone?: 'default' | 'accent'; class?: string } =
		$props();
	const range = getRange();
</script>

<div
	class={cn(
		'absolute inset-y-0 left-0 transition-[width] duration-(--ds-duration-base) ease-standard',
		tone === 'accent' ? 'bg-accent-1' : 'bg-fg-1',
		range.percent == null && 'w-1/3 animate-[ds-indeterminate_1.1s_linear_infinite]',
		className
	)}
	style:width={range.percent == null ? undefined : `${Math.max(0, Math.min(100, range.percent))}%`}
></div>

<style>
	@keyframes -global-ds-indeterminate {
		from {
			translate: -100% 0;
		}
		to {
			translate: 300% 0;
		}
	}
</style>
