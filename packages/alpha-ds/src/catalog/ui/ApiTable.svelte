<!--
  @component
  Base UI–style reference table: Prop / Type / Default (+ description), or Attribute / Description.
-->
<script lang="ts">
	import type { AttrDoc, PropDoc } from '../types.ts';

	let {
		props,
		attrs,
		attrLabel = 'Attribute'
	}: { props?: PropDoc[]; attrs?: AttrDoc[]; attrLabel?: string } = $props();
</script>

<div class="overflow-x-auto border border-line-2">
	<table class="w-full border-collapse text-left">
		<thead class="bg-surface-2">
			<tr class="type-label text-fg-3">
				{#if props}
					<th class="w-1/4 px-3 py-2 font-medium">Prop</th>
					<th class="px-3 py-2 font-medium">Type</th>
					<th class="w-24 px-3 py-2 font-medium">Default</th>
				{:else}
					<th class="w-1/3 px-3 py-2 font-medium">{attrLabel}</th>
					<th class="px-3 py-2 font-medium">Description</th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each props ?? [] as p (p.name)}
				<tr class="border-t border-line-1 align-top">
					<td class="px-3 py-2.5"><code class="type-code text-fg-1">{p.name}</code></td>
					<td class="px-3 py-2.5">
						<code class="type-code break-words text-accent-1-text">{p.type}</code>
						{#if p.description}<p class="mt-1 type-caption text-fg-2">{p.description}</p>{/if}
					</td>
					<td class="px-3 py-2.5"><code class="type-code text-fg-3">{p.default ?? '—'}</code></td>
				</tr>
			{/each}
			{#each attrs ?? [] as a (a.name)}
				<tr class="border-t border-line-1 align-top">
					<td class="px-3 py-2.5"><code class="type-code text-fg-1">{a.name}</code></td>
					<td class="px-3 py-2.5 type-caption text-fg-2">{a.description || '—'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
