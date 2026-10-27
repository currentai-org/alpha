<!--
  @component
  Base UI `Dialog.Backdrop` (engine: bits-ui Dialog.Overlay). `blur` is reserved for the
  onboarding modal — the spec's one blur, over a lighter scrim so the app shows through.
-->
<script lang="ts">
	import { Dialog as Engine, type DialogOverlayProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		blur = false,
		class: className,
		...rest
	}: DialogOverlayProps & { blur?: boolean } = $props();
</script>

<Engine.Overlay
	{...rest}
	class={cn(
		'fixed inset-0 z-overlay motion-fade',
		// The onboarding scrim is lighter than a working dialog's: half the dim and a soft blur, so the
		// app it introduces still reads behind it.
		blur ? 'bg-overlay/50 backdrop-blur-xs' : 'bg-overlay',
		className
	)}
/>
