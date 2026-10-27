<!--
  @component
  Base UI `Avatar.Fallback` (engine: bits-ui Avatar.Fallback) — initials in DM Mono.
-->
<script lang="ts">
	import { Avatar as Engine, type AvatarFallbackProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: AvatarFallbackProps = $props();
</script>

<Engine.Fallback {...rest} class={cn('font-mono font-medium text-fg-1 uppercase', className)}>
	{@render children?.()}
</Engine.Fallback>
