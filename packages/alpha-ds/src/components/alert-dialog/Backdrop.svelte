<!--
  @component
  Base UI `AlertDialog.Backdrop` (engine: bits-ui AlertDialog.Overlay).
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogOverlayProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, ...rest }: AlertDialogOverlayProps = $props();
</script>

<Engine.Overlay {...rest} class={cn('fixed inset-0 z-overlay motion-fade bg-overlay', className)} />
