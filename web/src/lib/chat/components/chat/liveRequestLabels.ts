// What the LIVE request log calls the model while a turn is still running.
//
// Extracted from LiveRequestLog.svelte so the decision is testable without mounting the component —
// same reason secondOpinionFailure.ts exists.
//
// The live line must never hardcode a brand (CUR-75). An answer can be served by a model other than
// the one selected, and the provenance badge reports that per turn; a static string such as
// "<model> is working…" cannot track a model chosen during the turn, and one that tries is a claim
// the product cannot back.
//
// TWO SOURCES, MOST-MEASURED FIRST. They are genuinely different facts and the order matters:
//
//   measured   routerMetadata.model — what the backend SAYS answered. Absent until the first chunk
//              lands, which is exactly when this component is on screen, so it cannot be the only
//              source or the line would be blank for the part of the turn it exists to narrate.
//   selected   the conversation's model id, from ChatMessage's own prop. The floor.
//
// `selected` is only a sound floor while no model is substituted at turn resolution. If a future
// change swaps the served model for one that never appears in any picker, add a `predicted` rung
// between the two in the same change (CUR-243); without it this line names a model that is not
// answering.
//
// NO SOURCE AT ALL → "The model", never a brand. A generic noun is honest about not knowing yet;
// guessing the default would reintroduce the bug in the one state where we have the least evidence.

import { resolveModelIdentity } from "$lib/chat/identity";
import { SANDBOX_WAIT_PHASE, type FailoverReason } from "$lib/chat/types/MessageUpdate";
import { chromeCopy, type ChromeCopy } from "$lib/chat/chromeCopy";

/** Said when nothing identifies the model yet. Deliberately generic — see the header. */
export const UNKNOWN_MODEL_LABEL = "The model";


/**
 * Name the model for a live, in-flight turn. Most-measured source wins.
 *
 * `??` and not `||` throughout: an empty-string id is a bug upstream, and treating it as "fall through
 * to the next source" would silently paper over it. Only genuinely absent values fall through.
 */
export function liveModelLabel(opts: {
	/** routerMetadata.model — the backend's own report. Wins whenever present. */
	measured?: string;
	/** The conversation's selected model id. */
	selected?: string;
}): string {
	const id = opts.measured ?? opts.selected;
	if (!id?.trim()) return UNKNOWN_MODEL_LABEL;
	// resolveModelIdentity carries the version+size brand (Apertus 1.5 70B, GLM 5.2) and falls back to a
	// readable name for anything it does not recognise, without inventing a maker.
	return resolveModelIdentity(id).short || UNKNOWN_MODEL_LABEL;
}

/**
 * Hold the last real model name so the label cannot un-resolve mid-turn.
 *
 * Across the client-side navigation from /chat to /chat/conversation/<id>, the same element
 * (identity-tracked, so this is not a new component) would otherwise go from
 * "Apertus 70B is computing…" to "The model is computing…" about a second later. The component
 * re-renders across that transition and its `selected` id is briefly absent, so all three sources drop
 * and the honest fallback fires — correct in isolation, and a visible flicker in sequence.
 *
 * Safe because the served model CANNOT change within one turn. A latch would be wrong on a value that
 * can legitimately go back to unknown; this one cannot, so holding the last real answer is strictly
 * more accurate than dropping to the generic.
 *
 * Directional on purpose: it only ever upgrades unknown → known, never known → a different known.
 * A genuinely new measurement still wins, because `current` is returned untouched whenever it is real.
 */
export function latchModelLabel(
	previous: string | undefined,
	current: string,
	/** routerMetadata.route and .model of this turn. An agent turn that has not reported its model yet
	 *  drops any name held from before the route landed: that name was the conversation's selected model,
	 *  and agent-service runs its own. */
	turn?: { route?: string; model?: string }
): string {
	if (turn?.route === "agent" && !turn.model?.trim()) return UNKNOWN_MODEL_LABEL;
	if (current !== UNKNOWN_MODEL_LABEL) return current;
	return previous && previous !== UNKNOWN_MODEL_LABEL ? previous : current;
}

/** A phase marker's name and, for a long screen, its `@part/parts` suffix (CUR-3749). A suffix that
 *  doesn't parse is dropped, so the line falls back to the plain phase. */
function splitPhase(phase: string | null | undefined): { name: string | null | undefined; part?: number; parts?: number } {
	const at = phase?.indexOf("@") ?? -1;
	if (!phase || at < 0) return { name: phase };
	const name = phase.slice(0, at);
	const [p, n] = phase.slice(at + 1).split("/").map(Number);
	return Number.isInteger(p) && Number.isInteger(n) && p >= 1 && p <= n ? { name, part: p, parts: n } : { name };
}

/**
 * The single ACTIVE line at the foot of the live log.
 *
 * `answered` is derived from real streamed tokens, not from a phase marker, so it is the one state we
 * know from the output itself rather than from a server announcement.
 */
export function liveActiveLine(opts: {
	phase?: string | null;
	answered: boolean;
	modelLabel: string;
	/** message.fixedReply is set: the server is answering with a fixed string and no model runs. */
	fixed?: boolean;
	/** The server has sent SPEAK_STATUS for this message: the text is done and the audio is being made. */
	speaking?: boolean;
	/** The visitor's chrome language (chromeCopy.ts, CUR-1575). English when absent. */
	copy?: ChromeCopy;
}): string {
	const t = opts.copy ?? chromeCopy("en");
	// UNKNOWN_MODEL_LABEL stays the English sentinel latchModelLabel compares against; it is translated
	// only here, where it is shown.
	const model = opts.modelLabel === UNKNOWN_MODEL_LABEL ? t.theModel : opts.modelLabel;
	// CUR-1579 / CUR-1978. The fixed notice streams in like tokens, so `answered` turns true on a turn
	// no model touched and the line below would credit one with writing it. FixedReply arrives first.
	if (opts.fixed) return t.fixedReply;
	// CUR-2210. The TTS wait comes after the model has finished, so naming the model here credits it with
	// a wait that belongs to the speech Space. It outranks `answered` for the same reason.
	if (opts.speaking) return t.audio;
	// A code call or an agent task is waiting for a slot on a full sandbox host. It can come after
	// text has streamed (a tool round mid-answer), so it outranks `answered`; the marker after the wait
	// (`sandbox-ready`) hands the line back. (CUR-4584)
	if (opts.phase === SANDBOX_WAIT_PHASE) return t.waitingSandbox;
	if (opts.answered) return t.generating(model);
	// A long input's screen sends `screening@4/9`; the part follows the screening line. (CUR-3749)
	const { name: phase, part, parts } = splitPhase(opts.phase);
	const screeningLine = (line: string) => (part && parts ? `${line} ${t.screeningPart(part, parts)}` : line);
	switch (phase) {
		// Neither of these names the model: they describe work the app does around the turn, not work
		// the model does. Attributing the safety screen to the model would be its own false claim —
		// Coop runs it, and it is a different vendor entirely.
		// CUR-2223. Each names only the retrieval that is really running, so a turn that looks in our own
		// documents never reads as a web search. `searching` is sent only once a web engine is called.
		case "screening":
			return screeningLine(t.screening);
		case "screening-documents":
			return screeningLine(t.screeningDocuments);
		case "screening-web":
			return screeningLine(t.screeningWeb);
		case "screening-documents-web":
			return screeningLine(t.screeningDocumentsWeb);
		case "searching":
			return t.searching;
		// CUR-2275. A native turn's own tool calls, which run after the safety screen has finished.
		case "searching-documents":
			return t.searchingDocuments;
		case "searching-documents-web":
			return t.searchingDocumentsWeb;
		case "thinking":
			return t.thinking(model);
		// CUR-2210. A read-aloud turn holds every token back until the end, so `answered` never turns
		// true; the server sends this once the first held token exists.
		case "writing":
			return t.writing(model);
		// CUR-1579 / CUR-1978. Before the first marker nothing has started, a model least of all, and
		// some turns never reach one: the low-resource-language notice is a fixed reply no model writes,
		// yet this line read "The model is working…" right up to the notice that says so. `thinking`
		// is the first moment a model is really called, so that is where the name first appears.
		default:
			return t.preparing;
	}
}

/**
 * CUR-2239. The line that records a backup model taking over from the primary, in the live log and in the
 * receipt. Both models are named: the badge alone credits only the one that answered, which would leave the
 * attempt on the primary invisible and make the live line's earlier "Apertus is computing…" read as a
 * false claim rather than as the first half of a switch.
 */
export function failoverLine(
	failover: { from: string; to: string; reason: FailoverReason },
	copy: ChromeCopy = chromeCopy("en")
): string {
	const from = resolveModelIdentity(failover.from).short || copy.theModel;
	const to = resolveModelIdentity(failover.to).short || copy.theModel;
	return copy.failover(from, to, failover.reason === "skipped");
}

/** CUR-1756. How long a live step holds before its line starts counting the seconds. */
const ELAPSED_AFTER_MS = 5000;

/**
 * CUR-1756. The seconds a live step has been running, once it has run long enough to be worth counting.
 * A slow web search or a stalled lane can hold one line for most of a minute before the ~45s watchdog
 * answers, and the pulsing dot alone reads as a frozen screen. Steps that
 * finish inside ELAPSED_AFTER_MS show nothing, so an ordinary turn looks the same as before.
 */
export function elapsedLabel(ms: number): string {
	return ms < ELAPSED_AFTER_MS ? "" : `${Math.floor(ms / 1000)}s`;
}
