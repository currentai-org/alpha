<script lang="ts">
	import { Button } from "@aipotluck/alpha-ds";

	/** Shown in place of a preview frame that navigated away from its own document (CUR-3527). */
	let { onrun }: { onrun: () => void } = $props();
</script>

<div class="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-small text-fg-2">
	<p>This preview tried to open another page, so it was closed.</p>
	<Button variant="secondary" size="sm" casing="sentence" onclick={onrun}>Run it again</Button>
</div>
