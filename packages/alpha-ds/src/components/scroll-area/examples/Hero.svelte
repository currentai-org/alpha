<script lang="ts">
	import { ScrollArea, Surface } from '@aipotluck/alpha-ds';
</script>

<Surface border="auto" class="w-64">
	<ScrollArea.Root class="h-48">
		<ScrollArea.Viewport>
			<ScrollArea.Content class="p-3">
				{#each Array.from({ length: 30 }, (_, i) => i + 1) as n (n)}
					<p class="py-1 type-body text-fg-2">Conversation {n}</p>
				{/each}
			</ScrollArea.Content>
		</ScrollArea.Viewport>
		<ScrollArea.Scrollbar />
	</ScrollArea.Root>
</Surface>
