<script lang="ts">
	import { Badge } from '@aipotluck/alpha-ds';
	let { title, lead }: { title: string; lead: string } = $props();
</script>

<header class="flex flex-col items-start gap-4">
	<Badge>Foundation</Badge>
	<h1 class="type-display">{title}</h1>
	<p class="type-subhead max-w-2xl font-normal text-fg-2">{lead}</p>
</header>
