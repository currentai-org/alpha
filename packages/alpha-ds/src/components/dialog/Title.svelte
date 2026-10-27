<!--
  @component
  Base UI `Dialog.Title` (engine: bits-ui Dialog.Title).
-->
<script lang="ts">
	import { Dialog as Engine, type DialogTitleProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: DialogTitleProps = $props();
</script>

<Engine.Title {...rest} class={cn('type-heading text-fg-1', className)}
	>{@render children?.()}</Engine.Title
>
