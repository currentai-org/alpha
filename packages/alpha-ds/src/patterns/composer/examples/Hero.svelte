<script lang="ts">
	import { Button, Composer } from '@aipotluck/alpha-ds';
	import RiAddLine from '~icons/ri/add-line';
	import RiGlobalLine from '~icons/ri/global-line';
	let value = $state('');
	let search = $state(true);
	let sent = $state('');
</script>

<div class="max-w-thread">
	<Composer.Root bind:value onsubmit={(v) => ((sent = v), (value = ''))}>
		<Composer.Input placeholder="Ask anything" />
		<Composer.Toolbar>
			<Composer.Tools>
				<Button variant="ghost" size="icon-sm" aria-label="Attach"><RiAddLine /></Button>
				{#if search}
					<Composer.Chip
						icon={RiGlobalLine}
						dismissLabel="Turn off web search"
						ondismiss={() => (search = false)}
					>
						Web search
					</Composer.Chip>
				{/if}
			</Composer.Tools>
			<Composer.Send />
		</Composer.Toolbar>
	</Composer.Root>
	{#if sent}<p class="mt-2 type-caption text-fg-3">Sent: {sent}</p>{/if}
</div>
