<!--
SPDX-FileCopyrightText: 2018- The Hugging Face team
SPDX-License-Identifier: Apache-2.0
Modified by Current AI from huggingface/chat-ui.
-->
<script lang="ts">
	import { page } from '$app/state';
	import ChatShell from '$lib/chat/components/ChatShell.svelte';

	let { data = $bindable(), children } = $props();

	// The landing page (+page.server.ts) hands its head tags to a Payload page when one exists at
	// slug `chat`, and a public page that writes its own (languages/, `ownsHeadTags`) does the same;
	// ChatShell's own tags stand down only on those pages.
	const hasPageSeo = $derived(Boolean(page.data.landingSeoPage || page.data.ownsHeadTags));
</script>

<ChatShell bind:data {hasPageSeo}>
	{@render children?.()}
</ChatShell>
