<!--
  @component
  Base UI `Menu.Separator` (engine: bits-ui DropdownMenu.Separator).
-->
<script lang="ts">
	import { DropdownMenu as Engine } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<Engine.Separator class={cn('-mx-1 my-1 h-px bg-line-surface', className)} />
