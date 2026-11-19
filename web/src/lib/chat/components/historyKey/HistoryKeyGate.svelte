<!--
  @component
  Mounted once by ChatShell. The key flows carry age-encryption and its post-quantum code,
  about 44 KB that no visitor should load while the `history-key-enrollment` flag is off, so they are
  imported only once layout data says the flag is on here.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';

	const enabled = $derived(browser && page.data.historyKeyEnabled === true);
</script>

{#if enabled}
	{#await import('./HistoryKeyFlows.svelte') then { default: HistoryKeyFlows }}
		<HistoryKeyFlows />
	{:catch e}
		{console.error('[history-key] could not load the key flows', e)}
	{/await}
{/if}
