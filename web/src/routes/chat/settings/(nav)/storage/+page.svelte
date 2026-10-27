<script lang="ts">
	// Settings → Storage holds the storage settings (usage, locations, linking a bucket, where
	// files are kept). The files are on /chat/storage, the rail's Files page, which this page links to. (CUR-4363)
	import StorageSettingsPanel from '$lib/chat/components/storage/StorageSettingsPanel.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<StorageSettingsPanel
	initialFiles={data.files}
	initialUnavailable={data.listUnavailable}
	initialBusy={data.listBusy}
	initialLocations={data.locations}
/>
