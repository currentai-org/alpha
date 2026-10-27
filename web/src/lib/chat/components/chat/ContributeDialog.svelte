<script lang="ts">
	// The "what happens after the chat" contribution path: a GET handoff to the same Tally form
	// the rest of the site uses (CallToAction.svelte), not a POST into our own DB, which has no
	// notification on a new row, so submissions sit unactioned (CUR-512).
	// Two framing modes: "Stay informed" and "Raise your hand". jagOVJ only has a URL-prefill
	// hidden field for `email` (checked against its live block schema) — no field for name,
	// organization, or free text — so those inputs are gone rather than kept as decoration that
	// silently goes nowhere. contributionType is kept as a LOCAL-only signal (still fires in our
	// own PostHog, per CUR-516's same "don't undercount interest" concern) even though Tally never
	// sees it; the visitor picks their own Builder/Funder/Connector path once inside the form.
	import { untrack } from "svelte";
	import { m } from "$lib/paraglide/messages.js";
	import { error as errorStore } from "$lib/chat/stores/errors";
	import Modal from "$lib/chat/components/Modal.svelte";
	import { contributeOpen } from "$lib/chat/stores/contribute";
	import { trackEvent } from "$lib/analytics";
	import { Button, Field, Radio, RadioGroup, Sheet, Toggle, ToggleGroup, useCompact } from "@aipotluck/alpha-ds";
	import RiArrowRightUpLine from "~icons/ri/arrow-right-up-line";

	const TALLY_FORM_URL = "https://tally.so/r/jagOVJ";

	// Subtle at-handoff privacy note, in the interface language.
	const privacyNote = $derived(m.copy_getInvolvedPrivacyNote());

	// Dialog-only: mounted ONCE at the ChatWindow top level and opened via the
	// `contributeOpen` store (any CTA flips it). Mounting at the top level — rather
	// than nested inside the welcome overlay — lets the Modal backdrop's intro play.

	const KINDS = [
		{ key: "subscribe", label: "Stay informed", hint: "Occasional updates on what we build and ship." },
		{ key: "contribute", label: "Raise your hand", hint: "Offer compute, data, code or funding." },
	] as const;

	type Kind = (typeof KINDS)[number]["key"];

	const TYPES = [
		{ value: "compute", label: "Compute" },
		{ value: "data", label: "Data" },
		{ value: "code", label: "Code" },
		{ value: "funding", label: "Funding" },
		{ value: "other", label: "Other" },
	] as const;

	type ContributionType = (typeof TYPES)[number]["value"];

	let kind = $state<Kind>("subscribe");
	let email = $state("");
	let contributionType = $state<ContributionType | null>(null);
	let topic = $state<string | undefined>(undefined);

	// Opened from a specific gap on the live-stack map ({ topic })? Switch to "Raise your hand"
	// and surface the gap as context. Guarded to the open transition so it never clobbers edits.
	let wasOpen = false;
	$effect(() => {
		const c = $contributeOpen;
		const isOpen = c !== false;
		untrack(() => {
			if (isOpen && !wasOpen) {
				trackEvent("contribution_form_opened", {
					source_element: typeof c === "object" ? "map_gap" : "cta",
					node_id: typeof c === "object" ? c.node : undefined,
				});
				if (typeof c === "object") {
					kind = "contribute";
					topic = c.topic;
				}
			}
			wasOpen = isOpen;
		});
	});

	// Phones get a bottom sheet (the Alpha pattern for every chat overlay); larger screens a dialog.
	const phone = useCompact();

	function reset() {
		email = "";
		contributionType = null;
	}

	function closeDialog() {
		contributeOpen.set(false);
	}

	function handoff(e: SubmitEvent) {
		// `required` on the email input already blocks a native submit on empty/invalid email — this
		// only guards the app-specific rule Tally can't express: "contribute" needs a picked type.
		if (kind === "contribute" && !contributionType) {
			e.preventDefault();
			errorStore.set("Pick what you can contribute.");
			return;
		}
		trackEvent("contribution_form_submitted", {
			contribution_type: kind === "contribute" ? contributionType : undefined,
			node_id: typeof $contributeOpen === "object" ? $contributeOpen.node : undefined,
		});
		contributeOpen.set(false);
		reset();
	}
</script>

<!-- Hierarchy: what this is (title + one line) → what you want (two described choices) → the
     details that choice needs → one primary action → fine print. -->
{#snippet body(showTitle: boolean)}
	<div class="flex w-full flex-col gap-6" data-contribute>
		{#if showTitle}
			<header class="flex flex-col gap-1.5 pr-8">
				<h2 class="type-heading text-fg-1">Get involved</h2>
				<p class="type-body text-fg-2">AI Potluck is a public utility built in the open.</p>
			</header>
		{:else}
			<p class="type-body text-fg-2">AI Potluck is a public utility built in the open.</p>
		{/if}

		<RadioGroup
			value={kind}
			onValueChange={(v) => (kind = v as Kind)}
			aria-label="How you'd like to be involved"
			class="grid grid-cols-2 gap-2 max-sm:grid-cols-1"
		>
			{#each KINDS as k (k.key)}
				<label
					class="flex cursor-pointer items-start gap-3 rounded-field border border-line-2 bg-surface-raised p-3 transition-control hover:border-line-3 has-[[aria-checked=true]]:border-fg-1"
					data-contribute-kind={k.key}
				>
					<Radio.Root value={k.key} class="mt-0.5"><Radio.Indicator /></Radio.Root>
					<span class="flex min-w-0 flex-col gap-0.5">
						<span class="type-body text-fg-1">{k.label}</span>
						<span class="type-caption text-fg-3">{k.hint}</span>
					</span>
				</label>
			{/each}
		</RadioGroup>

		<!-- GET handoff to Tally, same mechanism as CallToAction.svelte. Tally only accepts a
		     URL-prefill for `email` on this form — name/org/detail have no destination there, so
		     they're not collected here either. target="_blank" keeps the chat session alive behind
		     the redirect (this is a modal over an active conversation, not a standalone page). -->
		<form action={TALLY_FORM_URL} method="GET" target="_blank" onsubmit={handoff} class="flex flex-col gap-5">
			{#if kind === "contribute"}
				<fieldset class="flex flex-col gap-2">
					<legend class="mb-2 type-label text-fg-2">What can you bring?</legend>
					{#if topic}
						<p class="-mt-1 mb-1 type-caption text-fg-3" data-contribute-topic>
							For: <span class="text-fg-2">{topic}</span>
						</p>
					{/if}
					<ToggleGroup
						variant="pill"
						value={contributionType ? [contributionType] : []}
						onValueChange={(v) => (contributionType = (v[0] as ContributionType | undefined) ?? null)}
						aria-label="What you can contribute"
						class="flex-wrap gap-2"
					>
						{#each TYPES as t (t.value)}
							<Toggle value={t.value}>{t.label}</Toggle>
						{/each}
					</ToggleGroup>
				</fieldset>
			{/if}

			<Field.Root>
				<Field.Label>Email</Field.Label>
				<Field.Control type="email" name="email" required placeholder="you@organisation.org" autocomplete="email" bind:value={email} />
			</Field.Root>

			<div class="flex flex-col gap-3">
				<Button type="submit" variant="primary" size="lg" casing="sentence" block>
					{kind === "subscribe" ? "Keep me posted" : "Continue"}
					<RiArrowRightUpLine aria-hidden="true" />
				</Button>
				<div class="flex flex-col gap-1 type-caption text-fg-3">
					<p>Opens our form in a new tab — this chat keeps going.</p>
					{#if privacyNote}<p>{privacyNote}</p>{/if}
				</div>
			</div>
		</form>
	</div>
{/snippet}

{#if $contributeOpen}
	{#if phone.current}
		<Sheet.Root open={true} onOpenChange={(o) => !o && closeDialog()}>
			<Sheet.Portal>
				<Sheet.Backdrop />
				<Sheet.Popup data-contribute-sheet>
					<Sheet.Header title="Get involved" />
					<Sheet.Body>{@render body(false)}</Sheet.Body>
				</Sheet.Popup>
			</Sheet.Portal>
		</Sheet.Root>
	{:else}
		<Modal width="max-w-lg!" closeButton onclose={closeDialog}>
			<div class="w-full p-6">{@render body(true)}</div>
		</Modal>
	{/if}
{/if}
