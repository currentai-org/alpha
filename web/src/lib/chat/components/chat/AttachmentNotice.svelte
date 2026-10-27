<script lang="ts">
	import RiAttachment2 from '~icons/ri/attachment-2';
	import AnswerNote from './AnswerNote.svelte';
	// The files sent with this turn were refused because they could not be checked against
	// the known-CSAM hash bank, so none was stored. The answer above is real and read only the text.
	// `message` is our own fixed copy (csamScan.ts's UPLOAD_NOT_SCANNED_MESSAGE), rendered as text. (CUR-2382)
	// A stored file the turn could not read back passes `detail={null}`. Its title already
	// says whether sending again helps, and the line above would be false for it. (CUR-3291)
	interface Props {
		message: string;
		detail?: string | null;
	}
	let { message, detail }: Props = $props();
</script>

{#if detail === null}
	<AnswerNote icon={RiAttachment2} title={message} />
{:else}
	<AnswerNote icon={RiAttachment2} title={message}>
		<p>{detail ?? 'The answer above only read what you typed. Your files weren’t saved anywhere.'}</p>
	</AnswerNote>
{/if}
