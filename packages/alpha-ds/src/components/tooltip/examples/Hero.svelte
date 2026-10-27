<script lang="ts">
	import { Tooltip } from '@aipotluck/alpha-ds';
	import RiFileCopyLine from '~icons/ri/file-copy-line';
	import RiRefreshLine from '~icons/ri/refresh-line';
</script>

<div class="flex gap-1">
	<Tooltip.Root>
		<Tooltip.Trigger variant="ghost" size="icon" aria-label="Copy"
			><RiFileCopyLine /></Tooltip.Trigger
		>
		<Tooltip.Portal>
			<Tooltip.Positioner side="top"><Tooltip.Popup>Copy</Tooltip.Popup></Tooltip.Positioner>
		</Tooltip.Portal>
	</Tooltip.Root>
	<Tooltip.Root>
		<Tooltip.Trigger variant="ghost" size="icon" aria-label="Retry"
			><RiRefreshLine /></Tooltip.Trigger
		>
		<Tooltip.Portal>
			<Tooltip.Positioner side="top"><Tooltip.Popup>Retry</Tooltip.Popup></Tooltip.Positioner>
		</Tooltip.Portal>
	</Tooltip.Root>
</div>
