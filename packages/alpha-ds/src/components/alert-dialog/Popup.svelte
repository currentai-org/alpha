<!--
  @component
  Base UI `AlertDialog.Popup` (engine: bits-ui AlertDialog.Content).
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: AlertDialogContentProps = $props();
</script>

<Engine.Content
	{...rest}
	data-surface="3"
	class={cn(
		'fixed top-1/2 left-1/2 z-overlay flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
		'motion-dialog rounded-sharp border border-line-2 bg-surface-3 p-6 text-fg-1 shadow-popover outline-none',
		className
	)}
>
	{@render children?.()}
</Engine.Content>
