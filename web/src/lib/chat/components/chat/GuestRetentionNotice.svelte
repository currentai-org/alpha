<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';
	import { Button, Popover, Sheet, useCompact } from '@aipotluck/alpha-ds';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { RETENTION_DAYS, SELF_HOST_URL, daysUntil } from '$lib/chat/constants/retention';
	import RiTimerLine from '~icons/ri/timer-line';

	// Guest retention, as a small badge beside the conversation title that opens a card with the
	// full sentence. History, still binding:
	//   -: not a warning (automatic deletion is the privacy-preserving default, not a fault),
	//     and no "sign in to keep it" nudge — offering an account turns a disclosure into an upsell.
	//   -: it must stay visible after the first message, when a guest first has something to
	//     lose — so it lives in the thread header rather than the empty state.
	// The card's main sentence is the reviewed `copy_guestRetentionNotice` message.
	//
	// With conversation expiry on, signed in or a guest, the same badge counts down to
	// `expiresAt`, the date the server computed for this chat, and the card points to the export (signed
	// in) and to running your own.

	let { expiresAt = null }: { expiresAt?: Date | null } = $props();
	const now = new Date();
	const daysLeft = $derived(expiresAt ? daysUntil(expiresAt, now) : null);
	const notice = $derived(
		expiresAt
			? m.chat_expiryNotice({ days: RETENTION_DAYS })
			: m.copy_guestRetentionNotice({ retentionDays: String(RETENTION_DAYS) })
	);
	const title = $derived(
		expiresAt
			? m.chat_expiryTitle({ date: new Date(expiresAt).toLocaleDateString(getLocale(), { day: 'numeric', month: 'long' }) })
			: m.chat_retentionTitle()
	);
	const about = $derived(expiresAt ? m.chat_expiryAbout() : m.chat_retentionAbout());
	const phone = useCompact();
	let open = $state(false);
</script>

{#snippet badge()}
	<RiTimerLine aria-hidden="true" class="text-fg-3" />
	<!-- Phones show only the count; the button's aria-label carries the full sentence. -->
	<span class="type-caption text-fg-3"
		>{daysLeft !== null
			? phone.current
				? m.chat_expiryBadgeShort({ days: daysLeft })
				: m.chat_expiryBadge({ days: daysLeft })
			: phone.current
				? m.chat_retentionBadgeShort({ days: RETENTION_DAYS })
				: m.chat_retentionBadge({ days: RETENTION_DAYS })}</span
	>
{/snippet}

{#snippet why()}
	{#if expiresAt}
		<p class="mt-2 type-caption text-fg-3">
			<!-- Export is an account's: a guest has nothing to export from. -->
			{#if page.data.user}
				<a href={`${base}/settings/account#your-data`} class="text-fg-2 underline underline-offset-2 hover:text-fg-1"
					>{m.chat_expiryExport()}</a
				>
				·
			{/if}
			<a href={SELF_HOST_URL} rel="noopener" target="_blank" class="text-fg-2 underline underline-offset-2 hover:text-fg-1"
				>{m.chat_expirySelfHost()}</a
			>
		</p>
	{:else}
	<p class="mt-2 type-caption text-fg-3">
		{m.chat_retentionWhy()}
		<a href={`${base}/settings/data`} class="text-fg-2 underline underline-offset-2 hover:text-fg-1"
			>{m.product_dataPrivacy()}</a
		>.
	</p>
	{/if}
{/snippet}

{#if notice && phone.current}
	<Button
		variant="ghost"
		size="xs"
		shape="field"
		casing="sentence"
		class="shrink-0"
		aria-label={about}
		data-guest-retention={expiresAt ? undefined : ''}
		data-conversation-expiry={expiresAt ? '' : undefined}
		onclick={() => (open = true)}
	>
		{@render badge()}
	</Button>
	<Sheet.Root bind:open>
		<Sheet.Portal>
			<Sheet.Backdrop />
			<Sheet.Popup>
				<Sheet.Header {title} />
				<Sheet.Body>
					<Sheet.Description>{notice}</Sheet.Description>
					{@render why()}
				</Sheet.Body>
			</Sheet.Popup>
		</Sheet.Portal>
	</Sheet.Root>
{:else if notice}
	<Popover.Root bind:open>
		<Popover.Trigger
			variant="ghost"
			size="xs"
			shape="field"
			casing="sentence"
			class="shrink-0"
			aria-label={about}
			data-guest-retention={expiresAt ? undefined : ''}
			data-conversation-expiry={expiresAt ? '' : undefined}
		>
			{@render badge()}
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Positioner side="bottom" align="start">
				<Popover.Popup size="md">
					<Popover.Title>{title}</Popover.Title>
					<Popover.Description>{notice}</Popover.Description>
					{@render why()}
				</Popover.Popup>
			</Popover.Positioner>
		</Popover.Portal>
	</Popover.Root>
{/if}
