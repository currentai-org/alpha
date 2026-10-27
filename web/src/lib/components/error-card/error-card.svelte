<!--
  @component
  The chat's error page card: the status, the message, and the error id when there is one. Built on
  Alpha's surface and text tokens, so it reads in both themes (CUR-3409).
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Separator, Surface } from '@aipotluck/alpha-ds';
</script>

<Surface level="1" class="flex flex-1 items-center justify-center p-4">
	<Surface
		level="2"
		border="auto"
		data-testid="chat-error-card"
		class="flex max-w-sm flex-col items-center gap-3 px-8 py-5 text-center"
	>
		<h1 class="type-display text-fg-1">{page.status}</h1>
		<Separator />
		<h2 class="type-body text-fg-1">{page.error?.message}</h2>
		{#if page.error?.errorId}
			<Separator />
			<pre class="text-left type-code whitespace-pre-wrap text-fg-2">{page.error.errorId}</pre>
		{/if}
	</Surface>
</Surface>
