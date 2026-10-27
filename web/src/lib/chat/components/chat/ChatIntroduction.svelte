<script lang="ts">
	import PotluckMark from "$lib/chat/components/PotluckMark.svelte";
	import type { Model } from '$lib/chat/types/Model';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { resolveModelIdentity, isLocalModelId } from '$lib/chat/identity';
	import { AUTO, modelChoice } from '$lib/chat/routing/choice';
	import { m } from '$lib/paraglide/messages.js';
	import { shelf } from '$lib/chat/constants/starterShelf';
	import { RETENTION_DAYS } from '$lib/chat/constants/retention';
	import { onMount, type Snippet } from 'svelte';
	import { EmptyState, EmptyStateSuggestion } from '@aipotluck/alpha-ds';
	import RiErrorWarningLine from '~icons/ri/error-warning-line';
	import { loadPotluckRun } from '$lib/website';

	// The layout server already resolved and rotated these (CUR-620: 3 of the pool, not the same 3
	// every visit — see +layout.server.ts and $lib/chat/utils/starterRotation). `?? suggestions` is
	// just a defensive fallback, not the normal path.
	const starters = $derived((page.data as { starters?: string[] | null }).starters ?? shelf);

	// Retention/privacy note on the empty-state, so the storage window is visible up front (minimize
	// surprise) rather than only on the policy pages. CUR-1731: the 30-day sweep in cleanup.ts only ever
	// touches guest conversations (userId IS NULL) — a signed-in account's own key carries no clock to
	// substitute, so {retentionDays} is only applied on the guest side. Same auth signal ChatWindow.svelte
	// already uses to gate GuestRetentionNotice (`!page.data.user`).
	const retentionNote = $derived(
		page.data.user
			? m.copy_landingPrivacyNoteSignedIn()
			: m.copy_landingPrivacyNote({ retentionDays: String(RETENTION_DAYS) })
	);

	interface Props {
		/** The model the next message goes to: the composer's pick, not only the settings default. */
		currentModel: Model;
		/** Auto routing will choose the model per message, so there is no one model to name yet. */
		auto?: boolean;
		onmessage?: (content: string) => void;
		/** The composer — rendered between the greeting and the prompt examples. */
		children?: Snippet;
	}

	let { currentModel, auto = false, onmessage, children }: Props = $props();

	// Potluck Run: five clicks on the mark, each within 1.6 s of the last, open the hidden game.
	// Each click turns the mark a quarter, so the count is something you can feel. The game's code
	// loads from the third click on, never before.
	const RUN_CLICKS = 5;
	let markClicks = $state(0);
	let markTimer: ReturnType<typeof setTimeout> | undefined;
	let runOpen = $state(false);
	let markButton = $state<HTMLButtonElement>();
	const PotluckRun = $derived(runOpen && loadPotluckRun ? loadPotluckRun() : null);

	function tapMark() {
		clearTimeout(markTimer);
		markClicks += 1;
		// Fetch the game while the last two clicks land, so the fifth opens it at once.
		if (markClicks === RUN_CLICKS - 2) void loadPotluckRun?.();
		if (markClicks >= RUN_CLICKS && loadPotluckRun) {
			runOpen = true;
			markTimer = setTimeout(() => (markClicks = 0), 900);
			return;
		}
		markTimer = setTimeout(() => (markClicks = 0), 1600);
	}

	// The server renders these buttons before the click handler exists, so a click in the
	// seconds before hydration did nothing at all. Disabled until mount, the button says so instead. (CUR-3311)
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	// The model name is DERIVED, never hardcoded — but which model it derives FROM is the whole point,
	// and `currentModel.id` is only the right source while the picker's model IS the served one. No
	// model is substituted at turn resolution today (CUR-243). If a substitution is ever introduced,
	// this greeting would name the picked model while the badge on the answer names the served one, so
	// this line then needs a served-model source: the picker's id structurally cannot see a swap it is
	// never offered.
	const short = $derived(resolveModelIdentity(currentModel.id).short);

	// Before any turn, where a catalog model will run is a forecast from config, and pooling,
	// fallback lanes and Auto make it wrong some of the time (a line could read "served via HuggingFace"
	// beside a picker row naming another host). So this line names no host, and X-ray's "Where it ran" says
	// it per answer from the turn's own routing record (ProvenanceBreakdown.svelte). A local model
	// (CUR-1194) is the exception: its turns never leave the user's own server, which config can't
	// get wrong.
	// With Auto on and left on Auto, no model is chosen until the person types: Auto picks per message
	// (routing/choice.ts), so naming `currentModel` here promised a model the first answer often wasn't. (CUR-2364)
	const autoChoosing = $derived(auto || (page.data.autoRoutingEnabled === true && $modelChoice === AUTO));
	const servingLine = $derived(
		isLocalModelId(currentModel.id)
			? m.chat_servingLocal({ model: short })
			: autoChoosing
				? m.chat_servingAuto()
				: m.chat_servingXray({ model: short })
	);

	// A model's measured weak spot is one quiet line in the model's details,
	// never on the picker row. Its Settings page is developer-only, so the
	// line sits here, under the sentence naming the picked model, where a guest sees it as they pick.
	// Auto names no model yet, so it shows no weak spot either. (CUR-3911)
	const knownWeakSpot = $derived(autoChoosing ? undefined : currentModel.knownWeakSpot);
</script>

<!-- New-conversation landing on the design system's EmptyState pattern: the Potluck mark, the
     spec's empty-state heading (DM Mono, Size 5), the serving/retention line at Text 3, then the
     composer, then prompt examples (Radius 2 suggestion buttons, spec §3). -->
<!-- data-chat-landing: the empty state's own marker, so a test can tell it apart from a conversation
     without reading its headline, which is catalog copy (sign-in.spec.ts, CUR-1594). -->
<div data-chat-landing class="contents">
	<EmptyState
		title={m.copy_landingHeadline()}
		description={retentionNote ? `${servingLine} ${retentionNote}` : servingLine}
		class="px-0"
	>
		{#snippet mark()}
			<button
				type="button"
				bind:this={markButton}
				class="potluck-mark-egg -m-1 p-1"
				style:--turns={markClicks}
				class:invisible={runOpen}
				aria-label="AI Potluck"
				onclick={tapMark}
				data-potluck-mark-egg
			>
				<PotluckMark class="size-9" />
			</button>
		{/snippet}
		{#if knownWeakSpot}
			<p data-known-weak-spot class="flex items-start gap-1.5 type-caption text-fg-2">
				<RiErrorWarningLine aria-hidden="true" class="mt-0.5 size-3.5 shrink-0 text-caution-text" />
				<span><span class="sr-only">Known weak spot: </span>{knownWeakSpot}</span>
			</p>
		{/if}
		{@render children?.()}
		{#snippet suggestions()}
			{#if starters.length}
				<p class="w-full type-caption text-fg-3">{m.chat_promptExamples()}</p>
				{#each starters.slice(0, 3) as suggestion (suggestion)}
					<EmptyStateSuggestion disabled={!mounted} onclick={() => onmessage?.(suggestion)}>{suggestion}</EmptyStateSuggestion>
				{/each}
			{/if}
		{/snippet}
	</EmptyState>
</div>

{#if PotluckRun}
	{#await PotluckRun then { default: Run }}
		<Run
			origin={() => markButton?.querySelector('svg')?.getBoundingClientRect() ?? null}
			onclose={() => {
				runOpen = false;
				markClicks = 0;
				// The mark is hidden while the game is open; focus it once it is back.
				void tick().then(() => markButton?.focus());
			}}
		/>
	{/await}
{/if}

<style>
	.potluck-mark-egg {
		display: inline-flex;
		cursor: default;
		rotate: calc(var(--turns, 0) * 90deg);
		scale: calc(1 + var(--turns, 0) * 0.04);
		transition:
			rotate 0.42s cubic-bezier(0.34, 1.56, 0.64, 1),
			scale 0.42s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.potluck-mark-egg:focus-visible {
		outline: 2px solid var(--color-accent-1);
		outline-offset: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.potluck-mark-egg {
			transition: none;
		}
	}
</style>
