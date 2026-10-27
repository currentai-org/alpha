<script lang="ts">
	import { Button, Dialog, Field, Inline } from '@aipotluck/alpha-ds';
	let open = $state(false);
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger>Rename conversation</Dialog.Trigger>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm">
			<Dialog.Title>Rename</Dialog.Title>
			<Dialog.Description>Titles are only visible to you.</Dialog.Description>
			<Field.Root>
				<Field.Label>Title</Field.Label>
				<Field.Control value="EU AI Act catalog gaps" />
			</Field.Root>
			<Inline justify="end" gap="2">
				<Dialog.Close>Cancel</Dialog.Close>
				<Button variant="primary" onclick={() => (open = false)}>Save</Button>
			</Inline>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
