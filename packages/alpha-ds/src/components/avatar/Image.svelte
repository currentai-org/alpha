<!--
  @component
  Base UI `Avatar.Image` (engine: bits-ui Avatar.Image).
-->
<script lang="ts">
	import { Avatar as Engine, type AvatarImageProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, ...rest }: AvatarImageProps = $props();
</script>

<Engine.Image {...rest} class={cn('size-full object-cover', className)} />
