<script lang="ts">
	import { onMount, tick, type Component } from 'svelte';
	import {
		DEMO_READY_EVENT,
		leavesToLanding,
		useDemoTransition
	} from '$lib/alpha-landing/demo-transition';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { localizedHref } from '$lib/i18n/routing';
	import { normalizeLocale } from '$lib/i18n/locales';
	import BoldDemoStage from '$lib/alpha-landing/looks/bold/BoldDemoStage.svelte';
	import { DEFAULT_LOOK, LOOK_PARAM, parseLook } from '$lib/alpha-landing/looks/looks';
	import Seo from '$lib/components/seo/seo.svelte';
	import { resolvePageTitle } from '$lib/constants/site';
	import { Button } from '@aipotluck/alpha-ds';
	import PotluckMark from '$lib/chat/components/PotluckMark.svelte';
	import RiCloseLine from '~icons/ri/close-line';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';

	// Dedicated demo mode (entered from "Try the demo" on /alpha): the real app on sample data, inset
	// as a rounded window on a soft gradient, with one slim bar underneath that says what this is and
	// offers the two ways out — Try Alpha (the real thing) and Exit. Sending a message is the only
	// thing that asks you to sign up (AlphaDemoClient).
	let DemoClient = $state<Component | null>(null);
	onMount(async () => {
		DemoClient = (await import('$lib/alpha-landing/AlphaDemoClient.svelte')).default;
		await tick();
		window.dispatchEvent(new Event(DEMO_READY_EVENT));
	});
	// Opens out of /alpha's preview window and shrinks back into it on exit.
	useDemoTransition();

	// The look the visitor came from (/alpha?look=…); the demo dresses to match it.
	const look = $derived(parseLook(page.url.searchParams.get(LOOK_PARAM)));

	function exit() {
		if (leavesToLanding()) {
			history.back();
			return;
		}
		const href = localizedHref(resolve('/alpha'), normalizeLocale(page.data.locale));
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- locale prefixes resolve through the shared reroute hook
		void goto(look === DEFAULT_LOOK ? href : `${href}?${LOOK_PARAM}=${look}`);
	}
</script>

<Seo
	title={resolvePageTitle({ title: m.chat_demoBar() })}
	description={m.chat_demoDescription()}
	canonicalPath="/alpha/demo"
/>

<svelte:window
	onkeydown={(e) => {
		const t = e.target as HTMLElement | null;
		if (e.key === 'Escape' && !t?.closest('[role="dialog"], [role="menu"], input, textarea'))
			exit();
	}}
/>

{#if look === 'bold'}
	<BoldDemoStage {DemoClient} onexit={exit} />
{:else}
	<!-- The stage is a plain dark token scope, not a ThemeProvider: the provider's `.dark` class would make
     every legacy `dark:` utility in the light app nested below match, which /chat never does. -->
	<div
		class="ds-root demo-stage fixed inset-0 flex flex-col gap-3 p-3 md:gap-4 md:p-5"
		data-ds-theme="alpha"
		data-mode="dark"
		data-demo-mode
	>
		<!-- The app, inset as a rounded window. -->
		<div
			class="demo-window min-h-0 flex-1 overflow-hidden rounded-field border border-line-2"
			data-demo-window
		>
			{#if DemoClient}
				<DemoClient />
			{:else}
				<div
					class="grid h-full place-items-center bg-surface-1 type-caption text-fg-3"
					aria-busy="true"
				>
					{m.chat_demoLoading()}
				</div>
			{/if}
		</div>

		<!-- Underneath: a slim bar that says what this is (with Exit), and Try Alpha as its own pill of the
	     same height beside it — the way forward, kept apart from the way out. -->
		<div class="mx-auto flex w-full max-w-3xl shrink-0 items-stretch gap-2" data-demo-footer>
			<div
				class="flex min-w-0 flex-1 items-center gap-3 rounded-pill border border-line-2 bg-surface-2 py-1.5 pr-1.5 pl-3 shadow-popover"
				data-demo-bar
			>
				<PotluckMark class="size-4" />
				<span class="min-w-0 flex-1 truncate type-caption text-fg-1">{m.chat_demoBar()}</span>
				<Button
					variant="ghost"
					size="sm"
					shape="pill"
					casing="sentence"
					onclick={exit}
					aria-label={m.chat_exitDemo()}
					data-exit-demo
				>
					<RiCloseLine aria-hidden="true" />
					{m.chat_exit()}
				</Button>
			</div>
			<!-- Its own capsule, built the same way as the bar (1px border, 6px inset, a small button), so
		     the two are exactly the same height side by side. -->
			<div
				class="flex shrink-0 items-center rounded-pill border border-line-2 bg-surface-2 p-1.5 shadow-popover"
			>
				<Button
					href="/chat"
					variant="primary"
					size="sm"
					shape="pill"
					casing="sentence"
					data-demo-try-alpha
				>
					{m.chat_tryAlpha()}
					<RiArrowRightUpLine aria-hidden="true" />
				</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* A soft brand gradient behind the inset app: coral and deep blue glows on the dark ground. */
	:global(.demo-stage) {
		background:
			radial-gradient(
				ellipse 60% 55% at 12% 0%,
				color-mix(in oklch, var(--ds-accent-1) 34%, transparent),
				transparent 70%
			),
			radial-gradient(
				ellipse 55% 60% at 100% 100%,
				color-mix(in oklch, var(--ds-xray-glow) 30%, transparent),
				transparent 70%
			),
			var(--ds-bg-1);
	}

	/* The window lifts off the gradient. */
	.demo-window {
		box-shadow: var(--ds-shadow-window);
		view-transition-name: alpha-demo;
		/* A containing block for the app's fixed layers (the mobile sidebar drawer and its scrim), so
		   they fill this inset window instead of the viewport — otherwise the drawer runs under the
		   demo bar and its footer is cut off. */
		contain: layout;
	}

	/* The embedded app fills the window, with no second frame of its own. */
	.demo-window :global([data-alpha-demo]) {
		height: 100%;
	}
</style>
