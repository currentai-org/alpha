<!--
  @component
  Base UI `Combobox.Separator`: a rule between the matches and an item that always shows. A plain
  element, since bits-ui's menu separator needs a Menu around it.
-->
<script lang="ts">
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<div role="separator" class={cn('-mx-1 my-1 h-px bg-line-surface', className)}></div>
