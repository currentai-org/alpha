<script lang="ts">
	// CUR-1276. Thin wrapper: the actual panel is FilesPanel.svelte, built self-contained so it can
	// later mount inside an in-chat overlay (matching XRAY VIEW) instead of a standalone route,
	// without changing anything about how it works.
	import FilesPanel from '$lib/chat/components/storage/FilesPanel.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Your files — Alpha</title>
</svelte:head>

<!-- A sidebar destination inside the chat window: it fills the
     conversation column and scrolls there, instead of claiming the whole viewport. -->
<div class="flex h-full min-h-0 flex-col">
	<div class="mx-auto flex min-h-0 w-full max-w-thread flex-1 flex-col">
		<FilesPanel initialFiles={data.files} initialUnavailable={data.listUnavailable} initialBusy={data.listBusy} initialLocations={data.locations} chunkedUploads={data.chunkedUploads} />
	</div>
</div>
