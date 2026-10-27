<script lang="ts">
	import { Button, Inline, Toast, createToastManager } from '@aipotluck/alpha-ds';

	const manager = createToastManager();
</script>

<Toast.Provider {manager}>
	<Inline gap="2">
		<Button onclick={() => manager.add({ title: 'Link copied' })}>Default</Button>
		<Button
			onclick={() =>
				manager.add({ title: 'Saved', description: 'Settings updated.', type: 'success' })}
			>Success</Button
		>
		<Button
			onclick={() =>
				manager.add({
					title: 'Rate limit reached',
					description: 'Try again in a minute.',
					type: 'error'
				})}>Error</Button
		>
		<Button
			onclick={() =>
				manager.promise(new Promise((r) => setTimeout(r, 1500)), {
					loading: 'Exporting…',
					success: 'Export ready',
					error: 'Export failed'
				})}>Promise</Button
		>
	</Inline>
	<Toast.Viewport inline class="mt-4" />
</Toast.Provider>
