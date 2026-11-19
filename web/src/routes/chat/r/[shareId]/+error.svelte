<script lang="ts">
	// The screen for a share link that doesn't open: deleted chat, withdrawn link, or links
	// switched off. One screen for all three, so it never says whether the id ever existed.
	import { base } from '$lib/chat/paths';
	import { m } from '$lib/paraglide/messages.js';
	import { Button, Stack, Surface } from '@aipotluck/alpha-ds';
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<Surface level="1" class="flex flex-1 items-center justify-center p-4">
	<Surface
		level="2"
		border="auto"
		data-testid="shared-chat-unavailable"
		class="flex max-w-md flex-col items-center px-8 py-6 text-center"
	>
		<Stack gap="4" class="items-center">
			<h1 class="type-heading text-fg-1">{m.share_notFoundTitle()}</h1>
			<p class="type-body text-fg-2">{m.share_notFoundBody()}</p>
			<Button variant="primary" size="lg" casing="sentence" href="{base}/">
				{m.share_notFoundAction()}
			</Button>
		</Stack>
	</Surface>
</Surface>
