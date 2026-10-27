<script lang="ts">
	import RiChatHistoryLine from '~icons/ri/chat-history-line';
	import AnswerNote from './AnswerNote.svelte';
	// The chat was longer than the model reads at once, so the oldest exchanges were left out
	// of this turn. The answer above is real and read the most recent part of the chat. (CUR-2893)
</script>

<AnswerNote icon={RiChatHistoryLine} title="Older messages were left out">
	<p>
		This chat is longer than the model can read at once, so the answer above only saw the most
		recent messages.
	</p>
</AnswerNote>
