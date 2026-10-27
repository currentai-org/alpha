<script lang="ts">
	import { Attachment, Composer } from '@aipotluck/alpha-ds';
	import RiFilePdf2Line from '~icons/ri/file-pdf-2-line';

	// A photo, a PDF, a text file and a photo still being prepared, as they sit in the composer.
	let files = $state([
		{ id: 1, name: 'receipt.jpg', imageSrc: '/favicon.svg' },
		{ id: 2, name: 'tenancy-agreement-2026.pdf', kind: 'PDF', icon: RiFilePdf2Line },
		{ id: 3, name: 'meeting-notes.txt', kind: 'Text' }
	]);
	let draft = $state('What should I check before signing?');
</script>

<div class="w-full max-w-lg">
	<Composer.Root bind:value={draft}>
		<Attachment.Row aria-label="Attached files">
			{#each files as file (file.id)}
				<Attachment.Card
					name={file.name}
					kind={file.kind}
					icon={file.icon}
					imageSrc={file.imageSrc}
					onopen={() => {}}
					onremove={() => (files = files.filter((f) => f.id !== file.id))}
				/>
			{/each}
			<Attachment.Card
				name="IMG_2041.heic"
				imageSrc="/favicon.svg"
				busy
				busyLabel="Preparing photo"
			/>
		</Attachment.Row>
		<Composer.Input placeholder="Ask anything" />
		<Composer.Toolbar>
			<Composer.Send />
		</Composer.Toolbar>
	</Composer.Root>
</div>
