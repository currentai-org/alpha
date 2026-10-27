<!--
  @component
  Stands in for the composer while files are dragged over the chat. It only shows where a drop will
  land: ChatWindow's window-level drop handler attaches the files wherever they are let go.
-->
<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiAttachment from '~icons/ri/attachment-line';
	import { orgs } from '$lib/chat/routing/catalog';
	import OrgMention from '../provenance/OrgMention.svelte';
</script>

<div
	id="dropzone"
	class="flex h-28 w-full flex-col items-center justify-center gap-1 rounded-field border border-dashed border-line-3 bg-surface-3 text-fg-2"
>
	<RiAttachment aria-hidden="true" class="size-5" />
	<p class="type-body text-fg-1">{m.product_dropFilesToAttach()}</p>
	<p class="type-caption text-fg-3">
		{#each m.product_attachFilesWhere({ org: '{org}' }).split(/(\{org\})/).filter(Boolean) as part, i (i)}{#if part === '{org}'}<OrgMention org={orgs.huggingface} />{:else}{part}{/if}{/each}
	</p>
</div>
