<!--
  @component
  Base UI `Select.Icon` — the disclosure chevron.
-->
<script lang="ts">
	import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<RiArrowDownSLine class={cn('size-4 shrink-0 text-fg-2', className)} aria-hidden="true" />
