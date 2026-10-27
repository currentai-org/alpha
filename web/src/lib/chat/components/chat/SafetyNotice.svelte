<script lang="ts">
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import AnswerNote from './AnswerNote.svelte';
	// Non-blocking safety advisory (Coop "notice" tier) — shown when the pre-screen flagged a turn for a
	// category that warrants an honest user-facing notice but NOT a decline. The answer above is a REAL
	// model answer (unlike a safety decline, which replaces it); this chip just rides alongside it,
	// stating plainly why the turn was noticed. Mirrors NameNotice (same non-blocking chip pattern), but
	// uses the "building"/amber accent rather than gap-red — a notice is advisory, not a refusal.
	//
	// `message` is OUR reviewed user-facing copy (see checkAdvisory's contract — pending review). It is
	// rendered as plain text (Svelte auto-escapes interpolation), never {@html}, so an upstream classifier
	// can never inject markup. Inert today: no SafetyNotice is ever emitted until Coop is wired.
	//
	// The raw Coop action/category code is deliberately NOT rendered here (not even in the tooltip): like
	// the block path, a raw action code must never reach the user. The reviewed `message` already states
	// why the turn was noticed; a curated label would be resolved server-side if one is ever wanted.
	interface Props {
		message: string;
	}
	let { message }: Props = $props();
</script>

<AnswerNote icon={RiShieldCheckLine} title={message}>
	<p>
		An open safety checker flagged this conversation for a heads-up. The answer above is real — this is a note, not a
		refusal.
	</p>
</AnswerNote>
