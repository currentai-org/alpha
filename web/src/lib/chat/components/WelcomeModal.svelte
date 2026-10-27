<script lang="ts">
	// First-run welcome (the Feature Lock's top item): a non-technical visitor arriving cold needs to
	// know what Alpha is and who built it before the chat reads as "just another chatbot". It sits over
	// the whole app, sidebar included, and hands over to the guided tour, which shows the features where
	// they live rather than describing them here. A dialog on larger screens, a bottom sheet on phones.
	//
	// Every way out other than "Take the tour" (Start chatting, Escape, the backdrop, a swipe down on
	// the sheet) is a skip, and the caller points at where the tour lives afterwards.
	//
	// Voice: flat, declarative, non-anthropomorphic, honest about the alpha. Don't add a promise the
	// product doesn't back.
	//
	// Names the e2e suite and live probe rely on are stable: the dialog "Welcome to Alpha" (named by its
	// heading), the "Take the tour" and "Start chatting" buttons, and `data-welcome` / `data-welcome-start`.
	import { onMount, tick } from 'svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { Button, Dialog, Sheet, useCompact } from '@aipotluck/alpha-ds';
	import { catalogByGatewayId, orgs, type OrgId } from '$lib/chat/routing/catalog';
	import OrgLogo from './provenance/OrgLogo.svelte';
	import PotluckMark from './PotluckMark.svelte';
	import { page } from '$app/state';
	import { error } from '$lib/chat/stores/errors';
	import { welcomeOnScreen } from '$lib/chat/stores/welcomeOnScreen.svelte';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';
	import RiCompass3Line from '~icons/ri/compass-3-line';

	interface Props {
		/** "Take the tour": the welcome has closed, and the tour can find the features it points at. */
		onTakeTour: () => void;
		/** Any other way out: the welcome has closed. */
		onStartChatting: () => void;
		/** The welcome has started to close, by any way out. Fires before the close animation, so the
		 *  seen mark is saved before a reload in that window can cancel it (CUR-4348). */
		onDismiss: () => void;
	}

	let { onTakeTour, onStartChatting, onDismiss }: Props = $props();

	const phone = useCompact();
	let open = $state(true);
	// Server-rendered, so a click before hydration would do nothing: the buttons wait for it.
	let ready = $state(false);
	let choice: 'tour' | 'chat' = 'chat';
	let tourButton = $state<HTMLElement | null>(null);

	function choose(next: 'tour' | 'chat') {
		choice = next;
		open = false;
	}
	// Escape, the backdrop and a swipe close it through `bind:open` without passing through choose.
	let dismissed = false;
	$effect(() => {
		if (open || dismissed) return;
		dismissed = true;
		onDismiss();
	});
	// No scroll lock (`preventScroll={false}`): the app shell never scrolls the page, the backdrop
	// already takes every click outside, and the lock's `pointer-events: none` on <body> can outlive this
	// dialog (left in place after it closes), so the tour card it hands over
	// to could not be clicked.
	//
	// The caller acts once the close has finished, so the tour's ring and card never land under the
	// backdrop on its way out, and focus isn't handed back to the page before the caller places it.
	function closed(isOpen: boolean) {
		if (isOpen) return;
		if (choice === 'tour') onTakeTour();
		else onStartChatting();
	}

	onMount(() => {
		ready = true;
		// The dialog's own open focus ran while the buttons were still disabled, so it lands here.
		tick().then(() => tourButton?.focus());
		welcomeOnScreen.open = true;
		return () => {
			welcomeOnScreen.open = false;
		};
	});

	// An error raised while the welcome is up (a chat link that can't open) shows here, in the
	// welcome, instead of as the toast that covered it. It stays until the welcome closes. (CUR-2883)
	let note = $state('');
	$effect(() => {
		if ($error) note = $error;
	});

	// Who made and who runs the models this deployment actually serves, read from its model list
	// rather than typed out: production serves only Apertus, so crediting the develop-only makers there
	// (BSC, AI Singapore) named parts a visitor could not use (CUR-2565). Cloudflare is credited for
	// Clef, the classifier Auto asks to read a draft, only where that read is on (`clef-routing`, the
	// same gate as the picker's Clef credit).
	const makers = $derived.by(() => {
		const ids: OrgId[] = [];
		for (const served of (page.data.models ?? []) as { id: string }[]) {
			const entry = catalogByGatewayId(served.id);
			if (!entry) continue;
			for (const id of [entry.maker, entry.provider]) if (id && !ids.includes(id)) ids.push(id);
		}
		if (page.data.clefRoutingEnabled === true && !ids.includes('cloudflare')) ids.push('cloudflare');
		return ids.map((id) => orgs[id]).filter(Boolean);
	});

	// The tour is the way forward, so it takes focus first: Enter takes the tour.
	function focusTour(e: Event) {
		e.preventDefault();
		tourButton?.focus();
	}
</script>

{#snippet body()}
	<div class="flex flex-col gap-3">
		{#if note}
			<p role="status" class="type-small text-fg-2">{note}</p>
		{/if}
		<PotluckMark class="size-8" />
		<!-- The dialog takes its name from this heading, so a screen reader announces what is on screen. -->
		<Dialog.Title level={1}><span class="type-display">{m.welcome_title()}</span></Dialog.Title>
		<Dialog.Description>{m.welcome_intro()}</Dialog.Description>
		<p class="type-body text-fg-2">{m.welcome_tourPitch()}</p>
	</div>

	{#if makers.length > 0}
		<section class="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label={m.welcome_madeWith()}>
			<span class="type-caption text-fg-3">{m.welcome_madeWith()}</span>
			{#each makers as org (org.id)}
				<span class="inline-flex items-center gap-1.5 type-caption text-fg-2">
					<OrgLogo {org} size="xs" />{org.name}
				</span>
			{/each}
		</section>
	{/if}

	<!-- Phones stack them full width, the tour on top under the thumb; larger screens put the tour last,
	     where a dialog's way forward goes. -->
	<div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
		<Button variant="ghost" size="lg" casing="sentence" class="max-sm:w-full max-sm:justify-center" disabled={!ready} onclick={() => choose('chat')} data-welcome-start>
			{m.welcome_startChatting()}
		</Button>
		<Button
			bind:ref={tourButton}
			variant="primary"
			size="lg"
			casing="sentence"
			class="max-sm:w-full max-sm:justify-center"
			disabled={!ready}
			onclick={() => choose('tour')}
			data-welcome-tour
		>
			<RiCompass3Line aria-hidden="true" />
			{m.tour_take()}
			<RiArrowRightLine aria-hidden="true" />
		</Button>
	</div>
{/snippet}

<!-- Not portalled: a portal mounts only in the browser, so the welcome would appear a moment after the
     page did, over a message box the visitor may already be typing in. Rendered in place it is in the
     server's HTML. It still covers the whole app, sidebar included: the shell's `isolate` root is its
     only stacking context, and no ancestor transforms while it is up. -->
{#if phone.current}
	<Sheet.Root bind:open onOpenChangeComplete={closed}>
		<Sheet.Portal disabled>
			<Sheet.Backdrop blur />
			<Sheet.Popup
				onOpenAutoFocus={focusTour}
				onCloseAutoFocus={(e) => e.preventDefault()}
				preventScroll={false}
				data-welcome
			>
				<Sheet.Body class="gap-6 px-5 pt-2 pb-5">{@render body()}</Sheet.Body>
			</Sheet.Popup>
		</Sheet.Portal>
	</Sheet.Root>
{:else}
	<Dialog.Root bind:open onOpenChangeComplete={closed}>
		<Dialog.Portal disabled>
			<Dialog.Backdrop blur />
			<Dialog.Popup
				size="md"
				padded={false}
				class="gap-6 p-8"
				onOpenAutoFocus={focusTour}
				onCloseAutoFocus={(e) => e.preventDefault()}
				preventScroll={false}
				data-welcome
			>
				{@render body()}
			</Dialog.Popup>
		</Dialog.Portal>
	</Dialog.Root>
{/if}
