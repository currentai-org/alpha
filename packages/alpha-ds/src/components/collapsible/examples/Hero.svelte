<script lang="ts">
	import { Collapsible } from '@aipotluck/alpha-ds';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	let open = $state(false);
</script>

<Collapsible.Root bind:open class="max-w-lg">
	<Collapsible.Trigger>
		<RiArrowRightSLine class={open ? 'rotate-90' : ''} /> Show reasoning
	</Collapsible.Trigger>
	<Collapsible.Panel>
		<p class="border-l-2 border-line-2 py-2 pl-3 type-caption text-fg-2">
			Compared the 2024 and 2025 releases; the newer one changed the licence.
		</p>
	</Collapsible.Panel>
</Collapsible.Root>
