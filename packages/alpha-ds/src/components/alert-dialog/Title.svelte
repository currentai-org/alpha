<!--
  @component
  Base UI `AlertDialog.Title` (engine: bits-ui AlertDialog.Title).
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogTitleProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: AlertDialogTitleProps = $props();
</script>

<Engine.Title {...rest} class={cn('type-heading text-fg-1', className)}
	>{@render children?.()}</Engine.Title
>
