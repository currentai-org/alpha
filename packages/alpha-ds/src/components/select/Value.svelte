<!--
  @component
  Base UI `Select.Value` (engine: bits-ui Select.Value) — the selected label, or `placeholder`.
-->
<script lang="ts">
	import { Select as Engine } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { placeholder = 'Select…', class: className }: { placeholder?: string; class?: string } =
		$props();
</script>

<Engine.Value
	{placeholder}
	class={cn('min-w-0 flex-1 truncate data-placeholder:text-fg-3', className)}
/>
