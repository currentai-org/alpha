<script lang="ts">
	import { Badge, Frame } from '@aipotluck/alpha-ds';
</script>

<Frame elevated class="h-40 max-w-lg">
	{#snippet title()}<span aria-hidden="true">···</span> Alpha <span class="text-fg-3">/</span> Apertus{/snippet}
	{#snippet actions()}<Badge>Demo</Badge>{/snippet}
	<div class="p-4 type-body text-fg-2">Window content sits on Background 1.</div>
</Frame>
