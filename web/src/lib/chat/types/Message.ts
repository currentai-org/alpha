import type { InferenceProvider } from "@huggingface/inference";
import type {
	FailoverCause,
	FailoverReason,
	FixedReplyKind,
	MessageUpdate,
	ModerationKind,
	UnrunCodeReason,
} from "./MessageUpdate";
import type { Timestamps } from "./Timestamps";
import type { SearchSource } from "./Search";
import type { RagSource } from "./Rag";
import type { MessageTimings } from "./MessageTimings";
import type { RungStep } from "./Rungs";

export type Message = Partial<Timestamps> & {
	from: "user" | "assistant" | "system";
	// uuid's v4() is overloaded (string vs Uint8Array-buf variant); every call site here uses the
	// no-args form, so pin the id type to string directly rather than via ReturnType<typeof v4>,
	// which resolves to the LAST overload (the Uint8Array one) instead of the one actually used.
	id: string;
	content: string;
	/** The OAuth client_id of the sync client that wrote this message (config/thunderbolt.ts), (CUR-4312)
	 *  absent for one written in Alpha. Set only by /chat/api/v2/sync/push, never from a turn's input. */
	origin?: string;
	/** The id the sync client pushed this message under, for its idempotent re-push. (CUR-4312) */
	syncClientId?: string;
	updates?: MessageUpdate[];

	// Optional server or client-side reasoning content (<think> blocks)
	reasoning?: string;
	score?: -1 | 0 | 1;
	/**
	 * Either contains the base64 encoded image data
	 * or the hash of the file stored on the server
	 **/
	files?: MessageFile[];
	interrupted?: boolean;

	// TRANSIENT, client-render-only — deliberately NOT persisted (no JSONB column).
	// Set when the time-to-first-token watchdog fell back to a pre-vetted starter
	// answer because the live request never reached the server (poor connectivity:
	// request lost before egress). Drives an honesty chip in ChatMessage. It must
	// stay transient: a reloaded conversation re-fetches live and is no longer
	// cache-served, so persisting it would misreport provenance on reload.
	servedFromCache?: boolean;

	// Real turn-relative wall-clock timings (from promptedAt = request start), the only latency we
	// actually measure. Persisted so the request-trace timing survives reload; absent on cache/declined
	// turns. `ttftMs`/`totalMs` are the cumulative anchors; the rest is a full phase decomposition
	// (safety gate, RAG incl. SyftHub stages, generation pre-passes, the dual first-token stamp, and
	// output screening) so the slow phase is queryable from the DB/trace forever, with no dependence on
	// tailing ephemeral platform logs. See $lib/chat/types/MessageTimings.
	timings?: MessageTimings;

	// What each forced-tool-call pre-pass decided on this turn (gate verdict, exit code, ms,
	// number count). Codes and counts only, never user text. Absent on turns persisted before it shipped. (CUR-2043)
	rungs?: RungStep[];

	// Router metadata when using llm-router
	routerMetadata?: {
		route: string;
		model: string;
		provider?: InferenceProvider;
		backend?: string;
		// The host the request was sent to. Absent on messages persisted before it shipped. (CUR-3193)
		lane?: string;
		// The Vercel region of the app server that ran the turn (`VERCEL_REGION`, e.g. "fra1").
		// Absent off Vercel and on messages persisted before it shipped. (CUR-4580)
		appRegion?: string;
		// agent-service's verify tier — "" (unverified) | "execution" | "judge" |
		// "execution+judge". Absent on non-agent routes and on messages persisted before this shipped. (CUR-756)
		verifyMethod?: string;
		// The other models that worked on this turn without writing it, one entry per role.
		// Absent when none ran or the provenance-assisted-by flag is off. (CUR-984)
		assistedBy?: AssistedBy[];
		// The language the answer was asked for by name, for a model measured to drift out of
		// it (Apertus and Hausa). Absent when no language was named. (CUR-2237)
		answerLanguage?: string;
	};

	// Open-web search provenance: when the user grounded this answer on an open
	// search, the numbered sources the model was told to cite. Persisted via JSONB
	// so the citations strip + map highlight survive reload. `evidence` (the raw
	// grounding block) is server-only and deliberately NOT stored here.
	webSearch?: {
		query: string;
		sources: SearchSource[];
		asOf: string;
	};

	// Search-attempted-but-ungrounded advisory: set whenever the open-web search path was engaged
	// for this turn (webSearchPlan said "run" or "auto-gate" — the live request log showed
	// "Searching the open web…") but the turn never ended up grounded — so no `webSearch` stamp
	// exists. Without this the trace silently falls back to "from training" with no record a search
	// was ever considered, even though the user watched it happen live. Two distinct sub-cases share
	// this marker (see `searched`): the margin gate can decline to even round-trip to the open
	// engines, OR a round-trip can run and still fail to clear the relevance bar. The honest
	// invariant: `searchAttempt` and `webSearch` are mutually exclusive — a turn either grounds
	// (webSearch) or records an ungrounded attempt (searchAttempt), never both, and neither when the
	// search path was never engaged at all (community sufficed, mode was "off", or an unservable-live
	// query). Persisted via JSONB so it survives reload, mirroring webSearch above.
	searchAttempt?: {
		grounded: false;
		// true = an actual round-trip to the open engines ran (runWebSearch) but no result cleared
		// the relevance bar. false = the margin gate considered searching and decided against it, so
		// no engines were ever queried — a lighter-weight non-event than a real, failed search.
		searched: boolean;
		// The search ran and did not finish: it passed its deadline ("timeout") or threw
		// ("error"). The answer was written without web sources, and the note under it says so. (CUR-4091)
		failed?: "timeout" | "error";
	};

	// RAG-store provenance: catalog + federated retrieval for this turn. Persisted via
	// JSONB so the provenance trace + map highlight survive reload. `evidence` (the raw
	// grounding block) is server-only and deliberately NOT stored here. Vault synthesis
	// is stored separately — it is attributed federated knowledge, not a citable doc.
	rag?: {
		query: string;
		sources: RagSource[];
		asOf: string;
		vaultSynthesis?: string;
	};

	// Open-component (MCP) provenance: an open HF Space tool ran for this turn (e.g. TTS, image gen).
	// Persisted via JSONB so the provenance trace reads "open component · <tool>" — not "from training" —
	// after reload. Just the tool name: the produced media rides on `files`/the answer body, not here.
	mcp?: {
		tool: string;
		/** Origin of the Space that ran (for the "see the component" link in the provenance trace). */
		space?: string;
		/** The produced audio clip's URL (TTS), used to autoplay reliably off-DOM. */
		audio?: string;
		/** A tool was attempted but the open Space didn't respond in time (cold start) so we answered
		 *  without it — recorded so the trace can say so honestly instead of the skip being invisible.
		 *  `skipMs` is how long we waited before giving up. Persisted via JSONB so it survives reload. */
		skipped?: boolean;
		skipMs?: number;
		/** With `skipped`: the tool answered with an error (CUR-2645) instead of timing out. */
		failed?: boolean;
		/** With `skipped`: read-aloud has no voice for the answer's language (CUR-3151). */
		unsupportedLanguage?: string;
		/** With `unsupportedLanguage`: the English-voice clip, played only on the visitor's request (CUR-3989). */
		fallbackAudio?: string;
		/** With `audio`: the voice's accent when the language has regional variants (CUR-3989). */
		voice?: string;
	};

	// Write-permission provenance (agent turns only, CUR-471): set when the agent service resolved this
	// caller to deny_writes for the task — most commonly a `staged`-mode account still accruing trust.
	// Its presence is what lets the UI explain a silently-missing terminal/code_execution capability:
	// CUR-217's tool-effect gating removes those tools from the toolset before the session starts
	// rather than denying the call, so there is no tool_result frame to narrate a refusal from.
	// Persisted via JSONB so the explanation survives reload, mirroring mcp above. Absent whenever the
	// caller had full write access — see writePolicyProvenance for the "only stamp when it explains
	// something" contract (mirrors rag/mcp/webSearch).
	writePolicy?: {
		policy: "deny_writes";
		tier: "uniform" | "new" | "trusted";
		tasksDone?: number | null;
		tasksRequired?: number | null;
	};

	// Agent tool-execution provenance: set when the agent endpoint's ACP tool-call stream observed at
	// least one real tool run this turn (write_file, terminal, code_execution, etc.). Its presence is
	// what lets a tool-running agent turn read "ran tools · <kinds>" instead of falling through to
	// "from training" — the grounding classifier (provenanceFacts.agentToolsRan) had no other signal for
	// agent-service tool execution before this field existed. Persisted via JSONB so the label survives
	// reload, mirroring mcp/writePolicy above. Absent whenever toolKinds was empty — see
	// agentToolsProvenance for the "only stamp when it's real" contract (mirrors mcp/writePolicy).
	// counts (CUR-775): per-kind call counts, optional so a message persisted before this field existed
	// still matches the type — see toolRunSummary.ts for how it renders.
	agentTools?: {
		toolKinds: string[];
		counts?: Record<string, number>;
	};

	// The agent-service task this turn ran as, and the Fly machine that holds it. The run keeps
	// going when the tab closes (agent-service ends only the event stream), so this is the handle a later
	// visit uses to re-attach to it or collect its result. (CUR-993)
	agentRun?: {
		taskId: string;
		machineId?: string;
		/** Nothing is left to re-attach to: the person pressed Stop, which cancels the task, or
		 *  agent-service no longer holds it. */
		closed?: boolean;
	};

	// The negative of agentTools above (CUR-1341): this turn's output is PREDICTED rather than measured —
	// the agent wrote code it never executed, claimed steps no tool frame backs, or agent-service's own
	// repair loop flagged the answer. Set from the same check that prepends UNRUN_CODE_NOTICE to the
	// answer text, so the reasoning panel's header and that sentence are driven by one value and cannot
	// contradict each other. Absent is the ordinary case and means nothing was flagged — NOT "nothing
	// ran", which is the CUR-234 ambiguity agentTools exists to avoid asserting. Persisted via JSONB so
	// the header still reads honestly after reload, mirroring agentTools/writePolicy above.
	unrunCode?: {
		reason: UnrunCodeReason;
	};

	// Agent confirmation gate (CUR-218): agent-service paused a tool call on ACP_PERMISSION_POLICY=confirm
	// and needs a human answer before it continues. An ARRAY, not a single stamp like writePolicy/mcp
	// above — one turn can pause more than once (each tool call under a live confirmation gate opens its
	// own), so entries accumulate as they open and get filled in in place as they resolve. `decision`/
	// `reason` are absent while a confirmation is still open — that absence IS the "show the Allow/Deny
	// UI" signal (ChatMessage renders live, not gated on `!loading`, since the whole point is to act on it
	// before the turn finishes). `taskId` lets the client's Allow/Deny click reach the right agent-service
	// task; `confirmId` names which of that task's paused calls. Persisted via JSONB so a reload shows the
	// full history of what this turn asked and how it was answered, mirroring agentTools/writePolicy above.
	agentConfirmations?: {
		taskId: string;
		confirmId: string;
		kind: string;
		title: string;
		summary: string;
		plain?: string;
		decision?: "allow" | "deny" | "canceled";
		reason?: string;
		// Epoch ms this confirmation auto-denies at, when agent-service's own confirm_timeout_secs
		// crossed the ACP boundary (see MessageAgentConfirmUpdate). Absent on an older/coarse build — the
		// prompt falls back to its old static "times out eventually" copy rather than a fabricated countdown. (CUR-1094)
		deadlineAt?: number;
		// "mcp" when this asked before an MCP tool ran; its answer goes to the elicitation route. (CUR-3026)
		channel?: "agent" | "mcp";
	}[];

	// Safety provenance: set when the proactive pre-screen (Coop content/child, or in-app
	// prompt-injection) declined this turn BEFORE the model ran. Its presence makes the answer
	// render as a safety decline — the "Apertus" provenance badge is suppressed (the model never
	// ran) and the live-stack map highlights the safety node instead. Persisted via JSONB so
	// the decline survives reload, mirroring webSearch above.
	// Stamped on EVERY non-cache turn now (not just declines): `flagged` drives the safety-decline
	// rendering as before, and `screened` records whether the pre-screen classifier actually RAN —
	// false means it failed open (no token / unreachable / timeout) and the turn was let through
	// unchecked. The request-trace needs this to avoid claiming a turn was "screened, clear" when the
	// classifier never ran (toxic-bert fails open). Absent `screened` (older rows) reads as "unknown".
	moderation?: {
		flagged: boolean;
		label: string | null;
		score: number;
		kind: ModerationKind;
		screened?: boolean;
		// Curated, public-safe name of the Coop rule that blocked this turn (resolved server-side from
		// the triggered action via $lib/chat/server/ruleLabel). Present ONLY when the rule has a reviewed label;
		// absent → the generic decline copy stands. This is the ONLY rule identity shown to the user — the
		// raw action code in `label` is never surfaced (see SafetyBadge / ProvenanceTrace / requestTrace).
		ruleLabel?: string;
		// The input screen could not run (fail-closed UNKNOWN): the turn was held back unchecked and
		// nothing was flagged. The badge reads "not checked" rather than naming a classifier (CUR-2301).
		unscreened?: boolean;
		// A self-harm rule declined this turn, so it carries crisis support: the Support resources card
		// shows with it whatever words tripped the rule (CUR-2111).
		support?: boolean;
		// The language the support classifier read the message as, a BCP-47 primary subtag ("fr") (CUR-4093).
		// The support card renders its copy in it when the catalogs carry it (CUR-4094), and the neutral
		// sidebar title is written in it (CUR-4095).
		supportLang?: string;
		// The country the support classifier read the message as placing the person at risk in, a
		// lower-case code findahelpline has a page for (CUR-4488). The card and the helpline number guard
		// prefer it to the visitor's IP country.
		supportCountry?: string;
	};

	// OUTPUT moderation (defense-in-depth, opt-in via OUTPUT_MODERATION): the verdict of screening the
	// model's OWN answer AFTER generation, before it was shown — distinct from `moderation` above, which
	// screens the user's INPUT before the model runs. Same shape; `flagged` means the generated answer
	// was withheld (the model RAN — unlike an input decline where it never ran), `screened` records
	// whether the output classifier actually ran (false = failed open, answer shown unscreened). Absent
	// means output screening did not run this turn (flag off). The request-trace renders this as a second
	// "Output screen" step after the model; provenanceFacts derives `outputScreen` + `withheld` from it.
	outputModeration?: {
		flagged: boolean;
		label: string | null;
		score: number;
		kind: ModerationKind;
		screened?: boolean;
		// true = a clean PREFIX of the answer was already shown and the rest was withheld mid-stream
		// (chunked streaming screen), vs the whole answer held back. Lets the trace word it honestly.
		truncated?: boolean;
		// Curated, public-safe name of the Coop rule that withheld the answer (resolved server-side from
		// the triggered action). Mirrors `moderation.ruleLabel`; present only when the rule has a reviewed
		// label, absent → generic output-decline copy. The raw action code is never surfaced.
		ruleLabel?: string;
		// true = the guard could not answer, so the answer was withheld unchecked, not flagged (CUR-3891).
		unscreened?: boolean;
		// How many flagged batches the output re-check released (CUR-3975). Absent when none.
		rechecked?: number;
	};

	// Name-adoption correction: set when the post-generation guard ($lib/chat/server/nameGuard) detected
	// the model adopted a personal name for itself this turn. Its presence renders an honest "this
	// system has no name" chip beside the answer, and the strip neutralizes the name in later context
	// so it can't compound into a named companion over a session. Persisted via JSONB so the
	// correction survives reload, mirroring moderation/webSearch above.
	nameNotice?: {
		name?: string;
	};

	// Set when the server answered this turn with a fixed string and no model ran (the
	// low-resource-language notice, and the at-capacity notice, CUR-1872). The receipt then says that plainly, where it would otherwise say
	// "from training" and that nothing reported which model served it. Persisted via JSONB, mirroring
	// nameNotice above. Matching the notice's text instead would misfire: a model can repeat it verbatim. (CUR-1579)
	fixedReply?: {
		kind: FixedReplyKind;
	};

	// The picker was on Auto and Auto chose this answer's model. `model` is the catalog id,
	// `reasons` the chips and `explanation` the sentence the composer showed when it chose. Absent when
	// the person picked the model themselves. Persisted via JSONB, like calculations below. (CUR-3944)
	autoRoute?: {
		model: string;
		reasons: string[];
		explanation: string;
		/** The catalog id of Auto's first choice, when it was busy or silent and Auto picked again. (CUR-4384) */
		repickedFrom?: string;
	};

	// Every calculate call code evaluated for this answer, in order. Persisted so the
	// expressions stay under the answer after reload. `counts` is the group list the call wrote, which a
	// follow-up's replay sends back (CUR-1202); the UI does not show it. (CUR-2273)
	calculations?: {
		expression: string;
		result?: string;
		error?: string;
		counts?: string;
	}[];

	// The ledger code summed and rendered at the top of this answer. The rendered rows carry
	// no marker, so a later turn's planner reads the ledger from here rather than from the text. (CUR-3663)
	mathLedger?: {
		lines: { factors: number[]; label: string }[];
		unit?: string;
	};

	// Each call this turn made to an operator-configured MCP server, for the step-by-step
	// trace. Names, outcome and time; arguments and results only for the conversation's own sandbox
	// (CUR-4232), where they are the model's code and its output. (CUR-3026)
	mcpCalls?: {
		server: string;
		tool: string;
		outcome: string;
		ms: number;
		input?: string;
		output?: string;
	}[];

	// The model this turn asked for, stamped on the assistant message when the turn starts. The
	// footer's "(backup)" compares the served model against it, not against the conversation's current
	// model, which would mark every earlier answer as a backup after a mid-chat model switch. Absent on
	// older answers, which fall back to the conversation's model.
	requestedModel?: string;

	// Set when the primary model did not answer and a backup serving a different model did.
	// Persisted so the receipt still shows the attempt after reload; routerMetadata keeps only the model
	// that answered. (CUR-2239)
	failover?: {
		from: string;
		to: string;
		reason: FailoverReason;
		cause?: FailoverCause;
	};

	// Non-blocking safety advisory (Coop "notice" tier): set when the pre-screen flagged the turn for a
	// category that warrants a user-facing notice but NOT a decline. Unlike `moderation` (which replaces
	// the answer), the model still ran and answered — this rides alongside as an honest chip stating why
	// the turn was noticed. Persisted via JSONB so the notice survives reload, mirroring nameNotice above.
	// Inert today (checkAdvisory returns no notice); the field exists so a safety integration can
	// wire it with no client or type change. `message` is the reviewed user-facing
	// copy; the raw action/category code is never carried here (it stays server-side, like the
	// block path's auditCategory), honoring "raw action codes never reach the client".
	safetyNotice?: {
		message: string;
	};

	// The files sent with this turn were refused because they could not be scanned, so none
	// was stored. Persisted so the note survives reload, mirroring safetyNotice above. (CUR-2382)
	attachmentNotice?: {
		message: string;
	};

	// On a sent message, the files the server left out of it (scanner down, a type or document
	// not accepted, a file it could not check). The sent message still shows them, marked not added,
	// where they would otherwise vanish when the answer lands. Names only; the bytes were never stored. (CUR-3405)
	leftOutFiles?: { name: string; mime: string }[];

	// Attached files this turn could not read back from storage, named, so the person knows the
	// answer did not use them. Persisted so the note survives reload. (CUR-3291)
	unreadFilesNotice?: string;

	// How many of the chat's oldest exchanges were left out so the request fit the model's
	// context. Absent when nothing was left out. Persisted so the note under the answer survives reload. (CUR-2893)
	historyLeftOut?: number;

	// Agent was on Auto and the agent service's route check failed or timed out, so the selected
	// model answered without anyone deciding the turn was ordinary. Persisted so the note survives reload. (CUR-2830)
	agentRouteFailed?: true;

	// Unverified-link advisory: set when the post-generation URL guard ($lib/chat/server/urlGuard) de-linked
	// one or more citation URLs the model emitted but we couldn't vouch for (not retrieved this turn, not a
	// recognised domain). The answer is unchanged except those URLs render as non-navigating "?"-marked
	// references; this carries the structured explanation the provenance trace surfaces. Persisted via JSONB
	// so it survives reload, mirroring nameNotice/safetyNotice above. `count` is how many were de-linked;
	// `urls` keeps the originals for the tooltip / trace detail.
	urlNotice?: {
		count: number;
		urls?: string[];
	};

	// one or more parenthetical source LABELS the model wrote that the retrieved source contradicts (e.g.
	// "[1] (European Commission)" when source 1 is an unrelated page). The lying label is removed; the [n]
	// marker stays (it links to the real source). `count` is how many were stripped. Persisted via JSONB so
	// it survives reload, mirroring urlNotice/nameNotice above.
	labelNotice?: {
		count: number;
	};

	// Fabricated-source advisory: set when the post-generation source guard ($lib/chat/server/sourceGuard) stripped
	// a fabricated trailing "Sources:/References:" block and/or a "these sources are fictional/hypothetical"
	// disclaimer from the answer (the model invented a citation list despite the real sources rendering
	// separately). The body is cleaned; this records that the intervention happened so the provenance trace
	// can report it honestly instead of the strip being silent. Persisted via JSONB so it survives reload,
	// mirroring urlNotice/labelNotice above. `removedChars` is how many characters were stripped.
	sourceNotice?: {
		removedChars?: number;
	};

	// Grounded-hedge-replacement advisory: set when honestyStream's end-of-stream check found the model's
	// whole answer was a hedge/refusal on a grounded turn and substituted different text. This is the
	// single largest mutation the honesty guards can make, discarding the model's entire answer, and
	// it is recorded here so the on-screen provenance trace's "Honesty guards" step can report it
	// (`finalMutations` also reaches logger.info (Axiom)). Persisted via JSONB so it survives
	// reload, mirroring sourceNotice/labelNotice above.
	//
	// `kind` distinguishes WHICH substitution ran, because the honest disclosure copy differs: "regen" is
	// a fresh answer from the model's own knowledge (groundedBailRegen.ts, gated by the grounded-bail-regen
	// flag — CUR-148's preferred path per Corrective RAG / "sufficient context" practice: re-answer rather
	// than cite sources the model already declined to use); "pointer" is the older, always-available
	// fallback-of-fallback (buildGroundedHedgeReplacement, $lib/chat/server/hedgeGuard) — a deterministic
	// list of the retrieved sources, used when regen isn't wired, is flag-off, or itself produced nothing
	// usable. `sourceCount` is how many retrieved sources were available (0 → the vault-synthesis-only,
	// no-citable-list wording on the pointer path; on the regen path it's informational only).
	groundedHedgeNotice?: {
		kind: "pointer" | "regen";
		sourceCount: number;
	};

	// What groundcheck (groundcheckStage.ts) did to this answer, so the provenance trace can
	// tell a check that removed claims from one that passed it and one that never ran. Absent when the
	// check never applied (flag off, nothing retrieved, a decline, a cut-off answer). A sourced answer
	// that skipped it for code-rendered numbers or a guard's rewrite carries "stood-down". (CUR-2765)
	groundcheckNotice?: {
		outcome: GroundcheckOutcome;
		/** Claims deleted on a `revised` or `emptied` answer (CUR-2927). Absent on answers stamped earlier. */
		removed?: number;
	};

	// Independent cross-checks the user opted into, in the order they were requested
	// (second opinion, then third, …). Each is ANOTHER open model's take on the same
	// question — neutral triangulation so the user can compare, never a synthesized
	// consensus or an oracle. Convergence across independent labs is more trustworthy;
	// divergence is worth scrutiny. Persisted via JSONB so the comparison + the routing
	// map events survive reload, mirroring webSearch above.
	opinions?: {
		model: string;
		modelShort: string;
		openness: string;
		sovereign: boolean;
		answer: string;
		/** Where this panelist's own call ran, from its response's routing record (CUR-3563). Absent
		 *  when the call reported neither, and then the take says so rather than naming a planned host. */
		backend?: string;
		provider?: string;
	}[];

	// Collective cross-check verdict over the panel of independent opinions (above) AS A
	// JUDGMENT ON the primary answer — never a merged/synthesized answer of its own. The
	// fanout VERIFIES the answer already given; it does not replace it. `agreement` is the
	// honest calibrated confidence signal (cross-model agreement is the only per-answer
	// confidence we can measure); `headline` is its one-line surfacing. consensus /
	// contradictions / weakSpots mirror the open Fusion-style analysis (we deliberately
	// stop before any synthesis step). Persisted via JSONB alongside opinions[].
	verdict?: {
		agreement: "high" | "mixed" | "low";
		headline: string;
		consensus: string[];
		contradictions: string[];
		weakSpots: string[];
	};

	// needed for conversation trees
	ancestors?: Message["id"][];

	// goes one level deep
	children?: Message["id"][];
};

export type MessageFile = {
	type: "hash" | "base64";
	name: string;
	value: string;
	mime: string;
	/** Set when the attachment was written to a storage location the person linked rather (CUR-2930)
	 *  than Alpha storage. `path` is the location's own path, read back with that location's `read`. */
	location?: { id: string; path: string };
	/** On a file an agent turn wrote, its path in the agent's workdir. The reply's download (CUR-4398)
	 *  link names this path, and the link's route serves this saved copy before asking the agent. */
	agentPath?: string;
};

/** What a helper model did on a turn it did not write (CUR-984). */
export type AssistRole = "search-decision" | "math-route" | "safety-screen" | "query-rewrite" | "title";

/** One helper model on a turn: the model id it was called with, and where it ran. `backend` is the
 *  host the call went to; `provider` is the HF router's own pick when the call went through the router. */
export interface AssistedBy {
	role: AssistRole;
	model: string;
	provider?: string;
	backend?: string;
}

/** How a groundcheck run ended (groundcheck.ts). "revised" and "emptied" changed the answer; "clean"
 *  and "kept" checked it and left it; the rest never finished a check, so the answer shipped as written. */
export type GroundcheckOutcome =
	| "clean"
	| "revised"
	| "emptied"
	| "kept"
	| "truncated"
	| "too-many"
	| "detect-failed"
	| "revise-failed"
	| "stood-down";
