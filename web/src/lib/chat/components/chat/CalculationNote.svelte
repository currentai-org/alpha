<script lang="ts">
	// The expressions the model sent to the `calculate` tool and what code got for each. Shown
	// so the reader can check the setup behind a number, which is where the errors are: a right sum of
	// a wrong setup is easy to stamp "checked" (CUR-2256). So this names what ran and says
	// nothing about correctness: never "checked", never "verified".
	// (CUR-2273)
	// A bare monospace "calculate …" line under the prose reads as debug output, so the
	// working carries a caption in plain words saying what it is and what to do with it. (CUR-2417)
	import type { Message } from '$lib/chat/types/Message';

	interface Props {
		calculations: NonNullable<Message['calculations']>;
	}
	let { calculations }: Props = $props();

	// A call the tool refused is not the working behind the answer once a later call worked, and
	// "could not be worked out" next to a stated result reads as the result being unchecked. Refused calls
	// stay when nothing evaluated, so a turn that never got a number still says so. (CUR-3860)
	let shown = $derived(
		calculations.some((c) => c.result !== undefined)
			? calculations.filter((c) => c.result !== undefined)
			: calculations
	);
	// With every call refused, the answer did not come from the calculator, and a caption saying it
	// was worked out with one would claim otherwise. (CUR-3860)
	let evaluated = $derived(shown.some((c) => c.result !== undefined));
</script>

<div data-testid="calculations" class="mt-2 flex flex-col gap-0.5">
	<p class="type-caption text-fg-3">
		{#if !evaluated}
			The calculator could not read this, so the answer above did not come from it.
		{:else}
			{shown.length === 1 ? 'Worked out with a calculator' : 'Worked out with a calculator, step by step'}.
			Check that the sum matches your question.
		{/if}
	</p>
	{#each shown as c, i (i)}
		<p data-testid="calculation" class="type-code wrap-break-word text-fg-2">
			<span>{c.expression || '(empty)'}</span>
			{#if c.result !== undefined}
				<span> = {c.result}</span>
			{:else}
				<span class="text-fg-3"> · could not be worked out</span>
			{/if}
		</p>
	{/each}
</div>
