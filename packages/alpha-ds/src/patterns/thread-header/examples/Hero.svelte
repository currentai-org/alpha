<script lang="ts">
	import { Badge, Button, ThreadHeader } from '@aipotluck/alpha-ds';
	import RiShareLine from '~icons/ri/share-line';
	import RiMoreLine from '~icons/ri/more-line';
</script>

<div class="border border-line-2">
	<ThreadHeader title="EU AI Act catalog gaps">
		{#snippet leading()}<Badge>Apertus</Badge>{/snippet}
		{#snippet actions()}
			<Button variant="ghost" size="sm"><RiShareLine /> Share</Button>
			<Button variant="ghost" size="icon" aria-label="More"><RiMoreLine /></Button>
		{/snippet}
	</ThreadHeader>
</div>
