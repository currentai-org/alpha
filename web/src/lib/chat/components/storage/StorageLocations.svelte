<script lang="ts">
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { Badge, Button, Collapsible, Field, Inline, Radio, RadioGroup, Stack, Surface } from '@aipotluck/alpha-ds';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import { base } from '$lib/chat/paths';
	import { sendStorageJson } from './storageRequest';
	import { orgs } from '$lib/chat/routing/catalog';
	import OrgMention from '../provenance/OrgMention.svelte';
	import HfAccessNote from './HfAccessNote.svelte';
	import LinkBucketForm from './LinkBucketForm.svelte';
	import NewLocationOffer from './NewLocationOffer.svelte';
	import { ASK_EVERY_TIME, LAST_USED, type LocationsState, locationLabel, locationDetail } from './locationTypes';

	// The places this account's files can live, and where new ones go by default — the
	// browser's download-folder setting. The design (CUR-415) gives linking your own Hugging Face
	// storage its own copy. (CUR-2930)
	// With one place there is nothing to choose, so it is a plain line. With two or more,
	// each place, then "Last used" (where an account starts) and "Ask every time". (CUR-3077)
	// Rendered on Settings → Storage as two headed sections, Locations and Link your own
	// Hugging Face bucket, with linking in plain view rather than behind the Advanced disclosure. (CUR-4363)
	interface Props {
		locations: LocationsState;
		onChanged: () => void;
		/** Each place's file count, where known; a place with none shows no count. */
		counts?: Record<string, number>;
	}
	let { locations: locState, onChanged, counts = {} }: Props = $props();

	// A bucket name that came back refused (CUR-4234) refills the field.
	const retryBucket = ['name', 'taken'].includes(page.url.searchParams.get('connect_error') ?? '')
		? (page.url.searchParams.get('bucket') ?? '')
		: '';
	let confirmUnlink = $state<string | null>(null);
	let connectHowOpen = $state(false);
	let tokenHowOpen = $state(false);
	let error = $state<string | undefined>(undefined);

	const linked = $derived(locState.locations.filter((l) => l.kind !== 'alpha'));
	const lastUsedLabel = $derived.by(() => {
		const loc = locState.locations.find((l) => l.id === locState.lastUsed);
		return loc ? locationLabel(loc) : m.storage_alphaLabel();
	});

	// The connect callback lands back here with `connected` or `connect_error`.
	// Functions, so the copy follows a language switch. (CUR-2932)
	// `name` and `taken` come back with the name the person typed, which refills the field. (CUR-4234)
	const connectBucket = page.url.searchParams.get('bucket') ?? '';
	const CONNECT_MESSAGES: Record<string, () => string> = {
		name: () => m.storage_connectName({ bucket: connectBucket }),
		taken: () => m.storage_connectTaken({ bucket: connectBucket }),
		denied: () => m.storage_connectDenied(),
		scope: () => m.storage_connectScope(),
		state: () => m.storage_connectState(),
		limit: () => m.storage_connectLimit(),
		failed: () => m.storage_connectFailed(),
	};
	const connectOutcome = $derived.by(() => {
		const params = page.url.searchParams;
		const connected = params.get('connected');
		// Connecting again to a bucket that is already linked refreshes it and adds nothing. (CUR-3326)
		if (connected === 'refreshed')
			return {
				ok: true,
				text: m.storage_connectRefreshed({ bucket: params.get('bucket') || m.storage_thatBucket() }),
			};
		if (connected)
			return {
				ok: true,
				text: params.get('location') ? m.storage_connected() : m.storage_connectedPick(),
			};
		const code = params.get('connect_error');
		return code ? { ok: false, text: (CONNECT_MESSAGES[code] ?? CONNECT_MESSAGES.failed)() } : null;
	});
	const connectHref = `${base}/api/storage/locations/hf/connect`;

	// The place just linked or connected, while its offer (save there, move my files) is up. (CUR-2941)
	let offerFor = $state<string | null>(
		page.url.searchParams.get('connected') === '1' ? page.url.searchParams.get('location') : null,
	);
	const offerLocation = $derived(
		offerFor ? locState.locations.find((l) => l.id === offerFor && l.kind !== 'alpha') : undefined,
	);

	// The callback returns to the top of a page whose file list can push this card below the fold, so
	// the outcome would go unseen. Bring it into view once, when the page lands with one.
	let outcomeEl = $state<HTMLParagraphElement | undefined>(undefined);
	$effect(() => {
		if (outcomeEl) outcomeEl.scrollIntoView({ block: 'center' });
	});

	async function setDefault(value: string) {
		error = undefined;
		const reply = await sendStorageJson('locations/default', 'PUT', { location: value });
		if (!reply?.ok) error = m.storage_saveChoiceFailed();
		onChanged();
	}

	async function unlink(id: string) {
		error = undefined;
		const res = await fetch(`${base}/api/storage/locations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
			() => null,
		);
		confirmUnlink = null;
		if (!res?.ok) error = m.storage_unlinkFailed();
		onChanged();
	}
</script>

{#snippet fileCount(id: string)}
	{#if counts[id] !== undefined}
		<span class="type-caption text-fg-2" data-testid="location-file-count"
			>{counts[id] === 1 ? m.account_oneFile() : m.account_nFiles({ count: counts[id] })}</span
		>
	{/if}
{/snippet}

<section class="flex flex-col gap-3" aria-labelledby="storage-locations-heading" data-testid="storage-locations">
	<h2 id="storage-locations-heading" class="m-0 type-label text-fg-1">{m.storage_locationsTitle()}</h2>
	{#if connectOutcome}
		<p
			bind:this={outcomeEl}
			class="m-0 text-small text-fg-1"
			role={connectOutcome.ok ? 'status' : 'alert'}
			data-testid="storage-connect-outcome"
		>
			{connectOutcome.text}
		</p>
	{/if}
	{#if offerLocation}
		<NewLocationOffer location={offerLocation} {onChanged} onClose={() => (offerFor = null)} />
	{/if}
	<span class="block font-mono text-micro tracking-wide text-fg-3 uppercase">{m.storage_newFilesGoTo()}</span>
	{#if linked.length === 0}
		{#each locState.locations as loc (loc.id)}
			<div
				class="flex flex-col gap-0.5 rounded-sharp border border-line-2 bg-surface-raised p-3"
				data-testid="storage-location"
				data-location-id={loc.id}
			>
				<span class="type-body text-fg-1">{locationLabel(loc)}</span>
				<span class="truncate type-caption text-fg-3">{locationDetail(loc)}</span>
				{@render fileCount(loc.id)}
			</div>
		{/each}
	{:else}
		<RadioGroup
			value={locState.defaultLocation}
			onValueChange={(v) => setDefault(v)}
			aria-label={m.storage_whereNewFiles()}
			class="flex flex-col gap-2"
		>
			{#each locState.locations as loc (loc.id)}
				<div
					class="flex items-start gap-3 rounded-sharp border border-line-2 bg-surface-raised p-3"
					data-testid="storage-location"
					data-location-id={loc.id}
				>
					<label class="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
						<Radio.Root value={loc.id} class="mt-0.5"><Radio.Indicator /></Radio.Root>
						<span class="flex min-w-0 flex-col gap-0.5">
							<span class="type-body text-fg-1">{locationLabel(loc)}</span>
							<span class="truncate type-caption text-fg-3">{locationDetail(loc)}</span>
							{@render fileCount(loc.id)}
							{#if loc.status === 'needs-reconnect'}
								<span class="flex flex-wrap items-center gap-2 pt-1">
									<Badge>{m.storage_needsReconnecting()}</Badge>
									{#if loc.lastError}<span class="type-caption text-fg-2">{loc.lastError}</span>{/if}
									{#if loc.grant === 'oauth' && locState.connectAvailable}
										<Button size="xs" href={connectHref} data-sveltekit-reload>{m.storage_reconnect()}</Button>
									{/if}
								</span>
							{/if}
						</span>
					</label>
					{#if loc.kind !== 'alpha'}
						{#if confirmUnlink === loc.id}
							<span class="flex shrink-0 gap-1">
								<Button size="xs" variant="ghost" onclick={() => (confirmUnlink = null)}>{m.storage_keep()}</Button>
								<Button size="xs" variant="destructive" onclick={() => unlink(loc.id)}>{m.account_unlink()}</Button>
							</span>
						{:else}
							<Button
								size="xs"
								variant="ghost"
								onclick={() => (confirmUnlink = loc.id)}
								aria-label={m.account_unlinkProvider({ provider: locationLabel(loc) })}>{m.account_unlink()}</Button
							>
						{/if}
					{/if}
				</div>
			{/each}
			<label
				class="flex cursor-pointer items-start gap-3 rounded-sharp border border-line-2 bg-surface-raised p-3"
				data-testid="storage-last-used"
			>
				<Radio.Root value={LAST_USED} class="mt-0.5"><Radio.Indicator /></Radio.Root>
				<span class="flex flex-col gap-0.5">
					<span class="type-body text-fg-1">{m.storage_lastUsed()}</span>
					<span class="type-caption text-fg-3">{m.storage_lastUsedHelp({ place: lastUsedLabel })}</span>
				</span>
			</label>
			<label class="flex cursor-pointer items-start gap-3 rounded-sharp border border-line-2 bg-surface-raised p-3">
				<Radio.Root value={ASK_EVERY_TIME} class="mt-0.5"><Radio.Indicator /></Radio.Root>
				<span class="flex flex-col gap-0.5">
					<span class="type-body text-fg-1">{m.storage_askEveryTime()}</span>
					<span class="type-caption text-fg-3">{m.storage_askEveryTimeHelp()}</span>
				</span>
			</label>
		</RadioGroup>
	{/if}
	{#if linked.length > 0}
		<p class="m-0 type-caption text-fg-3" data-testid="storage-unlink-note">
			{m.storage_unlinkHelp()}
			{#if confirmUnlink}
				<HfAccessNote grants={linked.filter((l) => l.id === confirmUnlink).map((l) => l.grant)} />
			{/if}
		</p>
	{/if}
	{#if error}
		<p class="m-0 text-small text-fg-1" role="alert">{error}</p>
	{/if}
</section>

<section class="flex flex-col gap-3" aria-labelledby="storage-link-heading" data-testid="storage-link-section">
	<h2 id="storage-link-heading" class="m-0 type-label text-fg-1">{m.storage_linkOwnTitle()}</h2>
	<p class="m-0 type-body text-fg-2">
		{#each m.storage_ownStorageHelp({ org: "{org}" }).split(/(\{org\})/).filter(Boolean) as part, i (i)}{#if part === "{org}"}<OrgMention org={orgs.huggingface} />{:else}{part}{/if}{/each}
	</p>
	<!-- CUR-4659: two choices, each in its own card with a title, one line saying what it does, short
	     field help, and the approval and token detail behind a disclosure. The recommended one, where
	     Alpha makes the bucket, comes first. -->
	{#if locState.connectAvailable}
		<Surface level="2" border="auto" padding="md" data-testid="storage-connect-choice">
			<Stack gap="3">
				<Stack gap="1">
					<Inline gap="2" align="center">
						<h3 class="m-0 type-body font-medium text-fg-1">{m.storage_connectNewTitle()}</h3>
						<Badge tone="accent">{m.storage_recommended()}</Badge>
					</Inline>
					<p class="m-0 type-caption text-fg-2">{m.storage_connectNewHelp()}</p>
				</Stack>
				<!-- A plain GET form, so the browser leaves for Hugging Face's consent with the name in the query. -->
				<form
					method="GET"
					action={connectHref}
					data-sveltekit-reload
					class="flex flex-col items-start gap-3"
					data-testid="storage-connect"
				>
					<Field.Root>
						<Field.Label>{m.storage_bucketName()}</Field.Label>
						<Field.Control name="bucket" placeholder="alpha-files" autocomplete="off" value={retryBucket} />
						<Field.Description>{m.storage_bucketNameHelp()}</Field.Description>
					</Field.Root>
					<Button type="submit" variant="primary">{m.storage_connectHf()}</Button>
				</form>
				<Collapsible.Root bind:open={connectHowOpen}>
					<Collapsible.Trigger size="xs" class="-ml-2">
						<RiArrowRightSLine class={connectHowOpen ? 'rotate-90' : ''} aria-hidden="true" />
						{m.storage_connectHow()}
					</Collapsible.Trigger>
					<Collapsible.Panel>
						<Stack gap="2" class="pt-1" data-testid="storage-connect-how">
							<p class="m-0 type-caption text-fg-2">{m.storage_connectHfHelp()}</p>
							<p class="m-0 type-caption text-fg-2">{m.storage_connectSecond()}</p>
						</Stack>
					</Collapsible.Panel>
				</Collapsible.Root>
			</Stack>
		</Surface>
	{/if}
	<Surface level="2" border="auto" padding="md" data-testid="storage-link-existing-choice">
		<Stack gap="3">
			<Stack gap="1">
				<h3 class="m-0 type-body font-medium text-fg-1">{m.storage_orLinkExisting()}</h3>
				<p class="m-0 type-caption text-fg-2">{m.storage_linkReach()}</p>
			</Stack>
			<LinkBucketForm
				onLinked={(id) => {
					offerFor = id ?? null;
					onChanged();
				}}
			/>
			<Collapsible.Root bind:open={tokenHowOpen}>
				<Collapsible.Trigger size="xs" class="-ml-2">
					<RiArrowRightSLine class={tokenHowOpen ? 'rotate-90' : ''} aria-hidden="true" />
					{m.storage_tokenHow()}
				</Collapsible.Trigger>
				<Collapsible.Panel>
					<p class="m-0 pt-1 type-caption text-fg-2" data-testid="storage-token-how">{m.storage_tokenStored()}</p>
				</Collapsible.Panel>
			</Collapsible.Root>
		</Stack>
	</Surface>
</section>
