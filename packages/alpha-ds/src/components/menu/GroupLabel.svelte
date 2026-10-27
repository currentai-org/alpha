<!--
  @component
  Base UI `Menu.GroupLabel` (engine: bits-ui DropdownMenu.GroupHeading).
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuGroupHeadingProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: DropdownMenuGroupHeadingProps = $props();
</script>

<Engine.GroupHeading {...rest} class={cn('px-2 pt-2 pb-1 type-label text-fg-3', className)}>
	{@render children?.()}
</Engine.GroupHeading>
