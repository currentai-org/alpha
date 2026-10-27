<!--
  @component
  Base UI `AlertDialog.Description` (engine: bits-ui AlertDialog.Description).
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogDescriptionProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: AlertDialogDescriptionProps = $props();
</script>

<Engine.Description {...rest} class={cn('type-body text-fg-2', className)}>
	{@render children?.()}
</Engine.Description>
