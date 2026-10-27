<script lang="ts">
	import { Icon } from '@aipotluck/alpha-ds';
	import RiAddLine from '~icons/ri/add-line';
	import RiChatNewLine from '~icons/ri/chat-new-line';
	import RiSettings3Line from '~icons/ri/settings-3-line';
	import RiSearchLine from '~icons/ri/search-line';
	import RiShareLine from '~icons/ri/share-line';
	import RiFileCopyLine from '~icons/ri/file-copy-line';
	import RiCloseLine from '~icons/ri/close-line';
	import RiMenuLine from '~icons/ri/menu-line';
	import RiSendPlaneFill from '~icons/ri/send-plane-fill';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiFlashlightFill from '~icons/ri/flashlight-fill';
	import PageHead from './PageHead.svelte';

	const line = [
		['add-line', RiAddLine],
		['chat-new-line', RiChatNewLine],
		['settings-3-line', RiSettings3Line],
		['search-line', RiSearchLine],
		['share-line', RiShareLine],
		['file-copy-line', RiFileCopyLine],
		['close-line', RiCloseLine],
		['menu-line', RiMenuLine]
	] as const;
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Icons"
		lead="Remix Icon for everything (unplugin-icons: ~icons/ri/*). Colour follows the variant and the action’s role — never decoration."
	/>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Line — always Text 1</h2>
		<div class="grid grid-cols-2 gap-px border border-line-2 bg-line-2 sm:grid-cols-4">
			{#each line as [name, glyph] (name)}
				<div class="flex items-center gap-3 bg-surface-1 p-4">
					<Icon icon={glyph} size="lg" tone="default" /><code class="type-code text-fg-2"
						>{name}</code
					>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Fill — by role</h2>
		<ol class="flex flex-col gap-3 type-body text-fg-2">
			<li class="flex items-center gap-3">
				<Icon icon={RiDeleteBinFill} size="lg" tone="destructive" /> 1. Destructive or irreversible →
				Accent 2. Rare: one, maybe two per view.
			</li>
			<li class="flex items-center gap-3">
				<Icon icon={RiSendPlaneFill} size="lg" tone="accent" /> 2. The single primary action in context
				→ Accent 1.
			</li>
			<li class="flex items-center gap-3">
				<Icon icon={RiFlashlightFill} size="lg" tone="default" /> 3. Otherwise → Text 1, same as a line
				icon.
			</li>
		</ol>
		<p class="type-caption text-fg-3">
			Always pick the sharp-cornered variant. Glyphs are filled outlines: size with width/height,
			colour with color — never stroke.
		</p>
	</section>
</div>
