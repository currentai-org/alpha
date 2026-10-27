import { error, type RequestHandler } from "@sveltejs/kit";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { json } from "$lib/chat/server/api/utils/json";
import { ObjectId } from "bson";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { authCondition } from "$lib/chat/server/auth";
import { config as appConfig } from "$lib/chat/server/config";
import { models } from "$lib/chat/server/models";
import { resolveModelIdentity } from "$lib/chat/identity";
import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { logger } from "$lib/chat/server/logger";
import { getTuning } from "$lib/chat/server/tuning";
import { PANELIST_PREPROMPT, AGGREGATOR_PREPROMPT } from "$lib/chat/server/comparePrompts";
import { stripThink, droppedUnclosedThink } from "$lib/chat/server/stripThink";
import type { Message } from "$lib/chat/types/Message";
import { parseVerdict } from "$lib/chat/server/compareVerdict";
import { earlierTurns, earlierTurnsBlock, type EarlierTurn } from "$lib/chat/server/secondOpinionContext";
import { prepareTurnMedia } from "$lib/chat/server/chat/prepareTurnMedia";
import { multimodalEnabled } from "$lib/chat/server/textOnly";
import { panelModelReadsImages } from "$lib/chat/server/panelImages";
import type { EndpointMessage } from "$lib/chat/server/endpoints/types";

// Collective second opinion (opt-in). The sovereign Apertus primary has ALREADY answered;
// this fans the same question out to a panel of independent open models IN PARALLEL, then
// an aggregator writes a VERDICT ON THE PRIMARY ANSWER — agreement headline + where the
// panel confirms it / challenges it / what they all miss. It deliberately does NOT merge
// the panel into a new answer: the answer already exists, the fanout VERIFIES it. (This is
// a panel-and-synthesis pipeline truncated before its synthesis step — we keep the honest
// "analysis" stage and drop the synthesis, because our product is legibility, not a
// polished consensus.) Cross-model agreement is the only honest per-answer confidence
// signal, so the verdict reports it; it never asserts ground truth.
//
// PERSISTED onto the target message (message.opinions[] + message.verdict), so it survives
// reload. Best-effort and fail-soft: dead panelists are skipped; total failure returns
// { available: false } so the UI falls back honestly rather than hang or fabricate.

// PANELIST_PREPROMPT + AGGREGATOR_PREPROMPT live in $lib/chat/server/comparePrompts so the
// /tuning panel can expose them as editable defaults; the handler reads any override via
// getTuning() and falls back to these constants.

// User-visible wait is governed by two deadlines below, NOT by the per-panelist timeout. The fanout
// is PARALLEL, so an unconditional `Promise.all` wait would not finish until the SLOWEST panelist did,
// and the panel's reasoning models are several times slower than the rest.
//
// An empty answer and a dead model both come back as `null` here, so a panelist that returns "" looks
// like a timeout. A backend may merge `usage` into the finish_reason chunk, and the stream transform
// must not skip such a chunk or runOne() sees "" (CUR-153). A parallel fanout should not be held by
// its slowest member:
//   • EMPTY: nothing landed yet → the panel is almost certainly all-cold; give up fast instead of a
//     minute-long spinner (an all-cold panel can hang about 69s before failing).
//   • SETTLE: at least one take is in → wait at most this long for stragglers, then proceed with what
//     we have. Slow/dead models can no longer hold the feature hostage.
const PANEL_EMPTY_DEADLINE_MS = 15_000;
const PANEL_SETTLE_DEADLINE_MS = 30_000;
// Per-panelist cap on the background call, matched to the settle deadline: a panelist that hasn't
// answered by then can't make it into the panel anyway, so there's no reason to keep its call alive.
const PANEL_TIMEOUT_MS = PANEL_SETTLE_DEADLINE_MS;
// The aggregator is a single call AFTER the panel; keep it bounded so a cold aggregator can't re-inflate
// the wait the deadlines above just fixed. parseVerdict() falls back to a neutral verdict on timeout, so
// the user still gets the panel takes rather than losing the whole feature.
const AGG_TIMEOUT_MS = 20_000;
// A panelist's "take" is a few-paragraph cross-check, not an essay, and a cap keeps the smaller open
// models finishing inside the deadline rather than collapsing the panel to its fastest member.
//
// THE CAP MUST COVER THE CHAIN OF THOUGHT, NOT JUST THE ANSWER. At 1024 a reasoning panelist that
// emits `reasoning_content` (the adapter wraps it as <think>) can spend the entire budget inside that
// block on any question worth reasoning about and never reach its answer. stripThink then correctly
// drops the unclosed block, so the panelist returns nothing for every substantive question, which is
// the only kind anyone asks a verification panel. A substantive multi-part question therefore returns
// `available:false, "empty"`, while a short factual question finishes in a few seconds (CUR-149).
//
// DO NOT FIX THIS BY RAISING THE NUMBER. At 3072 the reasoning does finish (about 15,000 characters
// with finish_reason `stop`), but it takes about 43 seconds, so all four panelists exceed PANEL_TIMEOUT_MS
// and the panel returns empty anyway. 2048 times out most panelists too. More budget buys more chain
// of thought, and the chain of thought is what does not fit.
//
// So the binding constraint is TIME, not tokens, and the two cannot both be satisfied: a reasoning
// panelist on a substantive question needs roughly three times the deadline a second opinion should
// take. The way out is a product decision, not a constant: suppress reasoning for panelists if the
// backend exposes a switch, drop reasoning models from the panel, or accept a much longer wait. The
// value stays at 1024 until then (CUR-149).
const PANELIST_MAX_TOKENS = 1024;
// The aggregator is the SAME reasoning model (AGGREGATOR_MODEL is GLM-5.2-FP8) and had its own
// hardcoded 1024. Named rather than inlined so the two move together when the decision above is made.
const AGGREGATOR_MAX_TOKENS = 1024;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let t: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, rej) => {
		t = setTimeout(() => rej(new Error("compare timeout")), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(t);
	}
}

/** Why a panelist produced no take — see the three-facts note in askPanelist. */
type PanelistReason = "ok" | "capped_reasoning" | "empty" | "failed";

type PanelistResult = {
	answer: string | null;
	reason: PanelistReason;
	status?: number;
	served: { backend?: string; provider?: string };
};

/**
 * One panelist's take, asked with reasoning off, and asked once more without the field when the lane
 * refuses it. Bielik on the Public AI gateway runs on vLLM, which accepts only low/medium/high and
 * answers `reasoning_effort: "none"` with a 400 (CUR-4601). A model that does not reason loses nothing
 * by the missing field; one that does may spend its budget reasoning, and then reports
 * `capped_reasoning` rather than a refusal. A measured row in modelProfiles.verified.json would let
 * acceptedEffort pick the right value before the first call (CUR-2113).
 */
async function runOne(
	modelId: string,
	content: string,
	preprompt: string,
	maxTokens: number,
	timeoutMs: number,
	locals: App.Locals,
	earlier: EarlierTurn[] = [],
	attached?: QuestionAttachments
): Promise<PanelistResult> {
	const ask = (effort: "none" | undefined) =>
		askPanelist(modelId, content, preprompt, maxTokens, timeoutMs, locals, earlier, effort, attached);
	const first = await ask("none");
	if (first.reason !== "failed" || first.status !== 400) return first;
	logger.info({ model: modelId }, "[compare] panelist refused reasoning_effort none; asking again without it");
	return ask(undefined);
}

/** What the person attached to the question being checked (CUR-4670): the images the turn sent, as
 *  the endpoint takes them, and how many attachments there were in all. */
type QuestionAttachments = { images: NonNullable<EndpointMessage["files"]>; total: number };

/**
 * The question as one panel model gets it. A model that reads images, on a request the multimodal gate
 * opens, gets the images themselves; anything it cannot see is named in a line, so it doesn't conclude
 * the person attached nothing. A panel that is not told judges a correct answer about a photo as
 * wrong because "no image was attached" (CUR-4670).
 */
function panelQuestion(
	modelId: string,
	content: string,
	attached: QuestionAttachments | undefined
): { message: EndpointMessage; isMultimodal?: boolean } {
	if (!attached?.total) return { message: { from: "user", content } };
	const sendsImages = attached.images.length > 0 && panelModelReadsImages(modelId) && multimodalEnabled();
	const unseen = attached.total - (sendsImages ? attached.images.length : 0);
	const text = unseen > 0 ? `${content}\n\n${unseenAttachmentsNote(unseen)}` : content;
	return sendsImages
		? { message: { from: "user", content: text, files: attached.images }, isMultimodal: true }
		: { message: { from: "user", content: text } };
}

function unseenAttachmentsNote(count: number): string {
	const what = count === 1 ? "a file (for example an image)" : `${count} files (for example images)`;
	return `[The person attached ${what} to this message that you cannot see. Do not say that nothing was attached. Judge only what you can check without it, and say what depends on it.]`;
}

async function askPanelist(
	modelId: string,
	content: string,
	preprompt: string,
	maxTokens: number,
	timeoutMs: number,
	locals: App.Locals,
	earlier: EarlierTurn[],
	reasoningEffort: "none" | undefined,
	attached?: QuestionAttachments
): Promise<PanelistResult> {
	const question = panelQuestion(modelId, content, attached);
	// generateFromDefaultEndpoint answers "" on failure, which alone reads as a model that said nothing.
	// A panelist whose provider refused it (for example a 400 once a model's only
	// provider went to error) sits in the panel as "empty" for as long as that lasts (CUR-2107).
	let failure: { kind: "ceiling" | "error"; status?: number } | undefined;
	// Where the call ran, from its own response's routing record only, so the take can name its host
	// (CUR-3563). onServed fires more than once; later fields fill in, never blank out, earlier ones.
	const served: { backend?: string; provider?: string } = {};
	try {
		const raw = await withTimeout(
			getReturnFromGenerator(
				generateFromDefaultEndpoint({
					messages: [...earlier, question.message],
					...(question.isMultimodal ? { isMultimodal: true } : {}),
					preprompt,
					generateSettings: { max_tokens: maxTokens, temperature: 0 },
					// This route's own cap, not the default side-call ceiling — a panelist is allowed
					// PANEL_TIMEOUT_MS and the aggregator AGG_TIMEOUT_MS, both longer than that ceiling.
					// withTimeout() below already races this call, but a race only stops US waiting; the
					// generation itself kept running, which is the shape that parks screenStream.
					timeoutMs,
					// NO CHAIN OF THOUGHT ON THIS ROUTE. A panelist is asked to cross-check one answer, not
					// to solve the problem from scratch, and a reasoning model given a token budget will
					// spend all of it thinking. On the compare lane, a four-part governance question at
					// max_tokens 1024 with one field changed:
					//
					//   baseline                    4,695 chars of reasoning,     0 chars of answer
					//   reasoning_effort "none"             0 chars of reasoning, 5,238 chars of answer
					//
					// Zero answer is not a slow panelist or a flaky one; it is a panelist that cannot
					// answer, on every question worth asking a panel. This lane ignores
					// `chat_template_kwargs.enable_thinking` (CUR-149).
					reasoningEffort,
					modelId,
					// OPT OUT of the OPENAI_PROVIDER default pin (config default = "publicai", set to keep the
					// sovereign Apertus primary on Public AI's warm lane). The panel deliberately fans out to a
					// DIVERSE set of open models — EuroLLM, Olmo, GLM, Qwen — most of which Public AI does not
					// host. Inheriting the pin routed every panelist as `<model>:publicai`, which has no backend
					// there, so the call hung to the timeout and the whole panel returned "unavailable" (the
					// EuroLLM/Olmo takes land at 11-17s with the pin removed). "auto" lets the
					// HF router pick a backend that actually serves each model, restoring the working panel.
					provider: "auto",
					onFailure: (kind, status) => (failure = { kind, status }),
					onServed: ({ backend, provider }) => {
						if (backend) served.backend = backend;
						if (provider) served.provider = provider;
					},
					locals,
				})
			),
			timeoutMs
		);
		if (failure) {
			logger.warn(
				{ model: modelId, kind: failure.kind, status: failure.status },
				"[compare] panelist call failed (skipped)"
			);
			return { answer: null, reason: "failed", status: failure.status, served };
		}
		const text = String(raw ?? "");
		const out = stripThink(text);
		if (out) return { answer: out, reason: "ok", served };
		// Three different facts share one `return null` path, and the difference is the whole
		// diagnosis: a panelist that spent its budget reasoning is a CONFIG problem (its cap is too
		// small), a panelist that returned nothing is a MODEL problem, and a throw is a TRANSPORT
		// problem. Reported separately so the next empty panel is readable from one line (CUR-149).
		return {
			answer: null,
			reason: droppedUnclosedThink(text) ? "capped_reasoning" : "empty",
			served,
		};
	} catch (e) {
		logger.warn({ err: String(e), model: modelId }, "[compare] panelist failed (skipped)");
		return { answer: null, reason: "failed", served };
	}
}

/**
 * The question message's attachments, read the way the turn read them: from the owner's own copy,
 * through prepareTurnMedia, the pass that fed the turn's screen. A file that will not read back is
 * still counted, so the panel is told something was attached. Undefined when nothing was.
 */
async function questionAttachments(
	parent: Message,
	conversation: Awaited<ReturnType<typeof resolveConversation>>
): Promise<QuestionAttachments | undefined> {
	const total = parent.files?.length ?? 0;
	if (!total) return undefined;
	try {
		const prepared = await prepareTurnMedia([parent], new ObjectId(conversation._id), {
			ownerId: conversation.userId?.toString(),
			guestSessionId: conversation.userId ? conversation.formerGuestSessionId : conversation.sessionId,
		});
		const images = (prepared.messages.get(parent.id)?.images ?? []).map((img) => ({
			type: "base64" as const,
			value: img.source.toString("base64"),
			mime: img.mime,
			name: img.sha,
		}));
		return { images, total };
	} catch (e) {
		logger.warn(
			{ err: String(e), files: total },
			"[compare] could not read the question's attachments; the panel is told of them only"
		);
		return { images: [], total };
	}
}

// NO per-route `export const config` here: it splits adapter-vercel's function layout and can drop
// routes from the catchall manifest. The Vercel project default of 300s is ample against this route's
// ~50s worst case (30s settle-deadline panel + 20s aggregator, see the deadline constants above), and
// a `maxDuration` below it would only lower the ceiling. If a non-default timeout is ever genuinely
// needed, set it adapter-globally in svelte.config.js, never here.

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	requireAuth(locals);

	// The compare/second-opinion token's HF Inference-Providers permission is granted org-scoped
	// ("on behalf of" the organisation), not user-scoped — so every call on this route needs
	// X-HF-Bill-To or the router 403s as the personal token owner instead. The main chat handler
	// sets this same field (conversation/[id]/+server.ts) but this is a separate route with its own
	// `locals`, so it never inherits that.
	locals.billingOrganization = (Reflect.get(appConfig, "HF_BILL_TO") as string | undefined) || undefined;

	// The panel = COMPARE_PANEL (comma-separated) when set, else the [SECOND, THIRD] pair.
	const panelRaw = ((Reflect.get(appConfig, "COMPARE_PANEL") as string | undefined) ?? "").trim();
	const panelIds = (
		panelRaw
			? panelRaw.split(",").map((s) => s.trim())
			: [
					((Reflect.get(appConfig, "SECOND_OPINION_MODEL") as string | undefined) ?? "").trim(),
					((Reflect.get(appConfig, "THIRD_OPINION_MODEL") as string | undefined) ?? "").trim(),
				]
	)
		.filter(Boolean)
		// Only ids actually registered as endpoints (a bad id is skipped, not fatal).
		.filter((id) => models.some((m) => m.id === id));
	if (!panelIds.length) {
		return json(
			{ available: false, reason: "not_configured" },
			{ headers: { "cache-control": "no-store" } }
		);
	}
	const aggId =
		((Reflect.get(appConfig, "AGGREGATOR_MODEL") as string | undefined) ?? "").trim() || panelIds[0];

	let body: { conversationId?: string; messageId?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, "invalid JSON body");
	}
	const conversationId = (body.conversationId ?? "").trim();
	const messageId = (body.messageId ?? "").trim();
	// The question always comes from the caller's own conversation, as the user turn that
	// produced the answer being checked. That turn passed the input screen before it was persisted. A
	// free-text `question` in the body is not accepted: it would send
	// up to 4,000 unscreened characters to the non-sovereign panel. (CUR-3518)
	if (!conversationId || !messageId) throw error(400, "conversationId and messageId are required");

	// Throws its own 400 (bad id), 403 (someone else's) or 404, which pass through as they are.
	const conversation = await resolveConversation(conversationId, locals);
	// The PRIMARY answer the panel is verifying, and the user message it answered.
	const targetMessage: Message | undefined = conversation.messages.find((m) => m.id === messageId);
	const primaryAnswer = (targetMessage?.content ?? "").trim();
	const parent = conversation.messages.find((m) => m.children?.includes(messageId));
	if (parent?.from !== "user" || !parent.content?.trim()) throw error(400, "missing question");
	const question = parent.content.trim();
	// The turns before the question, so a follow-up is judged in context (CUR-3319).
	const earlier: EarlierTurn[] = earlierTurns(conversation, parent.id);
	if (question.length > 4000) throw error(400, "question too long");
	const attached = await questionAttachments(parent, conversation);

	// One request here is FOUR model completions (the panel fanout + the aggregator), so
	// this route needs the same per-session/daily metering the chat turn has, even though the
	// question text itself was already screened when the primary turn that produced it was sent —
	// this route only re-sends it, it doesn't accept new unscreened text. (CUR-832)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});

	// Live-tunable prompts (admin /tuning panel) with the shared constants as fallback.
	const tuning = await getTuning();
	const panelistPrompt = tuning.panelistPrompt || PANELIST_PREPROMPT;
	const aggregatorPrompt = tuning.aggregatorPrompt || AGGREGATOR_PREPROMPT;

	// Panel metadata computed once (label/openness per model id) — emitted up front so the UI can show
	// every panelist as "pending" immediately, then flip each to done/failed as it lands.
	const panelMeta = panelIds.map((id) => {
		const identity = resolveModelIdentity(id);
		const m = models.find((mm) => mm.id === id);
		return { model: id, modelShort: identity.short || m?.displayName || id, openness: identity.openness };
	});
	const metaById = new Map(panelMeta.map((p) => [p.model, p]));

	// Stream the fanout as NDJSON (one JSON event per line) so the panel lights up model-by-model over
	// the ~30-50s wait instead of a single opaque spinner: { panel } up front, a { panelist } event the
	// moment each model settles, { phase: synthesising } before the aggregator, then a final { done }
	// carrying opinions + verdict (or available:false on total failure). Same fanout/aggregator/persist
	// logic as before — just wrapped so progress is observable. Best-effort: a closed controller (client
	// navigated away) just stops emitting.
	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const emit = (o: unknown) => {
				try {
					controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
				} catch {
					/* controller already closed — client gone; stop emitting */
				}
			};
			try {
				emit({ type: "panel", panelists: panelMeta });
				// Fan out in PARALLEL, collecting each take by index as it lands. We deliberately do NOT
				// block on the slowest panelist: the gate below stops waiting the moment the outcome is
				// settled (all answered, all-cold, or the straggler cap). emit() still fires per model so
				// the UI lights each one up live.
				type Take = (typeof panelMeta)[number] & {
					sovereign: boolean;
					answer: string;
					backend?: string;
					provider?: string;
				};
				const landed: (Take | null)[] = new Array(panelIds.length).fill(null);
				const tasks = panelIds.map((id, i) =>
					(async () => {
						const t0 = Date.now();
						const { answer, reason, status, served } = await runOne(
							id,
							question,
							panelistPrompt,
							PANELIST_MAX_TOKENS,
							PANEL_TIMEOUT_MS,
							locals,
							earlier,
							attached
						);
						const ms = Date.now() - t0;
						if (reason === "capped_reasoning") {
							logger.warn(
								{ model: id, ms, maxTokens: PANELIST_MAX_TOKENS },
								"[compare] panelist spent its whole budget reasoning and never answered (raise its cap)"
							);
						}
						emit({
							type: "panelist",
							model: id,
							ok: Boolean(answer),
							ms,
							reason,
							...(status !== undefined ? { status } : {}),
						});
						const meta = metaById.get(id);
						// sovereign:false — the panel rides the non-sovereign compare endpoint; say so.
						if (answer && meta) landed[i] = { ...meta, sovereign: false, answer, ...served };
					})()
				);
				// Resolve as soon as the outcome is settled — all panelists done, OR nothing landed by the
				// empty-deadline (all-cold → fail fast), OR the settle-deadline caps the stragglers.
				await new Promise<void>((resolve) => {
					// `let`, and prefer-const is wrong to want const: finish() below closes over both handles
					// and clears them, so the declaration has to precede it. Initializing at the assignment
					// site instead would put the binding below its own use — a TDZ ReferenceError, not a tidy-up.
					// eslint-disable-next-line prefer-const
					let emptyTimer: ReturnType<typeof setTimeout> | undefined;
					// eslint-disable-next-line prefer-const
					let settleTimer: ReturnType<typeof setTimeout> | undefined;
					let fired = false;
					const finish = () => {
						if (fired) return;
						fired = true;
						clearTimeout(emptyTimer);
						clearTimeout(settleTimer);
						resolve();
					};
					Promise.all(tasks).then(finish);
					emptyTimer = setTimeout(() => {
						if (!landed.some(Boolean)) finish();
					}, PANEL_EMPTY_DEADLINE_MS);
					settleTimer = setTimeout(finish, PANEL_SETTLE_DEADLINE_MS);
				});
				const opinions = landed.filter((o): o is Take => o !== null);
				if (!opinions.length) {
					emit({ type: "done", available: false, reason: "empty" });
					return;
				}
				emit({ type: "phase", phase: "synthesising" });

				// Aggregate into a verdict ON the primary answer — analyse, do not synthesise.
				const panelBlock = opinions
					.map((o, i) => `${i + 1}. [${o.modelShort}]: ${o.answer}`)
					.join("\n\n");
				const aggInput =
					earlierTurnsBlock(earlier) +
					`QUESTION:\n${question}\n\n` +
					// The aggregator reads no images; told of them, it doesn't side with a take that says there were
					// none (CUR-4670).
					(attached?.total ? `${unseenAttachmentsNote(attached.total)}\n\n` : "") +
					(primaryAnswer
						? `ANSWER GIVEN (by the primary model, the one being audited):\n${primaryAnswer}\n\n`
						: `(No primary answer available — report where the PANEL agrees and disagrees among itself.)\n\n`) +
					`PANEL TAKES (${opinions.length} independent open models):\n${panelBlock}`;
				const aggStart = Date.now();
				const agg = await runOne(
					aggId,
					aggInput,
					aggregatorPrompt,
					AGGREGATOR_MAX_TOKENS,
					AGG_TIMEOUT_MS,
					locals
				);
				if (agg.reason === "capped_reasoning") {
					logger.warn(
						{ model: aggId, maxTokens: AGGREGATOR_MAX_TOKENS },
						"[compare] aggregator spent its whole budget reasoning — verdict fell back to neutral"
					);
				}
				const { verdict, outcome } = parseVerdict(
					agg.answer,
					opinions.length,
					Boolean(primaryAnswer)
				);
				// One line per aggregator call, fallback or not, so a timeout or an empty reply
				// leaves a trace (CUR-2082). Counts and
				// codes only, never text.
				logger.info(
					{
						model: aggId,
						outcome,
						reason: agg.reason,
						ms: Date.now() - aggStart,
						answerChars: agg.answer?.length ?? 0,
						panel: opinions.length,
						timeoutMs: AGG_TIMEOUT_MS,
					},
					"[compare] aggregator"
				);

				// Persist opinions[] + verdict onto the target message (best-effort).
				if (targetMessage) {
					try {
						const updatedMessages = conversation.messages.map((m) =>
							m.id === messageId ? { ...m, opinions, verdict } : m
						);
						// merged, so a turn sent while the panel ran is not erased. (CUR-2806)
						await saveConversationMessages(
							{ _id: new ObjectId(conversation._id), ...authCondition(locals) },
							snapshotConversation(conversation),
							{ messages: updatedMessages }
						);
					} catch (e) {
						logger.error(e, "[compare] persist failed (returning unpersisted)");
					}
				}

				emit({ type: "done", available: true, opinions, verdict });
			} catch (e) {
				logger.error(e, "[compare] fanout failed");
				emit({ type: "done", available: false, reason: "error" });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
	});
};
