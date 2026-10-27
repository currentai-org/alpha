<script lang="ts">
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';
	import ErrorCard from '$lib/components/error-card/error-card.svelte';
</script>

<ErrorCard />
{#if page.status === 404}
	<!-- CUR-681: a short, crawlable recovery path — not just a status code — so an agent
	     that landed on a dead link can find its way back rather than dead-ending here. -->
	<div class="flex items-center justify-center bg-surface-1 pb-4">
		<p class="max-w-sm pb-2 text-center type-caption text-fg-2">
			Try <a class="underline" href="{base}/">the chat home</a>
			or read
			<a class="underline" href="/llms.txt">llms.txt</a>
			for a machine-readable description of this app.
		</p>
	</div>
{/if}
