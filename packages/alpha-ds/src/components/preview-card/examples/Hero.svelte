<script lang="ts">
	import { PreviewCard } from '@aipotluck/alpha-ds';
	import RiFlashlightFill from '~icons/ri/flashlight-fill';
</script>

<PreviewCard.Root>
	<PreviewCard.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="inline-flex h-control-sm items-center gap-2 border border-line-2 bg-surface-raised px-2 type-caption text-fg-2"
			>
				<span class="grid size-4 place-items-center bg-accent-1 text-fg-on-accent"
					><RiFlashlightFill class="size-3" /></span
				>
				You consumed: 0.1 Wh
			</button>
		{/snippet}
	</PreviewCard.Trigger>
	<PreviewCard.Portal>
		<PreviewCard.Positioner side="top" align="start">
			<PreviewCard.Popup inverse>
				<p class="type-title">You have spent 1 min with Alpha this session</p>
				<p class="mt-2 type-caption text-fg-2">About 28 sec of a 10-watt LED bulb.</p>
			</PreviewCard.Popup>
		</PreviewCard.Positioner>
	</PreviewCard.Portal>
</PreviewCard.Root>
