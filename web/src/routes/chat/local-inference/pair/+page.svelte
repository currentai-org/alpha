<script lang="ts">
	// What a person sees after opening the pairing link from aipotluck-local-client. The
	// server load decides the outcome (+page.server.ts); this page only renders it. A confirmed pair
	// comes back as the action's result in `form`, which wins over the load's own "confirm". (CUR-4110)
	import { m } from "$lib/paraglide/messages.js";
	import { enhance } from "$app/forms";
	import RiCheckboxCircleLine from "~icons/ri/checkbox-circle-line";
	import RiErrorWarningLine from "~icons/ri/error-warning-line";
	import RiLinkM from "~icons/ri/link-m";
	import RiLoader4Line from "~icons/ri/loader-4-line";
	import { Button, Stack, Surface } from "@aipotluck/alpha-ds";
	import { base } from "$lib/chat/paths";
	import type { PairingOutcome } from "$lib/chat/server/managedInference/pairingLink";

	let { data, form }: { data: PairingOutcome; form: PairingOutcome | null } = $props();

	const outcome = $derived<PairingOutcome>(form ?? data);
	let busy = $state(false);

	const errorText = $derived.by(() => {
		switch (outcome.state) {
			case "invalid":
				return m.pairLink_invalid();
			case "taken":
				return m.pairLink_taken();
			case "unavailable":
				return m.pairLink_unavailable();
			case "failed":
				return m.pairLink_failed();
			default:
				return null;
		}
	});
</script>

<svelte:head>
	<title>{m.pairLink_pageTitle()} — Alpha</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-md flex-col p-6">
	<Surface level="2" border="auto" padding="lg" data-pairing-state={outcome.state}>
		{#if outcome.state === "paired"}
			<Stack gap="3">
				<RiCheckboxCircleLine class="size-6 text-fg-1" aria-hidden="true" />
				<h1 class="type-heading text-fg-1">{m.pairLink_doneTitle()}</h1>
				<p class="text-small text-fg-2">{m.pairLink_doneHelp({ name: outcome.label })}</p>
				<Button href={`${base}/settings/local-inference`} class="self-start">
					{m.pairLink_openSettings()}
				</Button>
			</Stack>
		{:else if outcome.state === "pending"}
			<Stack gap="3">
				<RiLoader4Line class="size-6 text-fg-2" aria-hidden="true" />
				<h1 class="type-heading text-fg-1">{m.pairLink_pendingTitle()}</h1>
				<p class="text-small text-fg-2">{m.pairLink_pendingHelp({ name: outcome.label })}</p>
			</Stack>
		{:else if outcome.state === "confirm"}
			<form
				method="POST"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update({ reset: false });
						busy = false;
					};
				}}
			>
				<Stack gap="3">
					<RiLinkM class="size-6 text-fg-1" aria-hidden="true" />
					<h1 class="type-heading text-fg-1">{m.pairLink_confirmTitle({ name: outcome.label })}</h1>
					<p class="text-small text-fg-2">{m.pairLink_confirmHelp()}</p>
					<Button type="submit" variant="primary" disabled={busy} class="self-start">
						{busy ? m.local_pairing() : m.pairLink_confirm()}
					</Button>
				</Stack>
			</form>
		{:else if errorText}
			<Stack gap="3">
				<RiErrorWarningLine class="size-6 text-fg-2" aria-hidden="true" />
				<h1 class="type-heading text-fg-1">{m.pairLink_pageTitle()}</h1>
				<p class="text-small text-fg-2" role="alert">{errorText}</p>
			</Stack>
		{/if}
	</Surface>
</div>
