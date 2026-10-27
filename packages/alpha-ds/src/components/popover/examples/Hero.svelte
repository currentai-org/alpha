<script lang="ts">
	import { Popover, Switch } from '@aipotluck/alpha-ds';
	import RiShareLine from '~icons/ri/share-line';
	let pub = $state(false);
</script>

<Popover.Root>
	<Popover.Trigger><RiShareLine /> Share</Popover.Trigger>
	<Popover.Portal>
		<Popover.Positioner side="bottom" align="start">
			<Popover.Popup size="md">
				<Popover.Title>Share this conversation</Popover.Title>
				<Popover.Description
					>Anyone with the link can read it. Your name isn’t shown.</Popover.Description
				>
				<label class="mt-3 flex items-center justify-between type-body">
					Public link <Switch.Root bind:checked={pub}><Switch.Thumb /></Switch.Root>
				</label>
			</Popover.Popup>
		</Popover.Positioner>
	</Popover.Portal>
</Popover.Root>
