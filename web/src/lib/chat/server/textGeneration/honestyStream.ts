import type { DeclineLanguage } from "$lib/chat/server/declineCopy";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { nextChunk } from "./screenStream";
import { opensWithFencePreamble } from "./fencePreamble";
import {
	buildGroundedHedgeReplacement,
	isHedgeSentence,
	splitSentences,
	hasSubstantiveText,
	type CitableSource,
} from "$lib/chat/server/hedgeGuard";
import { detectRecencyHedgeSemantic } from "$lib/chat/server/semanticHedge";
import {
	detectFabricatedSources,
	stripTrailingSourceList,
	stripTrailingTitleDump,
	type TrailingSourceListSource,
} from "$lib/chat/server/sourceGuard";
import { dehyphenateOpenSource } from "$lib/chat/server/openSourceGuard";
import {
	leadWithEuropeanLine,
	linkBareHelpline,
	CRISIS_REFERRAL_ORDER_FLAG,
} from "$lib/chat/server/crisisReferralOrder";
import { guardHelplineNumbers, namesOurCrisisResource } from "$lib/chat/server/helplineNumberGuard";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { measureDegeneration } from "./degeneration";
import { noteLongAnswer, timedPass } from "./passTiming";
import {
	markupRunawayStart,
	stripEchoedWrapperTail,
	stripMarkupRunaway,
	stripTrailingCloserRun,
} from "./trailingCloserRun";
import {
	detectDegenerateRepetition,
	repetitionGuardEnabled,
	repetitionNotice,
} from "./repetitionGuard";
import { stripDanglingCitations, stripUnbackedSourceClaims } from "$lib/chat/server/citationGuard";
import { verifyCitationLabels, type CitationLabelSource } from "$lib/chat/server/citationLabelGuard";
import { detectFabricatedUrls, markedUrlsIn, stripRawSourceUrls } from "$lib/chat/server/urlGuard";

// ── Chunked streaming HONESTY guard (hold-nothing, correct-as-you-go) ───────────────────────────
// Mirrors screenStream.ts's shape (same nextChunk batching primitive) but for a DIFFERENT guard
// family: not "is this safe to show" (Coop content/child moderation) but "is this citation/hedge/
// URL/source claim actually backed by what was retrieved." A single whole-answer pass applied only to
// the composed FinalAnswer would run AFTER every token had already streamed live via Stream events,
// and when it rewrote the text (a dangling [3], a lying "[1] (European Commission)" label, a
// fabricated URL, a hedge sentence), the client's rendered answer would visibly snap to something
// different from what it just watched type out.
//
// So this module batches Stream tokens the same way (sentence/paragraph/400-char grain via nextChunk) and run
// the checks that only need FIXED, ALREADY-KNOWN-BEFORE-GENERATION reference data (source count,
// source list, allowed URLs) on each batch BEFORE releasing it — so what streams IS the corrected
// text, not the raw text. No pipelining/concurrency needed here (unlike screenStream's Coop calls):
// every check below is a synchronous, zero-network local function, so releasing at the FINEST safe
// grain (no batch-size grouping) costs nothing and gives the best TTFT.
//
// NOT everything is chunk-safe, and this module does NOT pretend otherwise:
//   • detectFabricatedSources' trailing "Sources:"-heading-to-EOF trim needs to see all the way to
//     the real end of the answer (a heading only means "the rest is a fabricated bibliography" once
//     nothing legitimate follows it) — resolved once at end-of-stream, same as before.
//   • The semantic (embedding) hedge catch-all is a deliberate RECALL boost over sentences the cheap
//     regex pass didn't flag (semanticHedge.ts's own docs) — running it per-chunk would mean one
//     embedding round trip per batch instead of one for the whole answer. The regex pass alone runs
//     per-chunk (zero latency, catches "the obvious cases" per its own doc comment); the embedding
//     pass still runs once at the end, so it can only rarely correct a sentence that ALREADY
//     streamed — same residual, rare flash as today, not eliminated, but no longer the common case.
//   • bailedWholeAnswer (the whole answer WAS a hedge/refusal) is inherently an end-of-stream
//     verdict — you cannot know "nothing substantive survives" until nothing more is coming.
//   • detectFabricatedSources' disclaimer-strip and stripUnbackedSourceClaims BOTH carry their own
//     safety floor ("never gut more than N%/24 chars — a fabricated block is bad, a gutted answer is
//     worse"), sized for a WHOLE answer. Applied to a single small batch that happens to be nothing
//     but the flagged sentence, that floor rejects the strip every time (removing 100% of a tiny
//     batch always looks like over-stripping), so per-batch application would never fire. Both run once at end-of-stream instead, where "how much of
//     the WHOLE answer would this remove" is the question the floor was actually designed to answer.
// All four residual cases are rare in practice, unlike dangling citations / bad labels / fabricated URLs / hyphenation, which
// this module now corrects before anything reaches the client.

const MAX_CHUNK_CHARS = 400; // same fallback grain as screenStream — see nextChunk's own doc comment

export interface HonestyStreamSource {
	n: number;
	title: string;
	url?: string;
}

export type HonestyFinalMutationGuard =
	| "groundedHedgeReplacement"
	| "groundedHedgeUngroundedRegen"
	| "semanticHedge"
	| "fabricatedSources"
	| "rawSourceUrls"
	| "trailingSourceList"
	| "trailingTitleDump"
	| "unbackedSourceClaims"
	| "markupRunaway"
	| "trailingCloserRun"
	| "echoedWrapperTail"
	| "degenerateRepetition"
	| "recitalRegen"
	| "recitalReplacement"
	| "helplineNumber";

export interface HonestyFinalMutation {
	guard: HonestyFinalMutationGuard;
	beforeChars: number;
	afterChars: number;
	deltaChars: number;
}

export interface HonestyGuardNotice {
	labelCount: number;
	urlCount: number;
	urls: string[];
	sourceRemovedChars: number;
	finalMutations: HonestyFinalMutation[];
}

export interface HonestyStreamOptions {
	/** the turn was grounded (web search / RAG) — gates hedge-stripping, citation/label checks, and
	 *  the trailing fabricated-Sources-block trim (a recency hedge / bare "[1]" is only DISHONEST
	 *  when real sources WERE retrieved this turn). */
	grounded: boolean;
	/** combined RAG[1..k] + web[k+1..] source list, in citation-number order (index n-1). */
	sources: HonestyStreamSource[];
	/** retrieved source URLs (web + RAG) — trusted hosts on a grounded turn (urlGuard). */
	allowedUrls: string[];
	/** The turn retrieves through tool calls (the native harness), so its sources arrive as
	 *  WebSearch and Rag updates inside the stream rather than before it. Each update carries that (CUR-2697)
	 *  kind's set so far; it replaces what the stream holds and makes the turn grounded. */
	sourcesFromStream?: boolean;
	/** called once, after the FinalAnswer resolves, with whatever was actually flagged (fields are 0
	 *  / empty when nothing fired — caller decides whether to stamp a message notice). */
	onNotice?: (notice: HonestyGuardNotice) => void;
	/** Called when a grounded turn's whole answer bails to a hedge/refusal (CUR-148), BEFORE falling
	 *  back to the static sources-pointer (buildGroundedHedgeReplacement). Should resolve to a freshly
	 *  generated ungrounded answer, or undefined to fall back to the pointer — also what happens when a
	 *  caller has no ungrounded-regen path wired (e.g. eval harnesses), preserving today's behavior. See
	 *  $lib/chat/server/textGeneration/groundedBailRegen for the implementation this wraps in +server.ts. */
	onGroundedBail?: () => Promise<string | undefined>;
	/** Called when the answer opens by reciting the fenced turn's preamble (CUR-3886). Should resolve
	 *  to a fresh answer to the same turn, or undefined; with none usable, the answer is replaced by
	 *  RECITAL_FALLBACK_MESSAGE rather than shipping our own prompt text. */
	onRecital?: () => Promise<string | undefined>;
	/** How many numbered sources the visitor pasted into their message (visitorSources.ts). Our own sources
	 *  are numbered after them, and the guards treat [1..k] as backed by the message (CUR-3844). */
	visitorSourceCount?: number;
	/** The language the person wrote in, awaited only when the loop notice replaces the answer (CUR-4052). */
	noticeLanguage?: Promise<DeclineLanguage>;
	/** The 639-3 tag of what the person wrote, awaited only when the sources pointer replaces the answer,
	 *  so it reads in their language (CUR-4339). Undefined reads in English. */
	messageLanguage?: Promise<string | undefined>;
	/** Whether the turn is stamped `moderation.support` (CUR-4061). Read per batch, since the stamp can
	 *  land while the answer streams. Without it, an answer counts as a crisis answer only once it names
	 *  findahelpline, 112 or 988 itself. */
	crisisSupport?: () => boolean;
	/** The visitor's `x-vercel-ip-country`, so their own emergency number survives the number guard. */
	helplineCountry?: string | null;
	/** The country the message names for the person at risk (CUR-4488), read per batch. When set, a replaced
	 *  number links that country's findahelpline page and its emergency number survives. */
	namedHelplineCountry?: () => string | undefined;
	/** Settles once the support classifier has stamped the turn or declined to. The end-of-stream number
	 *  pass waits on it, so an answer that finishes before the stamp lands is still guarded. */
	crisisSupportSettled?: () => Promise<unknown>;
}

/** Shown in place of an answer that recited our own prompt and whose one retry did too, or failed. */
const RECITAL_FALLBACK_MESSAGE =
	"Sorry, this model repeated its own instructions instead of answering. Please send your message again, or try another model.";

/**
 * Wrap a text-generation event stream (raw `textGeneration(ctx)`, or `screenOutputStream(...)`'s
 * output when OUTPUT_MODERATION is on — this wrapper is agnostic to which) with per-chunk honesty
 * screening. Yields corrected Stream events as each batch clears, passes non-content events through,
 * and — ONLY when the source itself produced a FinalAnswer — ends with one composed of the fully
 * reconciled text. When the source ends WITHOUT a FinalAnswer (today: a client abort before the
 * model's own stream produced one), this yields NOTHING further: the handler's own
 * emitInterruptedFinalAnswer() owns composing that answer (it clamps to the exact reported stop
 * point), and must not be pre-empted by a FinalAnswer manufactured here.
 *
 * An upstream FinalAnswer ends the content (CUR-1907). The composed FinalAnswer goes out then, and
 * anything the source still yields afterwards, such as the conversation title merged into the same
 * stream, passes through after it. Waiting for the source to end held a short answer back until the
 * title call finished, up to 15s, which is the hold screenStream.ts dropped in #1326.
 */
export async function* honestyScreenStream(
	source: AsyncIterable<MessageUpdate>,
	opts: HonestyStreamOptions
): AsyncGenerator<MessageUpdate> {
	const it = source[Symbol.asyncIterator]();
	let contentDone = false;
	const content: AsyncIterable<MessageUpdate> = {
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<MessageUpdate>> => {
				if (contentDone) return { done: true, value: undefined };
				const step = await it.next();
				if (!step.done && step.value.type === MessageUpdateType.FinalAnswer) contentDone = true;
				return step;
			},
		}),
	};
	try {
		yield* honestyScreenContent(content, opts);
		if (!contentDone) return;
		for (;;) {
			const step = await it.next();
			if (step.done) return;
			yield step.value;
		}
	} finally {
		await it.return?.();
	}
}

async function* honestyScreenContent(
	source: AsyncIterable<MessageUpdate>,
	opts: HonestyStreamOptions
): AsyncGenerator<MessageUpdate> {
	let { grounded, sources, allowedUrls } = opts;
	const visitorCount = opts.visitorSourceCount ?? 0;
	let sourceCount = sources.length;
	let streamRag: HonestyStreamSource[] = [];
	let streamWeb: HonestyStreamSource[] = [];
	const adoptStreamSources = () => {
		sources = [...streamRag, ...streamWeb];
		// Stryker disable next-line ArrayDeclaration: a non-URL entry matches no link, so the list's effect is unchanged.
		allowedUrls = sources.flatMap((s) => (s.url ? [s.url] : []));
		sourceCount = sources.length;
		grounded = sourceCount > 0;
	};

	let buffer = "";
	let released = "";
	let sawFinalAnswer = false;
	let finalInterrupted = false;
	// A genuine hedge sentence streams real tokens before per-chunk stripping reduces it to
	// nothing (see processBatch's hedge branch below) — so "empty after stripping" alone can't tell a
	// real hedge apart from a dead generation that never produced a single token. This does: it's
	// false only when NO Stream event ever arrived at all. (CUR-1157)
	let anyStreamTokenSeen = false;
	// Third of three layers that hold the incoming FinalAnswer and compose a replacement (the others
	// are screenStream and the compose block in index.ts). Each one drops every field it does not copy
	// by hand, so a field added upstream (such as the token-cap notice) must be copied here too (CUR-149).
	let finalTruncated = false;
	// The source's own FinalAnswer.text, held so it can be recovered below when it carries
	// real content this loop never saw as Stream tokens (see the recovery after the loop). Paired with
	// rawStreamedLen, the RAW length actually sent as Stream tokens before any correction ran — the
	// signal that tells "never streamed" apart from "streamed, then corrected down to something
	// shorter," which `released`'s own (post-correction) length cannot. (CUR-1145)
	let sourceFinalText = "";
	let rawStreamedLen = 0;
	// Out-of-band output-moderation carriers (CUR-946). Held like finalTruncated: this stage discards
	// the incoming FinalAnswer.text, so a decline/notice written into that text would vanish. The route
	// resolves these into the body once, after every model-text guard. Honesty is the last guard.
	let finalDeclineText: string | undefined;
	let finalDeclineNotice: string | undefined;

	let labelCount = 0;
	let sourceRemovedChars = 0;
	const finalMutations: HonestyFinalMutation[] = [];

	const recordFinalMutation = (
		guard: HonestyFinalMutationGuard,
		before: string,
		after: string
	) => {
		if (before === after) return;
		finalMutations.push({
			guard,
			beforeChars: before.length,
			afterChars: after.length,
			deltaChars: after.length - before.length,
		});
	};

	const recoverCleanPrefix = (text: string, cleaned: string): string | null => {
		if (cleaned === text) return null;
		if (text.startsWith(cleaned)) return cleaned;
		const trimmed = text.trimEnd();
		if (trimmed.startsWith(cleaned)) return cleaned;
		return null;
	};

	const sourceGuardCleanPrefix = (text: string): string | null => {
		if (!text.trim()) return null;

		if (!grounded) {
			const unbacked = stripUnbackedSourceClaims(text, sourceCount, visitorCount);
			return unbacked.stripped ? recoverCleanPrefix(text, unbacked.cleaned) : null;
		}

		const src = detectFabricatedSources(text, { grounded });
		const srcPrefix = src.flagged ? recoverCleanPrefix(text, src.cleaned) : null;
		if (srcPrefix !== null) return srcPrefix;

		const rawUrls = stripRawSourceUrls(text, sources, { grounded });
		const rawUrlPrefix = rawUrls.flagged ? recoverCleanPrefix(text, rawUrls.cleaned) : null;
		if (rawUrlPrefix !== null) return rawUrlPrefix;

		const trailing = stripTrailingSourceList(text, sources as TrailingSourceListSource[], {
			grounded,
		});
		const trailingPrefix = trailing.flagged ? recoverCleanPrefix(text, trailing.cleaned) : null;
		if (trailingPrefix !== null) return trailingPrefix;

		const titleDump = stripTrailingTitleDump(text, sources as TrailingSourceListSource[], {
			grounded,
		});
		const titleDumpPrefix = titleDump.flagged ? recoverCleanPrefix(text, titleDump.cleaned) : null;
		if (titleDumpPrefix !== null) return titleDumpPrefix;

		return null;
	};

	let sourceTail = "";
	let withholdingSourceTail = false;

	const releaseCleaned = function* (cleaned: string): Generator<MessageUpdate> {
		if (!cleaned) return;
		if (withholdingSourceTail) {
			sourceTail += cleaned;
			return;
		}
		const candidate = released + cleaned;
		const cleanPrefix = timedPass("sourceGuardCleanPrefix", candidate, () => sourceGuardCleanPrefix(candidate));
		// A written tool tag or a run of backticks and closers (CUR-3302): release nothing from its start
		// on. The end-of-stream trim cuts the cascade; held here, the visitor never watches it type out.
		const runaway = timedPass("markupRunawayStart", candidate, () => markupRunawayStart(candidate));
		// Stryker disable next-line ConditionalExpression,EqualityOperator: the ungrounded guard refuses to strip text still holding a run, so no test reaches a guard prefix ahead of one; kept so a guard that can never streams past a run
		if (runaway !== null && (cleanPrefix === null || runaway <= cleanPrefix.length)) {
			const keep = Math.max(runaway, released.length);
			const delta = candidate.slice(released.length, keep);
			released = candidate.slice(0, keep);
			sourceTail = candidate.slice(keep);
			withholdingSourceTail = true;
			// Stryker disable next-line ConditionalExpression: yielding an empty token changes nothing a reader sees
			if (delta) yield { type: MessageUpdateType.Stream, token: delta };
			return;
		}
		if (
			cleanPrefix !== null &&
			cleanPrefix.length >= released.length &&
			cleanPrefix.length < candidate.length
		) {
			const delta = cleanPrefix.slice(released.length);
			released = cleanPrefix;
			sourceTail = candidate.slice(cleanPrefix.length);
			withholdingSourceTail = true;
			if (delta) yield { type: MessageUpdateType.Stream, token: delta };
			return;
		}
		if (cleanPrefix !== null && released.trimEnd() === cleanPrefix) {
			sourceTail = candidate.slice(released.length);
			withholdingSourceTail = true;
			return;
		}
		released = candidate;
		yield { type: MessageUpdateType.Stream, token: cleaned };
	};

	const inCrisisAnswer = (text: string) => Boolean(opts.crisisSupport?.()) || namesOurCrisisResource(text);

	// Set once the answer's first 988 has been seen (crisisReferralOrder.ts): only that one decides.
	let crisisOrderDecided = false;

	const processBatch = async (raw: string): Promise<string> => {
		if (!raw.trim()) return raw;
		let text = raw;

		if (grounded) {
			const hedge = await detectRecencyHedgeSemantic(text);
			// A batch that IS the hedge (bailedWholeAnswer — no substance survives, citation markers
			// don't count, per hedgeGuard's marker-aware rule) contributes NOTHING, not the bare
			// keptText remainder — otherwise a fully-hedge batch would still stream its stray "[1] [2]".
			if (hedge.hedged) text = hedge.bailedWholeAnswer ? "" : hedge.keptText;

			const dangling = stripDanglingCitations(text, visitorCount + sourceCount);
			if (dangling.stripped) text = dangling.cleaned;

			const labels = verifyCitationLabels(text, sources as CitationLabelSource[], visitorCount);
			if (labels.flagged) {
				text = labels.cleaned;
				labelCount += labels.count;
			}
		}

		// The first crisis-line 988 decides, once per answer, whether findahelpline.com and 112
		// go ahead of it. Runs before the URL check so the inserted link is judged like any other. (CUR-2136)
		if (!crisisOrderDecided) {
			// The person's language is awaited only for a batch that may hold the first 988 (CUR-4061).
			// Stryker disable next-line StringLiteral: with no 988 in the batch the language is never read.
			const lang = /988/.test(text) ? await (opts.noticeLanguage ?? Promise.resolve("en" as const)) : "en";
			const order = leadWithEuropeanLine(text, released, lang);
			crisisOrderDecided = order.decided;
			if (order.inserted && flagEnabledOr(CRISIS_REFERRAL_ORDER_FLAG, () => true)) {
				text = order.cleaned;
				logger.info("[crisis-order] put findahelpline.com and 112 ahead of 988");
			}
		}

		// A findahelpline.com the model wrote as a bare domain renders as plain text. Chunks end
		// at sentence punctuation followed by whitespace, so the domain never splits across two batches. (CUR-3909)
		const helpline = linkBareHelpline(text);
		if (helpline.linked && flagEnabledOr(CRISIS_REFERRAL_ORDER_FLAG, () => true)) text = helpline.cleaned;

		// In a crisis answer, a phone number other than 112, 988, the visitor's own emergency
		// number or a sourced national line for their country (CUR-4122) is one the model recalled, and
		// small models recall them wrong. It becomes a findahelpline
		// link. The end-of-stream pass below catches a number released before the answer named a resource. (CUR-4061)
		if (inCrisisAnswer(released + text) && flagEnabledOr(CRISIS_REFERRAL_ORDER_FLAG, () => true)) {
			const numbers = guardHelplineNumbers(text, opts.helplineCountry, opts.namedHelplineCountry?.());
			if (numbers.replaced) {
				text = numbers.cleaned;
				logger.warn({ replaced: numbers.numbers.length }, "[crisis-order] replaced a model-written helpline number");
			}
		}

		// Flag fabricated URLs so the mark STREAMS with the text (per-chunk correctness). The notice COUNT is
		// NOT tallied here — it's derived once from the final body below (markedUrlsIn), so a link a later
		// end-of-stream strip removes can't leave an orphaned "N links (? above)" pointing at a missing mark.
		const urlRes = detectFabricatedUrls(text, { grounded, allowedUrls });
		if (urlRes.flagged) text = urlRes.cleaned;

		const dehy = dehyphenateOpenSource(text);
		if (dehy.rewritten) text = dehy.cleaned;

		// detectFabricatedSources' disclaimer-strip and stripUnbackedSourceClaims are NOT run here — both
		// return the ORIGINAL text (their own safety floor, calibrated for a whole answer: "never gut more
		// than N%/24 chars") whenever the ENTIRE batch is just the flagged sentence, since removing 100% of
		// a tiny batch always looks like over-stripping to a floor sized for a full answer, so per-batch
		// application never fires on a batch that is purely a fabricated-source promise. Both run once at end-of-stream instead, where they have real context.
		return text;
	};

	for await (const event of source) {
		if (event.type === MessageUpdateType.FinalAnswer) {
			// Hold it — the reconciled FinalAnswer is composed once the tail clears, below.
			sawFinalAnswer = true;
			finalInterrupted = event.interrupted;
			finalTruncated = Boolean(event.truncated);
			sourceFinalText = typeof event.text === "string" ? event.text : "";
			finalDeclineText = event.declineText;
			finalDeclineNotice = event.declineNotice;
			continue;
		}
		if (opts.sourcesFromStream && event.type === MessageUpdateType.Rag) {
			streamRag = event.sources.map((s) => ({ n: s.n, title: s.title, url: s.url }));
			adoptStreamSources();
		}
		if (opts.sourcesFromStream && event.type === MessageUpdateType.WebSearch) {
			streamWeb = event.sources.map((s) => ({ n: s.n, title: s.title, url: s.url }));
			adoptStreamSources();
		}
		if (event.type !== MessageUpdateType.Stream) {
			yield event;
			continue;
		}
		anyStreamTokenSeen = true;
		rawStreamedLen += event.token.length;
		buffer += event.token;
		let chunk: string | null;
		while ((chunk = nextChunk(buffer, MAX_CHUNK_CHARS)) !== null) {
			buffer = buffer.slice(chunk.length);
			const cleaned = await processBatch(chunk);
			yield* releaseCleaned(cleaned);
		}
	}

	// Flush a genuinely incomplete tail (no terminal punctuation) regardless of whether a
	// FinalAnswer arrived — this is still real, generated content that needs the same correction.
	if (buffer.trim()) {
		const cleaned = await processBatch(buffer);
		yield* releaseCleaned(cleaned);
	}

	if (!sawFinalAnswer) return;

	// Every other producer streams its content as Stream tokens first and the FinalAnswer that
	// follows is redundant, which is why this module always rebuilds `finalText` from `released`
	// (the per-chunk CORRECTED text) and otherwise ignores the source's own FinalAnswer.text — using
	// the raw text instead would silently undo the hedge/citation/URL corrections already applied. For
	// a normal producer, sourceFinalText.length never exceeds rawStreamedLen (the FinalAnswer just
	// echoes what already streamed, in full, possibly reduced further by per-chunk correction).
	//
	// screenOutputStream's guard-primary output block breaks that invariant: its whole-answer withhold
	// (screenStream.ts's `released.trim()` empty branch) composes a FinalAnswer with real decline text
	// and sends NO Stream event at all (rawStreamedLen stays 0), and its mid-stream truncate branch
	// appends a notice to the FinalAnswer.text that likewise never streams as a token (sourceFinalText
	// grows past rawStreamedLen by exactly the notice's length). Both are the SAME shape: content past
	// byte rawStreamedLen in sourceFinalText that this loop never had a chance to see, let alone
	// correct — recover exactly that tail, appended after whatever was already released and corrected,
	// never used to replace it. A length comparison (not a string-prefix match against the corrected
	// `released`) is what makes this safe: per-chunk correction can shrink `released` well below
	// rawStreamedLen even for a normal answer (a hedge sentence stripped to nothing, CUR-1157's own
	// case below) without that ever counting as "unseen" content.
	//
	// `!finalDeclineNotice && !finalDeclineText` (CUR-946): a moderation carrier's `sourceFinalText`
	// legitimately grows past `rawStreamedLen` too (a mid-stream notice appends its own text past the
	// streamed prefix, a full block sends none of its text as tokens at all), but that tail is the
	// out-of-band copy CUR-946 deliberately withholds from `text`, not unseen model content to restore.
	// Recovering it here would silently re-merge the notice into `released`, defeating the whole point
	// of carrying it separately for the route to resolve.
	if (sourceFinalText.length > rawStreamedLen && !finalDeclineNotice && !finalDeclineText) {
		released += sourceFinalText.slice(rawStreamedLen);
	}

	// Full output-moderation block (CUR-946): forward the reviewed decline UNRESOLVED and stop. text:""
	// (never finalDeclineText) so no downstream stream pass can rewrite the copy even
	// transiently; the route swaps it in. Short-circuits onGroundedBail (no second generation),
	// detectFabricatedSources, every source/title/URL strip, measureDegeneration, and onNotice — none of
	// which apply to curated safety copy.
	if (finalDeclineText) {
		yield {
			type: MessageUpdateType.FinalAnswer,
			text: "",
			interrupted: finalInterrupted,
			declineText: finalDeclineText,
		};
		return;
	}

	let finalText = released + sourceTail;
	// Set when a fully-hedged answer is REPLACED — either by an ungrounded regen (CUR-148: the model's
	// own training-data answer, when it has one) or, failing that, by buildGroundedHedgeReplacement's
	// sources pointer. Either replacement is a known-good construction, not a model-appended duplicate
	// of a SourceStrip rendered separately, so the trailing-source-list strip below must NOT run on it.
	let bailedToFallback = false;
	// `!finalDeclineNotice` (CUR-946): a mid-stream moderation block must NOT regenerate. onGroundedBail
	// runs a real second model generation + a second output screen and can overwrite message.outputModeration
	// — regenerating an answer only to append a "we stopped this" notice after it is self-contradictory.
	// The deterministic source/title strips below stay UNGUARDED: they are pure text checks on the real
	// prefix with no regeneration. On a normal turn finalDeclineNotice is undefined, so behavior is unchanged.
	if (grounded && !finalDeclineNotice) {
		// Deterministic whole-answer test FIRST, directly on the assembled (already per-chunk
		// hedge-stripped) text: per-chunk stripping already reduces a fully-hedge batch to nothing (see
		// processBatch above), so by the time every batch is in, "no substance survives" is decidable
		// without re-deriving it from a semantic call — running detectRecencyHedgeSemantic("") or on a
		// bare "[1] [2]" remainder can't tell us anything (nothing left to classify). Same citation-
		// marker-aware test as hedgeGuard's own bailedWholeAnswer.
		//
		// `anyStreamTokenSeen || !finalInterrupted` gates this: empty-after-stripping is genuinely
		// ambiguous between "the model streamed a real hedge sentence that stripped down to nothing"
		// (this branch's intended target — anyStreamTokenSeen is true) and "the generation watchdog
		// killed the call before a single token arrived" (a dead backend, not a hedge — no Stream event
		// ever fired AND the raw generation reported interrupted). A turn where the gateway times out after
		// 45s with zero tokens (`firstTokenReached: false`) would otherwise be dressed up as a calm
		// `groundedHedgeReplacement` sources-pointer, indistinguishable from a polite decline. A real failure should
		// surface as the honest interrupted/error state, never as a fabricated-looking hedge.
		if (
			(anyStreamTokenSeen || !finalInterrupted) &&
			!hasSubstantiveText(finalText)
		) {
			const before = finalText;
			const regen = await opts.onGroundedBail?.();
			// A content check alone isn't enough — a hedge sentence has plenty of alphanumeric characters
			// ("I still don't have access to real-time information" is 50 real characters and zero
			// substance). Strip hedge sentences the same way per-chunk processing already does, and only
			// accept the regen if genuine content survives — the SAME "no alphanumeric after removing
			// hedges" test bailedWholeAnswer applies above, now applied to the regen's own output so a
			// second hedge can't slip through as if it were a real answer.
			const regenSubstance = regen
				? splitSentences(regen)
						.filter((s) => !isHedgeSentence(s))
						.join(" ")
				: "";
			const regenUsable = regen && hasSubstantiveText(regenSubstance);
			if (regenUsable) {
				// Ship the hedge-pruned substance, not the raw regen — any hedge sentence it also produced
				// (e.g. a stray "I don't have real-time information" beside a real answer) gets removed the
				// same way any other answer's would. This text carries no retrieved backing either (it's a
				// fresh, ungrounded generation), so it also needs the unbacked-citation stripper the
				// `!grounded` branch below would otherwise apply — that branch is gated on the ORIGINAL
				// turn's grounding, which is true here even though this specific answer isn't. sourceCount 0:
				// no citation index is legitimate on ungrounded text, even one that happens to echo a `[n]`
				// from the sources it didn't end up using.
				const unbacked = stripUnbackedSourceClaims(regenSubstance, 0, visitorCount);
				finalText = unbacked.stripped ? unbacked.cleaned : regenSubstance;
				recordFinalMutation("groundedHedgeUngroundedRegen", before, finalText);
			} else {
				finalText = buildGroundedHedgeReplacement(
					sources.map((s): CitableSource => ({ n: s.n, title: s.title })),
					await (opts.messageLanguage ?? Promise.resolve(undefined))
				);
				recordFinalMutation("groundedHedgeReplacement", before, finalText);
			}
			bailedToFallback = true;
			// finalInterrupted above still holds whatever the RAW upstream generation
			// reported, from before this replacement — generate.ts's stop-token heuristic can flag a
			// genuinely complete turn as interrupted, and that stale flag would carry through to the
			// finished, deliberate text below it. Both branches just built a complete, honest answer
			// (a real regen or the sources pointer), never a cut-off stream — force it false here. (CUR-1157)
			finalInterrupted = false;
		}
	}

	// An answer that opens with the fenced turn's preamble is our own prompt read back, often
	// to the length cap, so it is never shipped. Ask the turn once more; a retry that recites too, or
	// fails, gives way to a fixed notice. Not on a moderation-stopped turn, which must not regenerate
	// (the same rule as the grounded bail above). (CUR-3886)
	if (!finalDeclineNotice && opensWithFencePreamble(finalText)) {
		const before = finalText;
		const regen = await opts.onRecital?.();
		if (regen && /[\p{L}\p{N}]/u.test(regen) && !opensWithFencePreamble(regen)) {
			finalText = regen;
			recordFinalMutation("recitalRegen", before, finalText);
		} else {
			finalText = RECITAL_FALLBACK_MESSAGE;
			// Stryker disable next-line BooleanLiteral: the fixed notice holds no URL or source list, so the grounded passes this skips would change nothing today; it is set so a later pass never edits our own text.
			bailedToFallback = true;
			recordFinalMutation("recitalReplacement", before, finalText);
		}
		finalInterrupted = false;
	}

	// Disclaimer-strip (all turns) + trailing "Sources:"-heading-to-EOF trim (grounded turns only, via
	// its own opts.grounded gate) — deferred from processBatch, see the comment there for why.
	noteLongAnswer(finalText);
	const src = timedPass("detectFabricatedSources", finalText, () => detectFabricatedSources(finalText, { grounded }));
	if (src.flagged) {
		const before = finalText;
		sourceRemovedChars += finalText.length - src.cleaned.length;
		finalText = src.cleaned;
		recordFinalMutation("fabricatedSources", before, finalText);
	}
	// Body reproductions of the retrieved source list (grounded only) — the model appended them despite
	// the grounding prompt forbidding it, and the real sources render separately in SourceStrip.
	// ORDER MATTERS: strip the raw-URL dump FIRST, because removing "…complete. https://a [1] https://b
	// [2] [1] Title [2] Title" exposes a clean trailing "[1] Title [2] Title" list that only the title
	// guard can then catch (the title guard, run first, would bail — its pre-list head ends on a URL
	// marker, not terminal prose). Running URL→title never has the reverse dependency (URL detection
	// doesn't depend on titles), so one pass each in this order converges. End-of-stream only — a
	// trailing dump is only decidable once nothing more follows.
	if (grounded && !bailedToFallback) {
		// Raw source-URL dump: bare autolinked source URLs in the body ("https://espn… [1] https://reddit…
		// [3] …"). detectFabricatedUrls keeps source URLs clickable (correct for a lone inline link, wrong
		// for a dump), so this removes a run of ≥2.
		const rawUrls = timedPass("stripRawSourceUrls", finalText, () => stripRawSourceUrls(finalText, sources, { grounded }));
		if (rawUrls.flagged) {
			const before = finalText;
			sourceRemovedChars += finalText.length - rawUrls.cleaned.length;
			finalText = rawUrls.cleaned;
			recordFinalMutation("rawSourceUrls", before, finalText);
		}
		// Heading-less trailing "[1] Title [2] Title" list: no "Sources:" heading, so
		// detectFabricatedSources' heading-trim missed it and addInlineCitations rendered it as one inline
		// run glued to the last paragraph. Matched against the retrieved titles, so a real numbered
		// enumeration is never cut.
		const trailing = timedPass("stripTrailingSourceList", finalText, () =>
			stripTrailingSourceList(finalText, sources as TrailingSourceListSource[], { grounded })
		);
		if (trailing.flagged) {
			const before = finalText;
			sourceRemovedChars += finalText.length - trailing.cleaned.length;
			finalText = trailing.cleaned;
			recordFinalMutation("trailingSourceList", before, finalText);
		}
		// Marker-optional variant: the model ran the retrieved TITLES together with at most one leading
		// marker ("…tech. [1] FIFA World Cup 2026 – Wikipedia  IPCC Sixth Assessment Report – IPCC …").
		// Matched against the retrieved titles, so ordinary prose that names a source is never cut.
		const titleDump = timedPass("stripTrailingTitleDump", finalText, () =>
			stripTrailingTitleDump(finalText, sources as TrailingSourceListSource[], { grounded })
		);
		if (titleDump.flagged) {
			const before = finalText;
			sourceRemovedChars += finalText.length - titleDump.cleaned.length;
			finalText = titleDump.cleaned;
			recordFinalMutation("trailingTitleDump", before, finalText);
		}
	}
	// Groundcheck (CUR-2467): last of the grounded passes, so it reads the answer the source strips left.
	// Not on a bail replacement (known-good text), a mid-stream decline, or a cut-off answer.
	// Unbacked-citation guard (ungrounded turns only — stands down at sourceCount>0) — same deferral.
	if (!grounded) {
		const unbacked = timedPass("stripUnbackedSourceClaims", finalText, () =>
			stripUnbackedSourceClaims(finalText, sourceCount, visitorCount)
		);
		if (unbacked.stripped) {
			const before = finalText;
			sourceRemovedChars += finalText.length - unbacked.cleaned.length;
			finalText = unbacked.cleaned;
			recordFinalMutation("unbackedSourceClaims", before, finalText);
		}
	}

	// Reconcile the URL notice to the marks that ACTUALLY SURVIVE in finalText. urlCount/urls were tallied
	// per-batch as links were flagged during streaming, but the end-of-stream source-strips above can remove
	// a flagged link after it was counted (a fabricated URL inside a trailing "Sources:" block, a stripped
	// title dump, …). Emitting the raw tally would make the UrlNotice chip claim "N links marked (? above)"
	// pointing at a "?" no longer in the body. Deriving the count from the final body makes the footer honest by construction: it can only
	// ever announce marks that render (and when none survive, urlCount is 0 → no notice fires at all).
	// Structural-collapse probe (CUR-149). OBSERVE ONLY — the answer is not touched. A turn that
	// spends its time emitting `\boxed{\mathbf{ }}` and stops mid-token would log `outcome: complete`
	// and be indistinguishable from a good answer; this is the line that tells them apart. Whether a
	// tripped probe should replace the text is a product decision with a real cost when it misfires,
	// and it is not made here.
	//
	// `symbolRatio` rides along on the warn precisely because it is NOT the trigger: the metric the
	// ticket originally specified cannot separate a wreck from a quadratic-formula derivation (see
	// degeneration.ts). Logging it makes the real distribution queryable, so if it ever does separate
	// on production traffic the threshold can be set from that rather than from two fixtures.
	// A run of closing brackets nothing opened, after the last word (CUR-2882). Unlike the probe below,
	// this one trims: the tail holds no letter or digit, so nothing a reader needs goes with it.
	// Stryker disable next-line ArrowFunction: Stryker's run completes 0 tests on this mutant (CUR-3749); applied by hand it fails 15+ honestyStream specs
	const closerRun = timedPass("stripTrailingCloserRun", finalText, () => stripTrailingCloserRun(finalText));
	if (closerRun.flagged) {
		logger.warn(
			{ unmatched: closerRun.unmatched, removedChars: finalText.length - closerRun.cleaned.length },
			"[honesty] answer ended in a run of unmatched closing brackets — trimmed"
		);
		const before = finalText;
		finalText = closerRun.cleaned;
		recordFinalMutation("trailingCloserRun", before, finalText);
	}
	// Our own <document> wrapper echoed after the answer, with markup run on after it that holds
	// letters (`./cite]` repeated), so the closer trim above cannot see it (CUR-2882).
	// Stryker disable next-line ArrowFunction: Stryker's run completes 0 tests on this mutant (CUR-3749); `echoed.flagged` then throws, which every honestyStream spec turn reaches
	const echoed = timedPass("stripEchoedWrapperTail", finalText, () => stripEchoedWrapperTail(finalText));
	if (echoed.flagged) {
		logger.warn(
			{ removedChars: finalText.length - echoed.cleaned.length },
			"[honesty] answer ended in our echoed document wrapper and markup after it — trimmed"
		);
		const before = finalText;
		finalText = echoed.cleaned;
		recordFinalMutation("echoedWrapperTail", before, finalText);
	}
	// A Hermes tool-call tag written as text, and a long run of backticks and closers with apologies
	// and restarts after it, to the length limit (CUR-3302). Everything from the first run on is that
	// cascade, so it goes; the answer before it stays.
	const runaway = timedPass("stripMarkupRunaway", finalText, () => stripMarkupRunaway(finalText));
	if (runaway.flagged) {
		logger.warn(
			{ removedChars: finalText.length - runaway.cleaned.length },
			"[honesty] answer held a written tool-call tag or a run of backticks and closers — trimmed"
		);
		const before = finalText;
		finalText = runaway.cleaned;
		recordFinalMutation("markupRunaway", before, finalText);
	}

	const degen = timedPass("measureDegeneration", finalText, () => measureDegeneration(finalText));
	if (degen.degenerate) {
		logger.warn(
			{ emptyGroups: degen.emptyGroups, symbolRatio: degen.symbolRatio, chars: degen.chars },
			"[honesty] degenerate answer: markup groups with no content — the model lost the thread"
		);
	}

	// Repeated-clause collapse probe (CUR-1104). Unlike degen above, THIS one replaces the answer when
	// it fires — repetitionGuardEnabled() defaults off pending exactly the live verification pass that
	// gate exists for. Known, accepted tradeoff when it does fire: every other guard in this file
	// corrects PER-CHUNK specifically to avoid "the client's rendered answer visibly snaps to something
	// different from what it just watched type out" (this file's own header) — a
	// repetition loop can only be told apart from a real answer once the model stops, so this one is
	// necessarily end-of-stream-only and pays that same snap. Judged worth it here because the
	// alternative is leaving an obviously broken, useless answer on screen permanently; not because the
	// snap itself got any less real.
	const repetition = repetitionGuardEnabled()
		? timedPass("detectDegenerateRepetition", finalText, () => detectDegenerateRepetition(finalText))
		: null;
	if (repetition?.repeated) {
		logger.warn(
			{ ngram: repetition.ngram, count: repetition.count },
			"[honesty] degenerate answer: stuck repeating the same clause — replacing with an honest notice"
		);
		const before = finalText;
		finalText = repetitionNotice(await (opts.noticeLanguage ?? Promise.resolve("en" as const)));
		recordFinalMutation("degenerateRepetition", before, finalText);
	}

	// CUR-4061, whole answer: a number streamed before the answer first named findahelpline, 112 or 988
	// passed the per-batch check. The persisted answer still loses it, and the client snaps to this text.
	// A short answer can finish before the support classifier stamps the turn. The stamp only matters when
	// the answer holds a number the guard would replace, so only then does this wait for the verdict
	// (bounded by the classifier's 4 s timeout); every other answer finishes at once. A named country only
	// adds kept numbers, so checking without it finds every number the full check could replace.
	const crisisGuardOn = flagEnabledOr(CRISIS_REFERRAL_ORDER_FLAG, () => true);
	// Stryker disable next-line ConditionalExpression,LogicalOperator: a stamped turn's batches end at sentence punctuation, so the per-batch guard has already replaced every number and this check is false either way.
	if (crisisGuardOn && !inCrisisAnswer(finalText) && guardHelplineNumbers(finalText, opts.helplineCountry).replaced) {
		await opts.crisisSupportSettled?.().catch(() => {});
	}
	if (crisisGuardOn && inCrisisAnswer(finalText)) {
		const numbers = guardHelplineNumbers(finalText, opts.helplineCountry, opts.namedHelplineCountry?.());
		if (numbers.replaced) {
			logger.warn({ replaced: numbers.numbers.length }, "[crisis-order] replaced a model-written helpline number at end of stream");
			const before = finalText;
			finalText = numbers.cleaned;
			recordFinalMutation("helplineNumber", before, finalText);
		}
	}

	const survivingMarkedUrls = markedUrlsIn(finalText);
	opts.onNotice?.({
		labelCount,
		urlCount: survivingMarkedUrls.length,
		urls: survivingMarkedUrls,
		sourceRemovedChars,
		finalMutations,
	});
	if (!finalText.startsWith(released) && released.trimEnd() === finalText) {
		finalText = released;
	}
	if (finalText.startsWith(released)) {
		const delta = finalText.slice(released.length);
		if (delta) {
			released = finalText;
			yield { type: MessageUpdateType.Stream, token: delta };
		}
	}
	yield {
		type: MessageUpdateType.FinalAnswer,
		text: finalText,
		interrupted: finalInterrupted,
		...(finalTruncated ? { truncated: true } : {}),
		// Forward the mid-stream notice UNRESOLVED — finalText here is the guard-processed prefix; the
		// route appends the notice once, in its FinalAnswer loop, after every later stage has seen that
		// prefix (CUR-946).
		...(finalDeclineNotice ? { declineNotice: finalDeclineNotice } : {}),
	};
}
