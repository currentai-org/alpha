<script lang="ts">
	import RiGlobalLine from '~icons/ri/global-line';
	import AnswerNote from './AnswerNote.svelte';
	import { m } from '$lib/paraglide/messages.js';
	// A web search ran for this turn and finished, but nothing it found was worth citing, so the answer
	// above comes from the model alone. The sibling of SearchUnfinishedNotice, for a search that finished
	// with nothing rather than one that did not finish.
</script>

<AnswerNote icon={RiGlobalLine} title={m.message_searchEmptyTitle()}>
	<p>{m.message_searchEmptyBody()}</p>
</AnswerNote>
