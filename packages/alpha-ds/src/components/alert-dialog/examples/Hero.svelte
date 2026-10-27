<script lang="ts">
	import { AlertDialog, Inline } from '@aipotluck/alpha-ds';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
</script>

<AlertDialog.Root>
	<AlertDialog.Trigger variant="destructive"
		><RiDeleteBinFill /> Forget everything</AlertDialog.Trigger
	>
	<AlertDialog.Portal>
		<AlertDialog.Backdrop />
		<AlertDialog.Popup>
			<AlertDialog.Title>Forget everything?</AlertDialog.Title>
			<AlertDialog.Description>
				All conversations, settings and contributions are deleted. This can’t be undone.
			</AlertDialog.Description>
			<Inline justify="end" gap="2">
				<AlertDialog.Close>Keep my data</AlertDialog.Close>
				<AlertDialog.Action variant="destructive"
					><RiDeleteBinFill /> Forget everything</AlertDialog.Action
				>
			</Inline>
		</AlertDialog.Popup>
	</AlertDialog.Portal>
</AlertDialog.Root>
