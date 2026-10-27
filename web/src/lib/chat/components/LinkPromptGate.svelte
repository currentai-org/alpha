<!--
  @component
  Reads a deep link's `?q=` / `?prompt=` / `?attachments=` on mount and acts on it only once the
  visitor has confirmed (CUR-2644). Rendered by `/chat` (ChatLanding) and `/chat/models/<id>`, which
  pass in how to attach, fill and send on their own composer.
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { useSettingsStore } from '$lib/chat/stores/settings.js';
	import LinkPromptDialog from '$lib/chat/components/LinkPromptDialog.svelte';
	import { linkPromptNeedsConfirmation, type LinkPromptRequest } from '$lib/chat/utils/linkParams';
	import {
		applyLinkPromptRequest,
		takeLinkPromptRequest,
		type LinkPromptTarget
	} from '$lib/chat/utils/linkPromptFlow';

	let {
		attach,
		fill,
		send,
		modelName
	}: Omit<LinkPromptTarget, 'gone'> & {
		/** The model the link picked, when it came through `/chat/models/<id>`. */
		modelName?: string;
	} = $props();

	const settings = useSettingsStore();

	/** A deep link waiting on the visitor's say-so. */
	let linkRequest = $state<LinkPromptRequest | null>(null);
	let unmounted = false;

	function apply(request: LinkPromptRequest) {
		linkRequest = null;
		return applyLinkPromptRequest(request, { attach, fill, send, gone: () => unmounted });
	}

	onMount(() => {
		const request = takeLinkPromptRequest();
		// A link that sends, or one that brings in files from elsewhere, is shown to the visitor first.
		// Nothing is fetched or sent before they confirm.
		if (request && linkPromptNeedsConfirmation(request)) linkRequest = request;
		else if (request) void apply(request);
	});
	onDestroy(() => {
		unmounted = true;
	});
</script>

<!-- A first visit also opens the welcome dialog. One dialog at a time: the request waits in memory
     until that one is dismissed. -->
{#if linkRequest && $settings.welcomeModalSeen}
	{@const request = linkRequest}
	<LinkPromptDialog
		{request}
		{modelName}
		onconfirm={() => apply(request)}
		oncancel={() => (linkRequest = null)}
	/>
{/if}
