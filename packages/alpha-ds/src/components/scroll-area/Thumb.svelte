<!--
  @component
  Base UI `ScrollArea.Thumb` (engine: bits-ui ScrollArea.Thumb).
-->
<script lang="ts">
	import { ScrollArea as Engine } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<Engine.Thumb class={cn('flex-1 bg-line-3 hover:bg-fg-2', className)} />
