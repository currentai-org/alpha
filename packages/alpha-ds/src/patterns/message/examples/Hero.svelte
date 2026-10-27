<script lang="ts">
	import { Badge, Button, Message, Stack } from '@aipotluck/alpha-ds';
	import RiFileCopyLine from '~icons/ri/file-copy-line';
	import RiRefreshLine from '~icons/ri/refresh-line';
</script>

<Stack gap="6" class="max-w-thread">
	<Message.Root from="user">
		<Message.Content>Which open speech models support Swahili?</Message.Content>
	</Message.Root>
	<Message.Root from="assistant">
		<Message.Content>
			<p>
				Three are in the catalog today: <strong>MMS</strong>, <strong>Whisper large-v3</strong> and
				<strong>SeamlessM4T</strong>. MMS covers the most languages but has the weakest Swahili WER.
			</p>
		</Message.Content>
		<Message.Meta><Badge>Apertus 70B</Badge> Served in Switzerland · 2.1s</Message.Meta>
		<Message.Actions>
			<Button variant="ghost" size="icon-sm" aria-label="Copy"><RiFileCopyLine /></Button>
			<Button variant="ghost" size="icon-sm" aria-label="Retry"><RiRefreshLine /></Button>
		</Message.Actions>
	</Message.Root>
</Stack>
