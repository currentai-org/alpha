<script lang="ts">
	import { Button, Dialog, Field, Inline } from '@aipotluck/alpha-ds';

	/** Rename a conversation from the side rail's Conversation actions menu (CUR-2629). */
	interface Props {
		open?: boolean;
		title: string;
		onrename: (title: string) => void;
	}

	let { open = $bindable(false), title, onrename }: Props = $props();

	// The server's PATCH accepts 1-100 characters after trimming.
	const MAX_TITLE = 100;

	let draft = $state('');
	$effect(() => {
		if (open) draft = title;
	});

	let trimmed = $derived(draft.trim());
	let canSave = $derived(trimmed.length > 0 && trimmed !== title.trim());

	function save(e?: SubmitEvent) {
		e?.preventDefault();
		if (!canSave) return;
		onrename(trimmed);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="rename-conversation-dialog">
			<Dialog.Title>Rename conversation</Dialog.Title>
			<form onsubmit={save} class="flex flex-col gap-4">
				<Field.Root>
					<Field.Label>Title</Field.Label>
					<Field.Control bind:value={draft} maxlength={MAX_TITLE} autofocus />
				</Field.Root>
				<Inline justify="end" gap="2">
					<Dialog.Close>Cancel</Dialog.Close>
					<Button type="submit" variant="primary" disabled={!canSave}>Save</Button>
				</Inline>
			</form>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
