<script lang="ts">
	import { Button, Ticker } from '@aipotluck/alpha-ds';

	let play = $state(false);
</script>

<div class="flex w-64 flex-col gap-3">
	<span class="min-w-0 type-body text-fg-2">
		<Ticker {play}
			>Files you upload are stored with Hugging Face, in storage held by Current AI.</Ticker
		>
	</span>
	<Button onclick={() => (play = !play)}>{play ? 'Stop' : 'Play'}</Button>
</div>
