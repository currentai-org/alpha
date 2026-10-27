<script lang="ts">
	import { page } from "$app/stores";
	import { base } from "$lib/chat/paths";
	import { elapsedSeconds } from "$lib/chat/utils/elapsed.svelte";
	import CarbonRenew from "~icons/carbon/renew";
	import CarbonGroup from "~icons/carbon/group";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import type { Message } from "$lib/chat/types/Message";
	import { ROUTER_NODE } from "../stack/reveal";
	import { useSessionFootprintStore } from "$lib/chat/stores/sessionFootprint.svelte";
	import {
		isRetryable,
		failureMessage,
		type SecondOpinionFailure,
	} from "./secondOpinionFailure";
	import { m } from "$lib/paraglide/messages.js";
	import { assistHostLabel } from "$lib/chat/utils/trace/assistHost";

	// Collective second opinion. The Apertus answer is shown
	// above; one click fans the question out to a panel of independent open models in
	// parallel, then surfaces a VERDICT ON that answer — an agreement headline + where the
	// panel confirms it, challenges it, and what they all miss — plus the raw takes. It
	// never merges them into a new answer: the answer already exists; the panel verifies
	// it. Convergence is "more trustworthy", divergence is "scrutinise" — never an oracle.
	// The agreement summary is an automated read OVER the visible takes, not a verdict on
	// truth, and the panel isn't fully independent (some share lineage) — both said plainly.
	type Opinion = NonNullable<Message["opinions"]>[number];
	type Verdict = NonNullable<Message["verdict"]>;

	interface Props {
		question?: string;
		// Target assistant message id — the verdict + takes persist onto it.
		messageId?: string;
		// Persisted panel + verdict (rendered straight away on reload).
		opinions?: Message["opinions"];
		verdict?: Message["verdict"];
	}
	let { question, messageId, opinions, verdict }: Props = $props();

	// svelte-ignore state_referenced_locally
	let takes = $state<Opinion[]>(opinions ? [...opinions] : []);
	// svelte-ignore state_referenced_locally
	let panelVerdict = $state<Verdict | undefined>(verdict);
	let loading = $state(false);
	let unavailable = $state(false);
	// WHY the panel is unavailable, not just that it is. `not_configured` is permanent (see
	// secondOpinionFailure.ts) and must not be offered a retry; everything else can win on a
	// second press.
	let unavailableReason = $state<SecondOpinionFailure>(null);
	let showTakes = $state(false);

	const footprint = useSessionFootprintStore();

	// Elapsed-seconds counter while the panel runs. The fanout takes ~30-50s (several open models in
	// parallel + a synthesiser), so a static "Asking…" line reads as stuck. An honest live timer +
	// a phase hint ("synthesising" past the point where panelists usually return) tells the user it's
	// progressing without pretending we have per-model granularity we don't stream yet.
	// Shared elapsed-seconds primitive (the same timer the read-aloud warming indicator uses) — drives
	// the "· warming up" cold-start escalation + the live counter below. One implementation, not three.
	const elapsedTimer = elapsedSeconds(() => loading);
	const elapsed = $derived(elapsedTimer.value);

	// Live per-panelist progress, driven by the NDJSON stream from /api/second-opinion: each model
	// shows pending → done/failed as it lands, then the phase flips to "synthesising" for the verdict.
	type PanelStatus = { model: string; modelShort: string; status: "pending" | "done" | "failed" };
	let panelStatus = $state<PanelStatus[]>([]);
	let phase = $state<"querying" | "synthesising">("querying");

	// Lets the user abort the (non-blocking, ~30-50s) panel fan-out instead of waiting it out — the
	// request is opt-in, so it must also be opt-out. Aborting returns to the offer, not an error state.
	let controller: AbortController | null = null;
	const cancel = () => controller?.abort();

	type StreamEvent =
		| { type: "panel"; panelists: { model: string; modelShort: string }[] }
		| { type: "panelist"; model: string; ok: boolean; ms?: number }
		| { type: "phase"; phase: string }
		| { type: "done"; available: boolean; opinions?: Opinion[]; verdict?: Verdict; reason?: string }
		// not_configured early-exit comes back as a single plain-JSON object (no `type`)
		| { available: boolean; opinions?: Opinion[]; verdict?: Verdict; reason?: string };

	let done = $derived(takes.length > 0 && !!panelVerdict);
	// "1 open model" not "1 open models" — singular when exactly one panelist responded.
	let modelCount = $derived(
		takes.length === 1 ? m.message_soModelsOne() : m.message_soModelsMany({ count: takes.length })
	);
	// A "collective/panel/convergence" framing is only honest with ≥2 models. When the fanout collapses
	// to one (cold-start timeouts), it's a single second opinion — agreement is vs the PRIMARY answer,
	// not across a panel. solo flips the copy so we don't launder one model into "the panel agrees".
	let solo = $derived(takes.length < 2);

	// Headline tone tracks the real cross-model agreement — the only honest per-answer
	// confidence signal. high = panel confirms the answer; low = panel disputes it.
	// Labels deliberately AVOID a verdict tone. "panel agrees" read as "confirmed true", but correlated
	// open models that share training lineage agreeing is a weak, non-independent signal.
	// So high agreement is "broadly aligned" (not "agrees"), and divergence — the more informative case —
	// keeps a plain, non-alarm label.
	// Labels are functions so they follow a language switch.
	const TONE: Record<Verdict["agreement"], { dot: string; text: string; label: () => string }> = {
		high: { dot: "var(--ap-live)", text: "var(--ap-live-text)", label: () => m.message_soBroadlyAligned() },
		mixed: { dot: "var(--ap-building)", text: "var(--ap-building-text)", label: () => m.message_soMixedViews() },
		low: { dot: "var(--ap-gap)", text: "var(--ap-gap-text)", label: () => m.message_soDisagree() },
	};
	// Solo (n=1): agreement is one model vs the PRIMARY answer, not across a panel — re-word the label so
	// it reads as "this one model agrees/disagrees with the answer", never "the panel agrees".
	const SOLO_LABEL: Record<Verdict["agreement"], () => string> = {
		high: () => m.message_soAgrees(),
		mixed: () => m.message_soPartlyAgrees(),
		low: () => m.message_soDisagrees(),
	};

	function flashRoute() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("ap:flash", { detail: { ids: [ROUTER_NODE] } }));
		}
	}

	async function getCollective() {
		const q = (question ?? "").trim();
		if (!q || loading) return;
		loading = true;
		unavailable = false;
		unavailableReason = null;
		panelStatus = [];
		phase = "querying";
		flashRoute();
		try {
			// Must include the SvelteKit `base` (= /chat in prod): a bare "/api/second-opinion"
			// resolves against the site root (aipotluck.org), not the chat mount, so in prod it would hit
			// the main site and return non-JSON ("unavailable"). Locally base="" hides this.
			const ac = new AbortController();
			controller = ac;
			const res = await fetch(`${base}/api/second-opinion`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question: q, conversationId: $page.params.id, messageId }),
				signal: ac.signal,
			});
			if (!res.ok || !res.body) {
				unavailable = true;
				unavailableReason = "error";
				return;
			}
			// Read the NDJSON stream: { panel } → { panelist } per model → { phase } → { done }. Each
			// event updates the live progress; the final `done` carries the opinions + verdict.
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let final: Extract<StreamEvent, { available: boolean }> | undefined;
			for (;;) {
				const { done: streamDone, value } = await reader.read();
				if (streamDone) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					let evt: StreamEvent;
					try {
						evt = JSON.parse(line) as StreamEvent;
					} catch {
						continue;
					}
					if ("type" in evt && evt.type === "panel") {
						panelStatus = evt.panelists.map((p) => ({
							model: p.model,
							modelShort: p.modelShort,
							status: "pending" as const,
						}));
					} else if ("type" in evt && evt.type === "panelist") {
						panelStatus = panelStatus.map((p) =>
							p.model === evt.model ? { ...p, status: evt.ok ? "done" : "failed" } : p
						);
					} else if ("type" in evt && evt.type === "phase") {
						phase = "synthesising";
					} else if (!("type" in evt) || evt.type === "done") {
						// final result (streamed `done`, or the plain-JSON not_configured early-exit)
						final = evt as Extract<StreamEvent, { available: boolean }>;
					}
				}
			}
			if (!final?.available || !Array.isArray(final.opinions) || !final.opinions.length) {
				unavailable = true;
				// The plain-JSON not_configured early-exit lands in `final` too (see the parse branch
				// above), so its reason arrives on the same field as the streamed ones.
				unavailableReason = (final?.reason as SecondOpinionFailure) ?? null;
				return;
			}
			takes = final.opinions;
			panelVerdict = final.verdict as Verdict;
			// Count the panel toward the session energy estimate: it ran N independent open models plus
			// a synthesiser — real inference the footprint otherwise misses. Same output-token proxy as a
			// normal reply, summed over every take + the verdict. Recorded once, here in the live fetch
			// (NOT on reload, where takes arrive via props), so it can't double-count.
			footprint.recordResponse(
				[
					...takes.map((t) => t.answer ?? ""),
					panelVerdict.headline ?? "",
					...(panelVerdict.consensus ?? []),
					...(panelVerdict.contradictions ?? []),
					...(panelVerdict.weakSpots ?? []),
				].join("\n")
			);
		} catch (e) {
			// User-initiated abort returns cleanly to the "Get a collective second opinion" offer —
			// nothing failed, so don't show the "unavailable" copy. Any other error IS unavailability.
			if ((e as Error)?.name === "AbortError") {
				panelStatus = [];
				phase = "querying";
			} else {
				unavailable = true;
				unavailableReason = "error";
			}
		} finally {
			loading = false;
			controller = null;
		}
	}
</script>

{#if done && panelVerdict}
	<div
		data-second-opinion-verdict
		class="py-2.5/40 mt-1.5 rounded-sharp border border-[var(--ap-rule)] bg-[var(--ap-paper)]/60 px-3"
	>
		<!-- Verdict headline ON the primary answer — tone earned from cross-model agreement. -->
		<div class="flex items-start gap-2">
			<span
				class="mt-[5px] size-[8px] shrink-0 rounded-full"
				style="background: {TONE[panelVerdict.agreement].dot}"
			></span>
			<div class="min-w-0">
				<div
					class="font-mono text-[length:var(--ap-text-2)] tracking-[0.08em]"
					style="color: {TONE[panelVerdict.agreement].text}"
				>
					{solo ? m.message_secondOpinion() : m.message_soCollective()} · {modelCount} · {solo
						? SOLO_LABEL[panelVerdict.agreement]()
						: TONE[panelVerdict.agreement].label()}
				</div>
				<div class="mt-0.5 text-[length:var(--ap-text-3)] text-[var(--ap-ink)]">{panelVerdict.headline}</div>
				<!-- The caveat gets PARITY with the agreement headline: correlated models agreeing isn't independent verification. Salience must
				     match the claim, or the UI launders correlation into confidence. -->
				<div class="mt-1 text-[length:var(--ap-text-2)] leading-snug text-[var(--ap-ink-3)]">
					{#if solo}
						{m.message_soCaveatSolo()}
					{:else if panelVerdict.agreement === "high"}
						{m.message_soCaveatHigh()}
					{:else if panelVerdict.agreement === "low"}
						{m.message_soCaveatLow()}
					{:else}
						{m.message_soCaveatMixed()}
					{/if}
				</div>
			</div>
		</div>

		<!-- Agreement map: confirm / challenge / weak spots. Only non-empty sections show. -->
		{#if panelVerdict.consensus.length || panelVerdict.contradictions.length || panelVerdict.weakSpots?.length}
			<div class="pt-2/70 mt-2 flex flex-col gap-2 border-t border-[var(--ap-rule)]/70">
				{#if panelVerdict.consensus.length}
					<div>
						<div
							class="font-mono text-[length:var(--ap-text-1)] tracking-[0.08em] text-[var(--ap-live-text)]"
						>
							{m.message_soAgreeOn()}
						</div>
						<ul class="mt-0.5 ml-3 list-disc text-[length:var(--ap-text-3)] text-[var(--ap-ink-2)]">
							{#each panelVerdict.consensus as c (c)}<li>{c}</li>{/each}
						</ul>
					</div>
				{/if}
				{#if panelVerdict.contradictions.length}
					<div>
						<div
							class="font-mono text-[length:var(--ap-text-1)] tracking-[0.08em] text-[var(--ap-gap-text)]"
						>
							{m.message_soWhereSplit()}
						</div>
						<ul class="mt-0.5 ml-3 list-disc text-[length:var(--ap-text-3)] text-[var(--ap-ink-2)]">
							{#each panelVerdict.contradictions as c (c)}<li>{c}</li>{/each}
						</ul>
					</div>
				{/if}
				{#if panelVerdict.weakSpots?.length}
					<div>
						<div
							class="font-mono text-[length:var(--ap-text-1)] tracking-[0.08em] text-[var(--ap-building-text)]"
						>
							{m.message_soWeakSpots()}
						</div>
						<ul class="mt-0.5 ml-3 list-disc text-[length:var(--ap-text-3)] text-[var(--ap-ink-2)]">
							{#each panelVerdict.weakSpots as c (c)}<li>{c}</li>{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Raw takes, one tap away — the summary above is a convenience OVER these. -->
		<button
			type="button"
			class="mt-2 text-[length:var(--ap-text-2)] text-[var(--ap-ink-2)] underline-offset-2 hover:underline"
			onclick={() => (showTakes = !showTakes)}
		>
			{showTakes
				? takes.length === 1
					? m.message_soHideTakesOne()
					: m.message_soHideTakesMany({ count: takes.length })
				: takes.length === 1
					? m.message_soShowTakesOne()
					: m.message_soShowTakesMany({ count: takes.length })} ↓
		</button>
		{#if showTakes}
			<div class="pt-2/70 mt-1.5 flex flex-col gap-3.5 border-t border-[var(--ap-rule)]/70">
				{#each takes as take (take.model)}
					<!-- Each take is nested under its model with a left rule + indent so a wall of model output
					     is visually chunked and skimmable; the header is bold + larger to anchor each block. -->
					<div class="border-l-2 border-[var(--ap-rule)] pl-3">
						<div class="mb-1 flex items-center gap-2">
							<span class="text-[length:var(--ap-text-3)] font-bold text-[var(--ap-ink)]"
								>{take.modelShort}</span
							>
							<span
								class="rounded-sm bg-amber-100 px-1 py-px text-[length:var(--ap-text-1)] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
							>
								{take.openness}{take.sovereign ? "" : ` · ${m.message_soNotSovereign()}`}
							</span>
						</div>
						<!-- Where this take's own call ran, from its routing record; never a planned host (CUR-3563). -->
						<div class="type-caption mb-1 text-fg-3" data-take-host>
							{assistHostLabel(take)
								? m.message_soTakeRanOn({ host: assistHostLabel(take) })
								: m.message_stepHostNotRecorded()}
						</div>
						<div class="prose prose-sm max-w-none text-sm text-[var(--ap-ink-2)] dark:prose-invert">
							<MarkdownRenderer content={take.answer} />
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="mt-2 text-[length:var(--ap-text-1)] text-[var(--ap-ink-3)] italic">
			{#if solo}
				{m.message_soFootSolo()}
			{:else}
				{m.message_soFootPanel({ count: takes.length })}
			{/if}
		</div>
	</div>
{:else if loading}
	<div class="mt-1.5 flex flex-col gap-1 text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]">
		{#if panelStatus.length}
			<!-- Per-model progress, driven by the stream: each panelist lights up the moment its take lands. -->
			<div
				class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[length:var(--ap-text-1)]"
			>
				{#each panelStatus as p (p.model)}
					<span class="inline-flex items-center gap-1">
						{#if p.status === "done"}
							<span class="text-[var(--ap-live)]" aria-hidden="true">✓</span>
							<span class="text-[var(--ap-ink-2)]">{p.modelShort}</span>
						{:else if p.status === "failed"}
							<span class="text-[var(--ap-ink-3)]/60" aria-hidden="true">–</span>
							<span class="text-[var(--ap-ink-3)]/60">{p.modelShort}</span>
							<span class="text-[var(--ap-ink-3)]/50">· {m.message_soNoResponse()}</span>
						{:else}
							<CarbonRenew class="animate-spin text-[length:var(--ap-text-1)]" />
							<span>{p.modelShort}</span>
							<!-- The fast models land in <2s; anything still pending after a few seconds is a model
							     cold-starting on the open router (its first call loads it). Say so honestly. -->
							{#if elapsed > 6}<span class="text-[var(--ap-ink-3)]/55">· {m.message_soWarmingUp()}</span>{/if}
						{/if}
					</span>
				{/each}
			</div>
			{#if elapsed > 6 && panelStatus.some((p) => p.status === "pending")}
				<div class="text-[length:var(--ap-text-1)] leading-snug text-[var(--ap-ink-3)]/70 italic">
					{m.message_soColdStart()}
				</div>
			{/if}
		{/if}
		<div class="inline-flex items-center gap-1.5">
			{#if !panelStatus.length}<CarbonRenew
					class="animate-spin text-[length:var(--ap-text-2)]"
				/>{/if}
			<span>
				{phase === "synthesising" ? m.message_soSynthesising() : m.message_soAsking()}
				{#if elapsed > 0}<span class="text-[var(--ap-ink-3)]/70 tabular-nums">· {elapsed}s</span
					>{/if}
			</span>
		</div>
		<button
			type="button"
			onclick={cancel}
			class="self-start text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)] underline-offset-2 transition-colors hover:text-[var(--ap-ink)] hover:underline"
		>
			{m.message_cancel()}
		</button>
	</div>
{:else if unavailable}
	<!-- Failure is the ONLY surface here (the provenance trace only gets a second-opinion node once
	     takes exist), so it must not whisper: state plainly that no cross-check happened AND give a
	     one-click retry — the offer button below does not render in this branch, so without this the user is
	     stranded on the failure with no way back. -->
	<div class="mt-1.5 flex flex-col gap-1 text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]">
		<!-- Still cause-neutral for the transient reasons: `error` covers a route failure and a network
		     drop as well as the common model-timeout, so don't assert "the models didn't respond" — it
		     isn't always true. `not_configured` is the one cause we CAN name, and must, because it is
		     permanent (secondOpinionFailure.ts). -->
		<span class="italic">{failureMessage(unavailableReason)}</span>
		{#if isRetryable(unavailableReason)}
			<button
				type="button"
				onclick={getCollective}
				class="group inline-flex items-center gap-1.5 self-start text-[var(--ap-ink-2)] transition-colors hover:text-[var(--ap-ink)]"
			>
				<CarbonRenew class="text-[length:var(--ap-text-2)]" />
				<span class="underline-offset-2 group-hover:underline">{m.message_tryAgain()}</span>
			</button>
		{/if}
	</div>
{:else if question}
	<!-- Reads as a link (underline on hover), same convention as ProvenanceTrace's "behind the scenes ↗"
	     tail link and this component's own "Cancel" button above — plain muted text with an icon would not
	     signal "clickable" the way its neighbors in the trace tail do. -->
	<button
		type="button"
		onclick={getCollective}
		class="group mt-1.5 inline-flex items-center gap-1.5 text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)] transition-colors hover:text-[var(--ap-ink)]"
		title={m.message_soOfferTitle()}
	>
		<CarbonGroup class="text-[length:var(--ap-text-2)]" />
		<span class="underline-offset-2 group-hover:underline">{m.message_soOffer()}</span>
	</button>
{/if}
