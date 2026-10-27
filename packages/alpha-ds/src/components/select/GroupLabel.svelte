<!--
  @component
  Base UI `Select.GroupLabel` (engine: bits-ui Select.GroupHeading).
-->
<script lang="ts">
	import { Select as Engine, type SelectGroupHeadingProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: SelectGroupHeadingProps = $props();
</script>

<Engine.GroupHeading {...rest} class={cn('px-2 pt-2 pb-1 type-label text-fg-3', className)}>
	{@render children?.()}
</Engine.GroupHeading>
