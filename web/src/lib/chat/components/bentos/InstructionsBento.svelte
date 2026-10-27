<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { fade } from 'svelte/transition';
	import { BentoTile } from '@aipotluck/alpha-ds';
	import RiQuillPenLine from '~icons/ri/quill-pen-line';

	/**
	 * Custom instructions (Settings → Personalization in the app): choose an instruction and see how
	 * the same question gets answered differently. Replies are pre-written illustrations.
	 */
	const question = $derived(m.welcome_heatPumpQuestion());
	const presets = $derived([
		{ label: m.welcome_presetNoneLabel(), instruction: '', reply: m.welcome_presetNoneReply() },
		{
			label: m.welcome_presetShortLabel(),
			instruction: m.welcome_presetShortInstruction(),
			reply: m.welcome_presetShortReply()
		},
		{
			label: m.welcome_presetNewLabel(),
			instruction: m.welcome_presetNewInstruction(),
			reply: m.welcome_presetNewReply()
		},
		{
			label: m.welcome_presetTeacherLabel(),
			instruction: m.welcome_presetTeacherInstruction(),
			reply: m.welcome_presetTeacherReply()
		}
	]);
	let active = $state(0);
	let custom = $state<string | undefined>(undefined);
	const instruction = $derived(custom ?? presets[active].instruction);
</script>

<BentoTile
	icon={RiQuillPenLine}
	title={m.welcome_instructionsTitle()}
	body={m.welcome_instructionsBody()}
>
	<div class="flex w-full max-w-sm flex-col gap-3">
		<div class="flex flex-wrap gap-1.5" role="group" aria-label={m.welcome_exampleInstructions()}>
			{#each presets as p, i (i)}
				<button
					type="button"
					aria-pressed={active === i && custom === undefined}
					class="rounded-pill border px-2.5 py-1 type-caption transition-control {active ===
						i && custom === undefined
						? 'border-accent-1 bg-surface-raised text-fg-1'
						: 'border-line-2 bg-surface-1 text-fg-2 hover:border-line-3 hover:text-fg-1'}"
					onclick={() => ((active = i), (custom = undefined))}>{p.label}</button
				>
			{/each}
		</div>
		<label class="flex flex-col gap-1 rounded-field border border-line-2 bg-surface-1 p-3">
			<span class="type-caption text-fg-3">{m.welcome_alphaInstructions()}</span>
			<textarea
				rows="2"
				value={instruction}
				oninput={(e) => (custom = e.currentTarget.value)}
				placeholder={m.welcome_instructionsPlaceholder()}
				class="w-full resize-none bg-transparent type-caption text-fg-1 outline-none placeholder:text-fg-3"
			></textarea>
		</label>
		<div
			class="flex flex-col gap-2 rounded-card bg-surface-raised p-3 shadow-popover"
		>
			<span class="self-end rounded-sharp bg-surface-3 px-3 py-1.5 type-caption text-fg-1"
				>{question}</span
			>
			{#key active}
				<p in:fade={{ duration: 180 }} class="type-caption text-fg-2" aria-live="polite">
					{presets[active].reply}
				</p>
			{/key}
		</div>
	</div>
</BentoTile>
