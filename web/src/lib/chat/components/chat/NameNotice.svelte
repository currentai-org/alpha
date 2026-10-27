<script lang="ts">
	import RiRobot2Line from '~icons/ri/robot-2-line';
	import AnswerNote from './AnswerNote.svelte';
	// Honest correction shown when the post-generation guard ($lib/chat/server/nameGuard) caught the model
	// adopting a personal name for itself this turn. Prompt rules don't reliably stop the slip, so the
	// constraint is enforced at runtime: the answer stays as-is, but this chip states plainly that the
	// system has no name — and the server strips the name from later context so it can't compound.
	interface Props {
		/** the adopted nickname, when known (kept for the tooltip; the visible copy stays generic) */
		name?: string;
	}
	let { name }: Props = $props();
</script>

<AnswerNote icon={RiRobot2Line} title="Alpha won’t pretend to be a person">
	<p>
		{#if name}The answer above started calling itself “{name}”.{:else}The answer above started using a personal name.{/if}
		Alpha is a machine, not a person, so it has no personal name — we note it here rather than let it pass, and later replies
		won’t carry it forward.
	</p>
</AnswerNote>
