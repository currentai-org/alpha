<script lang="ts">
	import { Menu } from '@aipotluck/alpha-ds';
	import RiMoreLine from '~icons/ri/more-line';
	import RiPencilLine from '~icons/ri/pencil-line';
	import RiShareLine from '~icons/ri/share-line';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	let pinned = $state(false);
</script>

<Menu.Root>
	<Menu.Trigger size="icon" aria-label="Conversation options"><RiMoreLine /></Menu.Trigger>
	<Menu.Portal>
		<Menu.Positioner>
			<Menu.Popup>
				<Menu.Item><RiPencilLine /> Rename</Menu.Item>
				<Menu.Item><RiShareLine /> Share</Menu.Item>
				<Menu.CheckboxItem bind:checked={pinned}>Pin to top</Menu.CheckboxItem>
				<Menu.Separator />
				<Menu.Item tone="destructive"><RiDeleteBinFill /> Delete</Menu.Item>
			</Menu.Popup>
		</Menu.Positioner>
	</Menu.Portal>
</Menu.Root>
