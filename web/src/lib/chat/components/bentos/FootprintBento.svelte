<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import {
		estimateEnergyWh,
		formatEnergyShort,
		formatElapsedShort,
	} from '$lib/chat/utils/energyEstimate';
	import { localizedAnchor, localizedComparison } from '$lib/chat/utils/energyCopy';
	import { BentoTile } from '@aipotluck/alpha-ds';
	import RiLeafLine from '~icons/ri/leaf-line';
	import RiFlashlightLine from '~icons/ri/flashlight-line';
	import RiTimeLine from '~icons/ri/time-line';

	/**
	 * Power & time: drag through a session and see the same energy estimate and "time here" figures
	 * the app shows in its header (energyEstimate.ts — the real formula, not a mock-up).
	 */
	const TOKENS_PER_ANSWER = 350; // a typical Alpha reply
	const MINUTES_PER_ANSWER = 1.5;

	let answers = $state(12);
	const wh = $derived(estimateEnergyWh(answers * TOKENS_PER_ANSWER));
	const anchor = $derived(localizedAnchor(wh));
	const share = $derived(Math.min(1, wh / anchor.wh));
	const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
</script>

<BentoTile
	icon={RiLeafLine}
	title={m.welcome_energyTitle()}
	body={m.welcome_energyBody()}
>
	<div
		class="w-full max-w-sm rounded-card bg-surface-raised p-4 shadow-popover"
	>
		<div class="grid grid-cols-2 gap-2">
			<div class="flex flex-col gap-0.5 rounded-card border border-line-2 p-3">
				<span class="flex items-center gap-1.5 type-caption text-fg-2"
					><RiFlashlightLine aria-hidden="true" class="size-3.5 text-accent-1" /> {m.welcome_energy()}</span
				>
				<span class="type-title text-fg-1 tabular-nums">{formatEnergyShort(wh)}</span>
			</div>
			<div class="flex flex-col gap-0.5 rounded-card border border-line-2 p-3">
				<span class="flex items-center gap-1.5 type-caption text-fg-2"
					><RiTimeLine aria-hidden="true" class="size-3.5 text-accent-1" /> {m.welcome_time()}</span
				>
				<span class="type-title text-fg-1 tabular-nums"
					>{formatElapsedShort(answers * MINUTES_PER_ANSWER * 60_000)}</span
				>
			</div>
		</div>
		<div class="mt-4 h-2 w-full rounded-pill bg-tint-hover" aria-hidden="true">
			<span
				class="block h-full bar-width rounded-pill bg-accent-1 transition-control"
				style:--bar-width="{Math.max(2, share * 100)}%"
			></span>
		</div>
		<!-- Two fixed lines (each truncates) so dragging never changes the card's height. -->
		<p class="mt-2 flex flex-col type-caption text-fg-3 tabular-nums" aria-live="polite">
			<span class="truncate">{m.welcome_shareOf({ percent: Math.round(share * 100), anchor: anchor.label })}</span>
			<span class="truncate">{capitalize(localizedComparison(wh))}</span>
		</p>
		<label class="mt-4 flex flex-col gap-1.5">
			<span class="flex justify-between type-caption text-fg-2">
				<span>{m.welcome_answersThisSession()}</span><span class="text-fg-1 tabular-nums">{answers}</span>
			</span>
			<input
				type="range"
				min="1"
				max="60"
				bind:value={answers}
				class="w-full accent-accent-1"
			/>
		</label>
	</div>
</BentoTile>
