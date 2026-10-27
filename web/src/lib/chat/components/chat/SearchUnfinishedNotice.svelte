<script lang="ts">
	import RiGlobalLine from '~icons/ri/global-line';
	import AnswerNote from './AnswerNote.svelte';
	import { m } from '$lib/paraglide/messages.js';
	// A web search ran for this turn and didn't finish (it passed its deadline or failed), so
	// the answer above was written without web sources. Without this the answer read like any other, and
	// X-ray said Alpha had decided no search was needed. (CUR-4091)
</script>

<AnswerNote icon={RiGlobalLine} title={m.message_searchUnfinishedTitle()}>
	<p>{m.message_searchUnfinishedBody()}</p>
</AnswerNote>
