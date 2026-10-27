<!--
  @component
  Base UI `Dialog.Description` (engine: bits-ui Dialog.Description).
-->
<script lang="ts">
	import { Dialog as Engine, type DialogDescriptionProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: DialogDescriptionProps = $props();
</script>

<Engine.Description {...rest} class={cn('type-body text-fg-2', className)}>
	{@render children?.()}
</Engine.Description>
