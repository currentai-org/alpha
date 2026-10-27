<script lang="ts">
	// The LIVE request log — shown ABOVE the forming answer WHILE the turn is in flight, then it vanishes
	// and the answer + the collapsed ProvenanceTrace receipt take over (see ChatMessage). This is the
	// "how the request is going" log: it reads like a build log, accumulating phases AS they actually
	// happen, with the active line pulsing — NOT a replay reconstructed after the fact. It only shows phases we genuinely observe live from the streaming message:
	// RAG hits get attached to the request (internal catalog — never reveals anything about the query, so
	// "retrieved from X · N sources" is real the moment it lands), and content tokens stream in (so
	// "writing…" is genuinely active). The fine-grained server-internal steps (history read, screen-clear,
	// guards, persist) have no live signal and belong in the after-the-fact receipt, not here.
	//
	// Open-web search is deliberately NOT promoted to a concrete "searched · N sources" line here: unlike
	// RAG, a web search round-trips the user's literal query to an external engine, so a live "searched ·
	// N sources" line can disclose a concerning query mid-stream, before the model's own disposition (real
	// answer vs. self-decline) is known. The generic "Searching the open web…" line (liveRequestLabels.ts)
	// already gives the honest live signal without naming the query or count; the concrete web sources
	// still show, honestly,
	// in the after-the-fact ProvenanceTrace receipt once the turn is done (which already withholds on a
	// formal decline) — deferred, not hidden.
	//
	// It also owns the live STACK-MAP pulse (moved here from ProvenanceTrace): while the turn runs, the map
	// nodes that are genuinely active pulse; on unmount (turn done / nav) the pulse clears.
	import type { Message } from "$lib/chat/types/Message";
	import { provenanceFacts } from "$lib/chat/utils/trace/provenanceFacts";
	import { backendComputeNode, computePulseNodes, modelNodeFor } from "../stack/reveal";
	import { servedModelId } from "$lib/chat/identity";
	import {
		elapsedLabel,
		failoverLine,
		latchModelLabel,
		liveActiveLine,
		liveModelLabel,
		UNKNOWN_MODEL_LABEL,
	} from "./liveRequestLabels";
	import { currentPhase, synthesizingAudioFor } from "$lib/chat/stores/speakState";
	import { repickWait } from "$lib/chat/stores/repickWait";
	import { slowToStartLine } from "$lib/chat/routing/repick";
	import { page } from "$app/state";
	import { chromeCopy } from "$lib/chat/chromeCopy";
	import { prefersReducedMotion } from "svelte/motion";
	import { fly } from "svelte/transition";

	// The phase labels and the model name they carry live in liveRequestLabels.ts, pure and unit-tested.
	// A hardcoded "Apertus is …" string would name Apertus on every turn, including ones another model
	// served. See that file for why the sources are ordered measured → selected.

	interface Props {
		message: Message;
		/** The conversation's selected model id — the FLOOR of the three sources, not the answer. Passed
		 *  from ChatMessage, which already holds it and hands it to ProvenanceTrace one line away. */
		modelId?: string;
	}
	let { message, modelId }: Props = $props();

	const reduce = $derived(prefersReducedMotion.current);
	// The log's lines follow the language the visitor's browser asks for (chromeCopy.ts). (CUR-1575)
	const t = $derived(chromeCopy(page.data.uiLang));
	let facts = $derived(provenanceFacts(message));

	// Resolved per turn, most-measured source first — see liveRequestLabels.
	// A failover names the backup first. The failover update and the backup's routerMetadata
	// are painted as separate frames, so reading only routerMetadata left one frame with the switch line
	// up beside "<primary> is computing…". Once a failover has happened the backup is what is running. (CUR-2239)
	const resolvedLabel = $derived(
		liveModelLabel({
			measured: message.failover?.to ?? message.routerMetadata?.model,
			selected: modelId,
		})
	);

	// Latched so the name cannot un-resolve mid-turn. The /chat → /chat/conversation/<id> navigation
	// re-renders this component with `selected` briefly absent, which flips the same element
	// from "Apertus 70B is computing…" to "The model is computing…" a second apart. See
	// latchModelLabel for the capture and for why holding is safe here.
	let latched = $state<string | undefined>(undefined);
	$effect(() => {
		if (resolvedLabel !== UNKNOWN_MODEL_LABEL) latched = resolvedLabel;
	});
	// An agent task serves its own model and reports it only on its last frame, so until then the
	// selected model's name (held from before the route landed) would be a wrong claim.
	const modelLabel = $derived(
		latchModelLabel(latched, resolvedLabel, {
			route: message.routerMetadata?.route,
			model: message.failover?.to ?? message.routerMetadata?.model
		})
	);

	// Completed phases we can honestly show live, in order, then the single ACTIVE line.
	// `mark` overrides the ✓ on a done line whose step did not succeed as such (the failover line).
	type LogLine = { key: string; text: string; done: boolean; mark?: string };
	let lines = $derived.by<LogLine[]>(() => {
		if (facts.declined) {
			return [{ key: "declined", text: t.declined, done: true }];
		}
		const out: LogLine[] = [];
		for (const hit of facts.ragHits) {
			out.push({
				// Key on node AND engine: two engines (Potluck, Potluck:Community) share CATALOG_RAG_NODE,
				// so a node-only key collided and threw each_key_duplicate on every streaming frame when a
				// turn hit both the committed catalog and admin-uploaded docs. Matches requestTrace's id.
				key: `rag-${hit.node}-${hit.engine}`,
				text: t.retrieved(hit.label, hit.count),
				done: true,
			});
		}
		if (facts.vault) out.push({ key: "vault", text: "Federated synthesis", done: true });
		// The primary didn't answer and a backup model took over. Named with both models, so the
		// "<primary> is computing…" the line showed a moment ago reads as the first half of the switch. (CUR-2239)
		if (message.failover) {
			out.push({ key: "failover", text: failoverLine(message.failover, t), done: true, mark: "↪" });
		}
		// The live, active line: the REAL current phase (from the server's phase markers) before the first
		// token, then "generating" once tokens genuinely stream. The model it names is resolved per turn,
		// never assumed — see liveRequestLabels.ts.
		out.push({
			key: "gen",
			text: liveActiveLine({
				phase: $currentPhase,
				answered: facts.answered,
				modelLabel: modelLabel,
				fixed: Boolean(message.fixedReply),
				speaking: $synthesizingAudioFor === message.id,
				copy: t,
			}),
			done: false,
		});
		return out;
	});

	// The active line counts its seconds once a step holds past a few, so a slow search or a
	// stalled lane before its watchdog reads as working rather than frozen. The count restarts when the
	// active line's text changes, since each phase is its own wait. (CUR-1756)
	let now = $state(Date.now());
	let activeSince = $state(Date.now());
	let activeText: string | undefined;
	$effect(() => {
		const text = lines.at(-1)?.done ? undefined : lines.at(-1)?.text;
		if (text !== activeText) {
			activeText = text;
			activeSince = Date.now();
			now = activeSince;
		}
	});
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});
	const elapsed = $derived(elapsedLabel(now - activeSince));

	// Auto is waiting on its choice's first word and will ask another model at the give-up. Past
	// half that wait, a line says so, timed from when this answer's log appeared (the send). CUR-4629: once
	// the model has named itself in a provenance frame or a search has brought sources, it has started, and
	// the line goes. A provenance frame with no model (a screen's or a tool's credit) does not count. (CUR-4384)
	const shownAt = Date.now();
	const slowToStart = $derived(
		slowToStartLine({
			wait: $repickWait,
			answerId: message.id,
			elapsedMs: now - shownAt,
			started: facts.answered || !!message.routerMetadata?.model || facts.webCount > 0,
		})
	);

	// ── live stack-map pulse (moved from ProvenanceTrace): pulse the nodes genuinely running this turn ──
	let pulsedNodes: string[] = [];
	const emitPulse = (ids: string[], on: boolean) => {
		if (!ids.length || typeof window === "undefined") return;
		window.dispatchEvent(new CustomEvent(on ? "ap:pulse-on" : "ap:pulse-off", { detail: { ids } }));
	};
	$effect(() => {
		const next = computePulseNodes({
			declined: facts.declined,
			webGrounded: facts.webCount > 0,
			rag: message.rag,
			computeNode: backendComputeNode(message.routerMetadata?.backend),
			// Pulse the model actually serving this turn, not always the Apertus default. (CUR-1124)
			modelNode: modelNodeFor(servedModelId(message.routerMetadata, modelId)),
		});
		const off = pulsedNodes.filter((n) => !next.includes(n));
		const on = next.filter((n) => !pulsedNodes.includes(n));
		emitPulse(off, false);
		emitPulse(on, true);
		pulsedNodes = next;
	});
	// On unmount (the turn finished / nav away), drop this turn's pulse.
	$effect(() => () => emitPulse(pulsedNodes, false));
</script>

<div class="mb-2 flex flex-col gap-0.5" aria-live="polite">
	{#each lines as line (line.key)}
		<div
			class="flex items-center gap-1.5 font-mono text-[length:var(--ap-text-1)] leading-tight"
			in:fly={{ y: -3, duration: reduce ? 0 : 200 }}
		>
			{#if line.done}
				<span class="text-[var(--ap-live)]" aria-hidden="true">{line.mark ?? "✓"}</span>
				<span class="text-[var(--ap-ink-3)]">{line.text}</span>
			{:else}
				<!-- Nudge the dot up ~1px: items-center box-centers it, but next to the mono text its optical
				     center sits low (reads as a baseline period). relative/-top lifts it to the text midline. -->
				<span
					class="relative -top-px size-[6px] shrink-0 rounded-full bg-[var(--ap-live)]"
					class:animate-pulse={!reduce}
					aria-hidden="true"
				></span>
				<!-- The active line's closing "…" fills in one dot at a time, so a long wait (ALIA can take
				     ~40 s) reads as working rather than stuck. Only the glyph's visible width moves: the text
				     stays exactly as written, for screen readers and the specs that read it. -->
				<span class="text-[var(--ap-ink-2)]" data-live-line
					>{#if line.text.endsWith("…")}{line.text.slice(0, -1)}<span class="live-ellipsis" class:animated={!reduce}
							><span>…</span></span
						>{:else}{line.text}{/if}</span
				>
				<!-- Hidden from the live region: a count that changes every second would be read out each time. -->
				{#if elapsed}
					<span class="text-fg-3 tabular-nums" data-testid="live-elapsed" aria-hidden="true">· {elapsed}</span>
				{/if}
			{/if}
		</div>
	{/each}
	{#if slowToStart}
		<div
			class="flex items-center gap-1.5 font-mono text-small leading-tight"
			data-testid="live-slow-start"
			in:fly={{ y: -3, duration: reduce ? 0 : 200 }}
		>
			<span class="text-fg-3" aria-hidden="true">↪</span>
			<span class="text-fg-2">{slowToStart}</span>
		</div>
	{/if}
</div>

<style>
	/* A fixed 1ch box, so the line doesn't shift; the glyph inside is revealed 0 → 3 dots, then repeats. */
	.live-ellipsis {
		display: inline-block;
		width: 1ch;
		vertical-align: bottom;
	}
	.live-ellipsis span {
		display: inline-block;
		overflow: hidden;
		white-space: nowrap;
		vertical-align: bottom;
	}
	.live-ellipsis.animated span {
		animation: live-ellipsis 1.6s steps(4, jump-none) infinite;
	}
	@keyframes live-ellipsis {
		from {
			width: 0;
		}
		to {
			width: 1ch;
		}
	}
</style>
