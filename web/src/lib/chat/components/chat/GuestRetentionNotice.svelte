<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { base } from '$lib/chat/paths';
	import { Button, Popover, Sheet, useCompact } from '@aipotluck/alpha-ds';
	import { RETENTION_DAYS } from '$lib/chat/constants/retention';
	import RiTimerLine from '~icons/ri/timer-line';

	// Guest retention, as a small badge beside the conversation title that opens a card with the
	// full sentence. History, still binding:
	//   - CUR-1429: not a warning (automatic deletion is the privacy-preserving default, not a fault),
	//     and no "sign in to keep it" nudge — offering an account turns a disclosure into an upsell.
	//   - CUR-643: it must stay visible after the first message, when a guest first has something to
	//     lose — so it lives in the thread header rather than the empty state.
	// The card's main sentence is the reviewed `copy_guestRetentionNotice` message.

	const notice = $derived(m.copy_guestRetentionNotice({ retentionDays: String(RETENTION_DAYS) }));
	const phone = useCompact();
	let open = $state(false);
</script>

{#snippet badge()}
	<RiTimerLine aria-hidden="true" class="text-fg-3" />
	<!-- Phones show only the count; the button's aria-label carries the full sentence. -->
	<span class="type-caption text-fg-3"
		>{phone.current
			? m.chat_retentionBadgeShort({ days: RETENTION_DAYS })
			: m.chat_retentionBadge({ days: RETENTION_DAYS })}</span
	>
{/snippet}

{#snippet why()}
	<p class="mt-2 type-caption text-fg-3">
		{m.chat_retentionWhy()}
		<a href={`${base}/settings/data`} class="text-fg-2 underline underline-offset-2 hover:text-fg-1"
			>{m.product_dataPrivacy()}</a
		>.
	</p>
{/snippet}

{#if notice && phone.current}
	<Button
		variant="ghost"
		size="xs"
		shape="field"
		casing="sentence"
		class="shrink-0"
		aria-label={m.chat_retentionAbout()}
		data-guest-retention
		onclick={() => (open = true)}
	>
		{@render badge()}
	</Button>
	<Sheet.Root bind:open>
		<Sheet.Portal>
			<Sheet.Backdrop />
			<Sheet.Popup>
				<Sheet.Header title={m.chat_retentionTitle()} />
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
			aria-label={m.chat_retentionAbout()}
			data-guest-retention
		>
			{@render badge()}
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Positioner side="bottom" align="start">
				<Popover.Popup size="md">
					<Popover.Title>{m.chat_retentionTitle()}</Popover.Title>
					<Popover.Description>{notice}</Popover.Description>
					{@render why()}
				</Popover.Popup>
			</Popover.Positioner>
		</Popover.Portal>
	</Popover.Root>
{/if}
