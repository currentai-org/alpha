<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { Button, Dialog, Inline, Radio, RadioGroup } from '@aipotluck/alpha-ds';
	import { locationLabel, locationDetail, type LocationSummary } from './locationTypes';

	// Copy or move one file to another of the person's locations. Only places that answer
	// are offered; the one the file is in now is left out. (CUR-2931)
	interface Props {
		open?: boolean;
		name: string;
		fromLabel: string;
		destinations: LocationSummary[];
		busy?: boolean;
		error?: string;
		onTransfer: (to: string, mode: 'copy' | 'move') => void;
	}
	let { open = $bindable(false), name, fromLabel, destinations, busy = false, error, onTransfer }: Props = $props();

	let choice = $state('');
	$effect(() => {
		if (open && !destinations.some((l) => l.id === choice && l.status === 'ok')) {
			choice = destinations.find((l) => l.status === 'ok')?.id ?? '';
		}
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="transfer-dialog">
			<Dialog.Title>{m.storage_copyOrMove({ name })}</Dialog.Title>
			<div class="flex flex-col gap-4">
				<RadioGroup value={choice} onValueChange={(v) => (choice = v)} aria-label={m.storage_destination()} class="flex flex-col gap-2">
					{#each destinations as loc (loc.id)}
						<label class="flex cursor-pointer items-start gap-3">
							<Radio.Root value={loc.id} disabled={loc.status !== 'ok'} class="mt-0.5"><Radio.Indicator /></Radio.Root>
							<span class="flex flex-col gap-0.5">
								<span class="type-body text-fg-1">{locationLabel(loc)}</span>
								<span class="type-caption text-fg-3">{locationDetail(loc)}</span>
							</span>
						</label>
					{/each}
				</RadioGroup>
				<p class="m-0 type-caption text-fg-3">
					{m.storage_moveHelp({ from: fromLabel })}
				</p>
				{#if error}
					<p class="m-0 type-caption text-fg-1" role="alert">{error}</p>
				{/if}
				<Inline justify="end" gap="2">
					<Dialog.Close>{m.message_cancel()}</Dialog.Close>
					<Button variant="secondary" disabled={!choice || busy} onclick={() => onTransfer(choice, 'copy')}>{m.message_copy()}</Button>
					<Button variant="primary" disabled={!choice || busy} onclick={() => onTransfer(choice, 'move')}>{m.storage_move()}</Button>
				</Inline>
			</div>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
