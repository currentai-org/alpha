<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import PotluckMark from '../PotluckMark.svelte';

	/** "Stored by Current AI / in Alpha's own database", with the Potluck mark: where chats live (DATA_HOME). */
</script>

<div class="flex items-center gap-2.5">
	<span class="grid size-8 shrink-0 place-items-center rounded-sharp border border-line-2 bg-surface-1">
		<PotluckMark class="size-4" />
	</span>
	<span class="flex flex-col">
		<span class="type-body text-fg-1">{m.message_dataHomeLead()}</span>
		<span class="type-caption text-fg-3">{m.message_dataHomeWhere()}</span>
	</span>
</div>
