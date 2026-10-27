<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { Button, Dialog, Inline, Radio, RadioGroup } from '@aipotluck/alpha-ds';
	import { locationLabel, locationDetail, type LocationSummary } from './locationTypes';

	// "Ask every time". Shown before an upload when the default is to ask. (CUR-2930)
	interface Props {
		open?: boolean;
		locations: LocationSummary[];
		count: number;
		onChoose: (locationId: string) => void;
	}
	let { open = $bindable(false), locations, count, onChoose }: Props = $props();

	let choice = $state('');
	$effect(() => {
		// Re-seed whenever the last choice is no longer a place that answers (unlinked, or needs reconnecting).
		if (open && !locations.some((l) => l.id === choice && l.status === 'ok')) {
			choice = locations.find((l) => l.status === 'ok')?.id ?? '';
		}
	});

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!choice) return;
		onChoose(choice);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="choose-location-dialog">
			<Dialog.Title>{count === 1 ? m.storage_whereThisFile() : m.storage_whereTheseFiles()}</Dialog.Title>
			<form onsubmit={submit} class="flex flex-col gap-4">
				<RadioGroup value={choice} onValueChange={(v) => (choice = v)} aria-label={m.storage_locationShort()} class="flex flex-col gap-2">
					{#each locations as loc (loc.id)}
						<label class="flex cursor-pointer items-start gap-3">
							<Radio.Root value={loc.id} disabled={loc.status !== 'ok'} class="mt-0.5"><Radio.Indicator /></Radio.Root>
							<span class="flex flex-col gap-0.5">
								<span class="type-body text-fg-1">{locationLabel(loc)}</span>
								<span class="type-caption text-fg-3">{locationDetail(loc)}</span>
							</span>
						</label>
					{/each}
				</RadioGroup>
				<Inline justify="end" gap="2">
					<Dialog.Close>{m.message_cancel()}</Dialog.Close>
					<Button type="submit" variant="primary" disabled={!choice}>{m.storage_add()}</Button>
				</Inline>
			</form>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
