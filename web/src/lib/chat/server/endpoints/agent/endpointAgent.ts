import { base as chatBase } from "$lib/chat/paths";
import { MY_FILES_FACT } from "$lib/chat/server/textGeneration/persona";
import { z } from "zod";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { createHmac } from "node:crypto";
import { logger } from "$lib/chat/server/logger";
import { agentAutoApproveFor } from "$lib/chat/server/agentConfirmUi";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { AGENT_HANDOFF_WALL_CLOCK_SECS, AGENT_SERVICE_WALL_CLOCK_SECS, agentHandoffAt } from "$lib/chat/utils/deadlineLadder";
import { agentRunHandoffEnabled } from "$lib/chat/server/agentRunHandoffGate";
import { endedByWatchdog } from "$lib/chat/server/chat/generationDeadline";
import { resolveModelIdentity } from "$lib/chat/identity";
import { languageName } from "$lib/chat/answerPreferences";
import { CLIENT_INSTRUCTIONS_MAX_CHARS } from "$lib/chat/server/clientInstructions";
import { agentArtifactDownloadEnabled } from "$lib/chat/server/agentArtifactDownload";
import type { Endpoint, TextGenerationStreamOutputSimplified } from "../types";
import type { UnrunCodeReason } from "$lib/chat/types/MessageUpdate";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { FAKE_AGENT_BASE, fakeAgentFetch, isFakeAgentTaskId } from "./fakeAgentService";
import { agentTaskRoom, agentTasksPerDay, agentTasksUsedText, recordAgentTask } from "$lib/chat/server/db/agentTaskAllowance";
import { isTeamAccount } from "$lib/chat/server/teamAccount";
import { keepAgentFiles, type SavedAgentFile } from "./agentFiles";

/**
 * Agent endpoint — Story B (agent answers inside Gap Chat).
 *
 * Instead of calling an OpenAI model, this drives the Public AI **agent service** (the hosted
 * Apertus-hybrid backend): POST /run to submit the task, then stream GET /run/{id}/events (SSE) and
 * translate the agent's event stream into chat-ui's token stream. The agent's plan, per-step progress
 * and live answer prose are wrapped in a single <think>…</think> block (ChatMessage.svelte's zero-config
 * reasoning autodetection renders that as a collapsible "thinking" panel), and `done.result` becomes
 * the answer.
 * NOT the *verified* result — see `verified` below; we never read it. A routerMetadata chunk lights
 * the provenance badge + the agent node on the StackMap; the
 * badge model is corrected from the service's own `done.model` so it reflects what actually ran.
 *
 * Two live wire contracts (the service gates the richer one behind AGENT_ACP):
 *   - ACP ON  (/healthz reports "acp":"on"): state{working} · plan? · tool_call{tool,step} ·
 *     tool_result{ok,step,summary} · token* · usage · done
 *   - ACP OFF: state{working} · usage{tokens[,steps]} · done — NO per-tool frames
 * `state{working}` fires unconditionally on BOTH paths, at task start, before agent-service has even
 * chosen a transport (CUR-773) — it is a coarse liveness ping, never a per-transport signal. `done`
 * carries `transport_used` ("acp"|"oneshot") for that; see `AgentEvent.transport_used`.
 * This endpoint handles BOTH: it narrates tool steps when they arrive, and falls back to a usage-derived
 * step/token summary so the coarse path still renders a non-empty <think> block instead of a bare shell.
 *
 * All the hard parts (plan/exec, bwrap sandbox, best-of-N, caps, metering, moderation) live behind the
 * agent service's HTTP boundary — this endpoint only translates transports. It never holds the upstream
 * model token; it carries only the per-deployment service token (a normal API credential).
 *
 * Per-step live-stack animation: each agent step also emits an `agentStep` chunk (→ MessageUpdateType
 * .AgentStep) so the client beats the Hermes node on the StackMap as the agent works. The verify-spec is
 * auto-derived server-side for chat turns, so the backend runs best-of-N rather than a single attempt.
 */
/** How long a turn keeps asking again while agent-service answers "server at capacity", on its
 *  Retry-After, before it says so. The same bound agent-service waits for a free sandbox (CUR-4584). */
const AGENT_CAPACITY_WAIT_MS = 60_000;
/** agent-service's 503 body while its machine drains running tasks for a deploy. (CUR-4598) */
const AGENT_RESTARTING = /restarting for an update/;
const AGENT_RESTARTING_TEXT =
	"The agent service is restarting for an update. Please send your message again in a minute.";
/** A `done` frame with interrupted:"restart": the restart came before the task could finish. */
const AGENT_RESTARTED_TEXT =
	"The agent service restarted for an update before this task finished. Please send your message again to retry it.";

export const endpointAgentParametersSchema = z.object({
	weight: z.number().int().positive().default(1),
	model: z.any(),
	type: z.literal("agent"),
	/** Base URL of the agent service (e.g. https://…fly.dev or http://127.0.0.1:8731). */
	baseURL: z.string().url(),
	/** The env var the service token lives in (CUR-2640); the registry stores only this name. */
	apiKeyEnv: z.string().optional(),
	/** Per-user / per-deployment bearer token for the agent service (empty when its auth is disabled).
	 *  Call-time only: resolved from `apiKeyEnv` when the lane is built, never kept on a model object. */
	apiKey: z.string().default(""),
	/** Provenance model shown in the badge + StackMap node. Empty by default — the actual served model is
	 * corrected at runtime from the service's done.model, so no model brand is hardcoded here. */
	provenanceModel: z.string().default(""),
	/** Inference provider for the badge. Empty by default → the badge names no provider rather than
	 * claiming one the agent run may not have hit; the service's reported compute fills it (CUR-3562). */
	provenanceProvider: z.string().default(""),
	/** Cap on how long we wait on the event stream (ms); should exceed the backend wall-clock. */
	streamTimeoutMs: z.number().int().positive().default(300_000),
	/** How long a submit answered "server at capacity" is asked again before the turn says so. (CUR-4584) */
	capacityWaitMs: z.number().int().nonnegative().default(AGENT_CAPACITY_WAIT_MS),
});

interface AgentEvent {
	type?: string;
	// `plan` carries the step titles (string[]); `usage` reuses the key as an aggregate count (number).
	steps?: string[] | number;
	attempt?: number;
	tool?: string;
	step?: number;
	ok?: boolean;
	summary?: string;
	/** Auto mode's plain sentence on `awaiting_confirmation` and `auto_approved` frames. (CUR-3142) */
	plain?: string;
	text?: string;
	/** `token` frame: one chunk of the agent's answer prose, as it is produced. */
	delta?: string;
	state?: string;
	tokens?: number;
	result?: string;
	// `done` frame (CUR-856): agent-service's own reason a non-COMPLETED task has no result — the case
	// this exists for is a moderation block on the agent's OWN artifacts (carried by StatusResponse
	// and by `_done_payload`, the live SSE shape). Absent for an older build or a failure
	// agent-service never got far enough to name.
	error?: string;
	/**
	 * DECLARED AND NEVER READ. Nothing in this file or the client branches on it — the answer comes
	 * from `result`/`state` at the `done` handler below. Kept because the service sends it and the
	 * type should describe the wire, but do not cite it as something we act on: the verified result
	 * does not become the answer.
	 *
	 * The service's auto-derived verify spec can reject correct answers: it counts separator-delimited
	 * items, so identical arithmetic passes when terse and fails when written in prose, and the
	 * short-circuit means the judge never gets to disagree. Read CUR-193 before rendering a verification
	 * state; a badge fed from this field would be wrong on most free-form turns.
	 */
	verified?: boolean;
	// `done` frame (CUR-756): agent-service's own verify tier for the task — "" (unverified) |
	// "execution" | "judge" | "execution+judge" (agent-service's `_done_payload`, api/app.py). Unlike
	// `verified` above, this one IS read — it feeds the provenance badge's trust segment. No model name
	// travels with it; the verifier model is a live config value (fly/agent-app.toml's
	// AGENT_VERIFIER_MODEL), so naming it in the badge would drift the moment that config changes.
	verify_method?: string;
	// `done` frame reports the model that actually served the task (e.g. swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO); used
	// to correct the provenance badge instead of trusting the endpoint's configured default.
	model?: string;
	// `done` frame (CUR-1107, wired to the badge here by CUR-996): agent-service's own live-observed
	// compute provider — `_effective_compute_provider()` in api/app.py, which prefers a poll of the
	// model proxy's actual last-served backend over the static AGENT_COMPUTE_PROVIDER config value.
	// Same correction pattern as `model` above: this endpoint's `provenanceProvider` param only ever
	// held the configured INTENT, never what a run actually hit.
	compute_provider?: string;
	// `done` frame (CUR-773): "acp" | "oneshot" | "" (task never got far enough to decide) — agent-
	// service's own record of which transport this task actually ran on (Task.transport_used,
	// api/app.py). Read to compute `acpTransport` below. A `state` frame says nothing about the transport,
	// because agent-service emits `state:{working}` unconditionally at task start, before it has chosen
	// one.
	transport_used?: string;
	/**
	 * `done` frame (CUR-574 follow-up): the in-session repair loop's OWN verdict on the turn that became
	 * this result — set only when the repair budget or the attempt's wall clock ran out on the very turn
	 * that spent the last of it, so repair_check's disapproval could never trigger another retry (see
	 * agent-service's acp_client._acp_run give-up branch). `wroteCodeWithoutRunningIt` and
	 * claimedStepsWithoutObservedTools both read the tool-call stream this endpoint itself observed;
	 * this is the one case neither can see, because the exhausted turn can still have called real tools
	 * — repair_check's complaint was about the ANSWER, not the absence of tool activity. Empty/absent
	 * when the last-checked turn passed, or no repair check is configured.
	 */
	unrun_detail?: string;
	/** "restart" when a restart (a deploy that ran past its drain) ended the task unfinished. (CUR-4598) */
	interrupted?: string;
	// `done` frame (CUR-705): whether this task reused a prior turn's session workdir (agent-service's
	// task._session_continued — see _run's (task.user, session_id) lookup). Absent/false for a fresh or
	// sessionless task. See claimedActionOnContinuedSession for what this feeds.
	session_continued?: boolean;
	/**
	 * `done` frame (CUR-1394): how many files the session's workdir ALREADY held when this turn started
	 * — agent-service's `task._session_files_at_start`, taken from the walk `_workdir_note` does to tell
	 * the agent what is in the room. Saturates one past that service's own file cap; zero versus non-zero
	 * is the only distinction read here, so don't reach for it as a true count.
	 *
	 * `session_continued` above says a workdir was REUSED, never whether anything was in it. That was the
	 * gap: this client sends `session_id: conversationId`, so every turn after the first in an ordinary
	 * conversation is a continued session with an empty room, and a caveat scoped to CUR-705's shape would
	 * open on answers that never touched a file.
	 *
	 * ABSENT on a service build older than this field, and absence is not zero — it means we did not ask.
	 * Both readers treat it as "unknown, so say nothing", the same posture INERT_TOOL_KINDS takes on an
	 * unrecognised kind, and the right one for a caveat whose entire value is being correct when it fires.
	 */
	session_files_at_start?: number;
	/**
	 * `done` frame (CUR-4599): agent-service's no-tool review read this turn's accepted answer, which made no
	 * tool call, and found it claimed nothing: "declined" (it said it cannot do the request) or "answered"
	 * (the request needed no tool). Empty or absent otherwise, and on an older build.
	 *
	 * Both "no tool call was observed" checks below count model calls as claimed steps (`usage.steps` is
	 * agent-service's `model_calls`, at least 1 on every answer), so in a conversation that already holds a
	 * file they fire on every no-tool answer, an honest "I cannot send emails" included. This is the signal
	 * that tells a refusal from CUR-574's narrated run; it is a model's reading of the reply, made on the
	 * service where the retry decision already depends on it.
	 */
	no_tool_answer?: string;
	// `done` frame (CUR-196, read since CUR-4393): the session's earlier workdir is gone and this turn
	// started in an empty one. SESSION_EXPIRED_NOTICE says so.
	expired?: boolean;
	// `policy` frame (CUR-471): this caller's resolved write-permission state for the task, fired once
	// early (same point `plan` fires) under every ACP_PERMISSION_POLICY value. See
	// MessageWritePolicyUpdate for the full contract; loosely typed here like `state`/`tool` above
	// because this is the raw-wire layer — endpointAgent narrows it before forwarding.
	policy?: string;
	tier?: string;
	tasks_done?: number | null;
	tasks_required?: number | null;
	errors?: string[];
	// `awaiting_confirmation` / `confirm_result` frames (CUR-218, ACP_PERMISSION_POLICY=confirm only —
	// see acp_client.py's _request_confirmation). `kind`/`title`/`summary` are agent-service's own
	// redacted description of the paused tool call (_describe_tool_call); `decision`/`reason` arrive
	// only on the resolution frame. `attempt` is reused from the field declared above.
	confirm_id?: string;
	kind?: string;
	title?: string;
	decision?: string;
	reason?: string;
	// `awaiting_confirmation` frame only (CUR-1094): agent-service's own confirm_timeout_secs for THIS
	// pause, as a duration — see acp_client.py's _request_confirmation. Absent on an older/coarse build
	// that predates this field.
	timeout_secs?: number;
	/** `done` frame: the files the agent left, with contents where they fit. See renderArtifacts. */
	artifacts?: AgentArtifact[];
	/** More files existed than the service was willing to send. */
	artifacts_dropped?: boolean;
}

/**
 * ACP tool kinds that demonstrably cannot have executed anything.
 *
 * Deliberately an ALLOWLIST of the inert kinds rather than a denylist of the executing ones. An
 * unrecognised kind — `other`, which the bridge reports when it has no kind, or anything a future
 * Hermes build introduces — must NOT read as "nothing ran", because being right about that is the
 * entire value of the caveat below. Unknown kind → we know nothing → say nothing.
 */
const INERT_TOOL_KINDS: ReadonlySet<string> = new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"think",
	"fetch",
	"switch_mode",
]);

/**
 * Did this turn write something to run, and then never run it?
 *
 * A turn can write code, emit no execute step, and print a block headed `Execution result:` whose
 * numbers its own code cannot produce. The same model sometimes heads that block `Expected results:`
 * instead, so it is able to mark a prediction as a prediction; nothing makes it (CUR-226).
 *
 * Nothing here reads the answer prose. The harness knows which tools ran, and that fact alone decides
 * whether the caveat is warranted — a claim about the turn, not a guess about the text.
 *
 * An EMPTY set is not evidence: the coarse (ACP-off) path sends no tool frames at all, so it means we
 * never observed tools rather than that none were used. Requiring an `edit` covers that too.
 *
 * Tool kind alone is not enough: the call site ANDs this with `editedCodeArtifact` below (CUR-592).
 * This function knows that an `edit` tool ran, never what it touched, so on its own a turn that only
 * rewrote a `.txt` letter trips it exactly like one that fabricated a computed result. The tool-kind
 * question it answers is correct, just not sufficient on its own.
 *
 * Takes a ReadonlyMap<string, number> so the caller can also keep per-kind counts (for the tool-run
 * summary line) without a second pass over the tool_call stream. This function only answers "did
 * anything run"; the count is deliberately unused here.
 */
export function wroteCodeWithoutRunningIt(toolKinds: ReadonlyMap<string, number>): boolean {
	if (!toolKinds.has("edit")) return false;
	for (const kind of toolKinds.keys()) if (!INERT_TOOL_KINDS.has(kind)) return false;
	return true;
}

/**
 * Extensions worth calling "wrote but never ran" over — files a reader would expect to be EXECUTED,
 * not merely read.
 *
 * Deliberately an ALLOWLIST, the same shape as INERT_TOOL_KINDS above and for the same reason: an
 * extension this list hasn't caught up to (a new language) or no extension at all must NOT read as
 * code, because under-firing on an obscure language costs nothing while over-firing on prose is the
 * exact bug this list exists to fix (CUR-592). Kept small and named rather than exhaustive.
 */
const CODE_ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
	"py",
	"js",
	"ts",
	"jsx",
	"tsx",
	"sh",
	"bash",
	"rb",
	"go",
	"rs",
	"sql",
	"java",
	"c",
	"cpp",
	"php",
]);

/**
 * Does at least one of the turn's artifacts look like something meant to be RUN, not read?
 *
 * Without this, a turn that only rewrote a benefits letter (`.txt`, no computation, nothing to "run")
 * gets the same "wrote files but never ran anything, so any output shown below is predicted rather
 * than measured" caveat as a turn that fabricated a computed result. On a plain-language task the
 * notice is wrong and teaches a non-technical user to distrust a fine answer.
 *
 * The signal is the artifact's own `name` (its extension), never the answer's prose: regex or
 * substring sniffing of text is not used as a classification signal here, so "looks like code" has to
 * be structural.
 */
export function editedCodeArtifact(artifacts: readonly AgentArtifact[]): boolean {
	for (const artifact of artifacts) {
		const name = (artifact.name ?? "").trim();
		const dot = name.lastIndexOf(".");
		if (dot <= 0 || dot === name.length - 1) continue; // no extension, dotfile, or trailing dot
		if (CODE_ARTIFACT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return true;
	}
	return false;
}

/**
 * Did the service claim steps happened on a turn where the ACP transport — which reports every tool
 * call — observed NONE at all?
 *
 * A turn can report `steps: 1` in its `usage` frame and answer with numbers its own test data cannot
 * produce while zero `tool_call` frames arrive (CUR-574). `wroteCodeWithoutRunningIt` misses that case:
 * it requires `edit` as a positive signal, deliberately, because an empty set is ALSO what the coarse
 * (ACP-off) transport always sends, where an empty set proves nothing (see its doc comment above).
 *
 * Under ACP transport that ambiguity doesn't hold — every tool call is reported, so a genuinely empty
 * `toolKinds` here IS the observation, not an absence of one (the log line below treats it the same
 * way, CUR-234). Gated on the service's OWN
 * claimed step count, not on `toolKinds` alone, so a turn that reasoned to an answer needing no tool
 * at all (steps unreported or 0) stays quiet. Requiring `toolKinds` to be fully EMPTY, not merely
 * non-executing, also keeps this quiet on a turn that called real (if inert) tools — read a file,
 * searched — which is a legitimate shape this notice's wording ("wrote files but never ran anything")
 * would misdescribe.
 *
 * `toolKinds` is a Map of kind to count, but only `.size` (distinct kinds observed) is read here. Don't
 * reach for a sum of the Map's values ("total tool calls"): `.size` is the only correct read for "were
 * any tools observed at all".
 */
export function claimedStepsWithoutObservedTools(
	toolKinds: ReadonlyMap<string, number>,
	acpTransport: boolean,
	claimedSteps: number | undefined,
	sessionFilesAtStart: number | undefined
): boolean {
	if (!sessionHadSomethingToMeasure(sessionFilesAtStart)) return false;
	return acpTransport && toolKinds.size === 0 && (claimedSteps ?? 0) > 0;
}

/**
 * Could this turn have been faking a measurement AT ALL?
 *
 * Without this gate the caveat below would open on capital-city questions, arithmetic, and web-search
 * answers, telling them they "wrote files but never ran anything" (CUR-1394). None of those turns wrote
 * a file or ran a thing.
 *
 * Both callers below infer an overclaim from zero observed tool calls. That inference holds only in a
 * session already holding files the agent could claim to have acted on. In an ordinary chat turn no
 * file has ever existed in the workdir, so there is no measurement to fake and the caveat's own
 * sentence cannot be true. The premise that matters is not "were tools called" but "was there anything
 * here to call them on".
 *
 * `session_continued` cannot supply it. This client sends `session_id: conversationId` (see the /run
 * body), so one conversation's turns share one workdir and every follow-up is a continued session; that
 * flag only means "not the first message".
 *
 * This is a structural fact about the workdir, deliberately, not a reading of the answer's prose: the
 * same standard `editedCodeArtifact` is held to, since "the agent claimed something" cannot be decided
 * by substring-matching text.
 *
 * Undefined is neither zero nor safe to fire on. A service build older than this field sends no value,
 * which tells us only that we never asked. Returning false there keeps both checks quiet, the same
 * direction INERT_TOOL_KINDS takes ("Unknown kind → we know nothing → say nothing"). Firing on unknown
 * would make the unsupported claim this check exists to remove. `wroteCodeWithoutRunningIt &&
 * editedCodeArtifact` and the service's own `unrun_detail` verdict are unaffected, and still cover the
 * turns that genuinely wrote a script and never ran it.
 *
 * Writing the body as `(sessionFilesAtStart ?? 0) > 0` would fail no test, because undefined and 0
 * both mean "stay quiet" and no input separates the two. The explicit `typeof` check is kept for what
 * it says to a reader, not for behaviour it currently enforces; a test can pin the difference only once
 * the two answers diverge.
 */
export function sessionHadSomethingToMeasure(sessionFilesAtStart: number | undefined): boolean {
	return typeof sessionFilesAtStart === "number" && sessionFilesAtStart > 0;
}

/**
 * Did a follow-up turn against a continued session call zero tools, on the ACP transport that reports
 * every one it calls?
 *
 * A follow-up ("add two rows, then run top_months.py again") against a session holding a prior turn's
 * files can claim "I have updated `sample_revenue.csv`" with specific numbers while `toolKinds` is
 * empty and no `plan` or `usage` frame arrives, so there is no claimed step count to compare against
 * (CUR-705). `claimedStepsWithoutObservedTools` requires the
 * service to self-report `claimedSteps > 0` so that a turn that legitimately needs no tool stays quiet;
 * this function covers the continued-session shape that gate misses.
 *
 * It is a blunt instrument: unlike every other check in this file, it does not distinguish a legitimate
 * no-tool recollection ("what did the script print last turn?") from a false claim of new action. Both
 * look identical from here (toolKinds empty, no claimed steps). That distinction needs the service's own
 * semantic judge (repair_check / the best-of-N verifier wired for caller-supplied specs, see
 * `unrun_detail`), extended to run for this shape on the auto-derived (`synthesize: true`) chat path;
 * that is separate work.
 *
 * `sessionFilesAtStart` keeps the over-cautious caveat off ordinary conversations, whose workdir never
 * holds anything; see `sessionHadSomethingToMeasure` (CUR-1394). A session that held files keeps its
 * caveat.
 *
 * Takes a ReadonlyMap<string, number>; same `.size` reasoning as `claimedStepsWithoutObservedTools`
 * above.
 */
export function claimedActionOnContinuedSession(
	toolKinds: ReadonlyMap<string, number>,
	acpTransport: boolean,
	sessionContinued: boolean,
	sessionFilesAtStart: number | undefined
): boolean {
	if (!sessionHadSomethingToMeasure(sessionFilesAtStart)) return false;
	return acpTransport && sessionContinued && toolKinds.size === 0;
}

/**
 * PREPENDED, not appended, and that is the whole point: it frames the numbers that follow, and a
 * reader who stops early is exactly the reader a fabricated measurement fools. It also sits in the
 * answer rather than the think block, because `Computed` is collapsed by default.
 */
/**
 * agent-service reported that this conversation's earlier agent workspace is gone (reaped, or
 * the machine holding it was stopped or replaced), so the turn ran in an empty one. Prepended for the
 * same reason as UNRUN_CODE_NOTICE: the person must not read the answer as built on their earlier files. (CUR-4393)
 */
/**
 * The answer for an agent turn that ended while `pending` approval cards were still unanswered
 * (CUR-4660). The turn stopped because nobody answered, so the answer says that, rather than that
 * the run was "stopped", which reads as though something else ended it.
 */
function unansweredApprovalAnswer(pending: number): string {
	return pending === 1
		? "No answer arrived in time for the agent's approval request, so it was denied and the run ended. Ask again to run it afresh."
		: `No answer arrived in time for the agent's ${pending} approval requests, so they were denied and the run ended. Ask again to run it afresh.`;
}

/** What an agent turn's answer says once the run outlasts the request and is handed to the page.
 *  @internal exported for its unit tests */
export const AGENT_HANDOFF_TEXT =
	"The agent is still working on this. The answer will appear here when it finishes; you can leave this page and come back.";

/** What one agent turn had observably done when its stream ended without the service's `done`. */
interface PartialAgentRun {
	/** Steps the agent planned, when it sent a plan. */
	plannedSteps?: number;
	/** Tool calls whose `tool_result` confirmed they ran, in order, each as the service summarized it. */
	finishedSteps: { tool: string; summary?: string }[];
	/** Tool calls proposed but never resolved: the one in flight when the turn ended. */
	unfinishedTools: string[];
	/** The answer prose the agent had written so far (the current attempt's buffer), if any. */
	draft: string;
}

/** How many finished steps the account names one by one before summarizing the rest. */
const ACCOUNT_STEP_LINES = 8;

/**
 * The answer for an agent turn that ended before the service's `done`: why it ended, then what the
 * agent had done, what it had not, and what to do next, so a turn cut by the 155 s chat watchdog says
 * more than that the run stopped.
 *
 * Built only from frames this endpoint observed, so it claims nothing the stream did not show: a step
 * counts as done once its `tool_result` arrived ok, and the draft is labelled unfinished.
 *
 * @internal exported for its unit tests
 */
export function partialRunAnswer(
	why: "timed-out" | "stopped" | "dropped",
	run: PartialAgentRun
): string {
	const lead =
		why === "timed-out"
			? `The agent ran out of time before finishing: an agent turn in chat gets about ${Math.round((AGENT_SERVICE_WALL_CLOCK_SECS / 60) * 2) / 2} minutes.`
			: why === "stopped"
				? "The agent run was stopped before it finished."
				: "The agent stream dropped before the task finished.";
	const lines: string[] = [lead, ""];
	const done = run.finishedSteps;
	if (done.length === 0) {
		lines.push("**Done so far:** no step had finished yet.");
	} else {
		const planned = run.plannedSteps ? ` of ${run.plannedSteps} planned` : "";
		lines.push(`**Done so far:** ${done.length} step${done.length === 1 ? "" : "s"}${planned} finished.`);
		for (const s of done.slice(0, ACCOUNT_STEP_LINES)) {
			const summary = (s.summary ?? "").replace(/\s+/g, " ").trim();
			lines.push(`- ${s.tool}${summary ? `: ${summary.length > 160 ? `${summary.slice(0, 157)}…` : summary}` : ""}`);
		}
		if (done.length > ACCOUNT_STEP_LINES) lines.push(`- …and ${done.length - ACCOUNT_STEP_LINES} more`);
	}
	lines.push("");
	const notDone: string[] = [];
	if (run.unfinishedTools.length > 0)
		notDone.push(`the step in progress (${run.unfinishedTools.join(", ")}) did not finish`);
	if (run.plannedSteps && run.plannedSteps > done.length)
		notDone.push(`${run.plannedSteps - done.length} planned step${run.plannedSteps - done.length === 1 ? "" : "s"} did not run`);
	notDone.push("the agent had not written its final answer");
	lines.push(`**Not done:** ${notDone.join("; ")}.`);
	const draft = run.draft.trim();
	if (draft) {
		lines.push("", "**What it had written so far (unfinished, unchecked):**", "", draft);
	}
	lines.push(
		"",
		why === "timed-out"
			? "Ask it to carry on from here, or split the task into smaller pieces so each fits in one turn."
			: why === "stopped"
				? "Ask it to carry on from here when you're ready."
				: "Please try again; ask it to carry on from here."
	);
	return lines.join("\n");
}

/** Waits `ms`, or rejects with an AbortError as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("aborted", "AbortError"));
			},
			{ once: true }
		);
	});
}

const SESSION_EXPIRED_NOTICE =
	"_The files from earlier in this conversation are no longer available, so this answer started from an empty workspace._\n\n";

/**
 * The Fly machine that ran this conversation's latest agent task. Session workdirs live on one
 * machine, so a follow-up `/run` is pinned there; `continues` tells agent-service that a miss means the
 * session moved or expired rather than that it is new. (CUR-4393)
 */
function priorAgentMachine(messages: { from: string; agentRun?: { taskId: string; machineId?: string } }[]): {
	continues: boolean;
	machineId?: string;
} {
	const prior = messages.findLast((m) => m.from === "assistant" && m.agentRun?.taskId);
	return { continues: Boolean(prior), machineId: prior?.agentRun?.machineId || undefined };
}

export const UNRUN_CODE_NOTICE =
	"_This turn wrote files but never ran anything, so any output shown below is predicted rather than measured._\n\n";

/**
 * The same warning for the two branches that cannot see whether a file was written (CUR-1394).
 *
 * `claimedStepsWithoutObservedTools` and `claimedActionOnContinuedSession` both infer an overclaim from
 * an empty tool-call stream. Neither knows what — if anything — this turn wrote, so UNRUN_CODE_NOTICE's
 * "wrote files but never ran anything" asserts a specific event they have no evidence for. Narrowing
 * those branches to sessions that actually held files stops them firing on ordinary chat, and it does
 * not make that sentence true: a turn in a populated workdir that called no tools may have written
 * nothing at all.
 *
 * So this says only what those branches observed — the agent described work, and the transport that
 * reports every tool call saw none. Same prepended position and purpose as UNRUN_CODE_NOTICE. It reaches
 * the reasoning panel through the same `caveatReason` verdict (CUR-1341), which keeps the "Predicted"
 * header accurate above either sentence.
 */
/** `no_tool_answer` values meaning the answer claimed no work, so the two no-tool checks stay quiet (CUR-4599). */
const CLAIMED_NOTHING: ReadonlySet<string> = new Set(["declined", "answered"]);

export const UNOBSERVED_ACTION_NOTICE =
	"_This turn reported doing work, but no tool call was observed while it ran — so anything described below as done or measured may not have happened._\n\n";

/**
 * Which sentence a given caveat verdict earns (CUR-1394).
 *
 * Exhaustive over `UnrunCodeReason` by construction — the `never` in the default branch makes adding a
 * sixth reason without choosing its copy a compile error rather than a silent fall-through onto whatever
 * sentence happens to be last. That matters here more than usual: the failure this whole area keeps
 * producing is a true mechanism attached to a sentence describing a different one.
 *
 * `null` cannot reach this (the call site is inside `if (unrunCodeCaveat)`, and `caveatReason` is
 * non-null whenever that is true) and returns the empty string rather than throwing, because a caveat
 * bug must never be able to take down a turn that already has a real answer to deliver.
 *
 * `service-verdict` keeps UNRUN_CODE_NOTICE deliberately: that branch is the service's own repair-loop
 * verdict, whose four shapes (wrote-and-never-ran, tool-call-failed, claimed-file-missing,
 * attempts-disagreed) the existing sentence was written for. It keeps its own sentence; `unrun_detail` carries which shape fired.
 */
export function noticeForCaveat(reason: UnrunCodeReason | null): string {
	switch (reason) {
		case "wrote-not-run":
			return UNRUN_CODE_NOTICE;
		case "claimed-not-observed":
		case "continued-session-no-action":
			return UNOBSERVED_ACTION_NOTICE;
		case "service-verdict":
			return UNRUN_CODE_NOTICE;
		case "service-verdict-structural":
			return STRUCTURAL_FAILURE_NOTICE;
		case null:
			return "";
		default: {
			const unhandled: never = reason;
			return unhandled;
		}
	}
}

/**
 * CUR-855/846: agent-service's `unrun_detail` prefix for a turn that ended in State.FAILED (gateway
 * down, wall-clock cap, the agent process crashing) but still carries real content — the fix that made
 * `task.result` survive a structural failure. Distinct from the four overclaim prefixes UNRUN_CODE_NOTICE
 * covers (wrote-and-never-ran, tool-call-failed, claimed-file-missing, attempts-disagreed): those are all
 * "the agent said more than it did," which is what that sentence describes. A structural failure tried
 * and didn't finish — reusing that sentence there would be false, not just imprecise.
 */
const STRUCTURAL_FAILURE_PREFIX = "structural-failure:";

/** Paired with STRUCTURAL_FAILURE_PREFIX — same prepend contract as UNRUN_CODE_NOTICE, honest for this case. */
export const STRUCTURAL_FAILURE_NOTICE =
	"_This turn did not finish, so anything shown below may be incomplete or wrong._\n\n";

/** One entry of the `done` frame's `artifacts` list: a file the agent left in its scratch. */
export interface AgentArtifact {
	name?: string;
	bytes?: number;
	/** The file's text, or null when the service declined to inline it (binary, or past its byte budget). */
	text?: string | null;
	/** `text` is not the whole file — a cut-off read OR a blob we were never sent. */
	truncated?: boolean;
}

/**
 * How much artifact text to INLINE, which is a different question from how much to send.
 *
 * The service's caps (20 files / 64KB each / 256KB total) size a MODERATION budget — output screening
 * reads the answer plus every artifact, so it wants the whole thing. Pasting all of it into a chat
 * message is a different act with a different reader, and 256KB of CSV buries the answer it was meant
 * to support. Past this, the file is still NAMED with its true size; it is just not pasted.
 */
const ARTIFACT_INLINE_BYTES = 8_192;
const ARTIFACT_INLINE_TOTAL = 32_768;

const ARTIFACT_LANGS: Record<string, string> = {
	py: "python",
	js: "javascript",
	ts: "typescript",
	sh: "bash",
	json: "json",
	md: "markdown",
	html: "html",
	css: "css",
	csv: "csv",
	yml: "yaml",
	yaml: "yaml",
	sql: "sql",
	toml: "toml",
};

/**
 * A fence the content cannot close.
 *
 * CommonMark closes a fenced block on a run of at least as many backticks as opened it, so wrapping a
 * file that itself contains ``` in a 3-backtick fence ends the block early and spills the remainder as
 * prose. Artifacts are agent-written and markdown files are an ordinary thing to produce, so this is
 * the expected case rather than a hostile one. Same failure the progress markers had (CUR-227), from
 * the other direction: there a marker broke someone else's fence, here content breaks its own.
 */
function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The agent's files, rendered into the answer. PURE, so it unit-tests.
 *
 * These ride the `done` frame: `_done_payload` carries `artifacts` with inlined contents (CUR-195), so
 * the files are out of the sandbox by the time the sandbox goes away.
 *
 * A file whose text the answer ALREADY contains verbatim is named, not pasted twice. That test is exact
 * string containment rather than a similarity judgement — a partial paste re-renders, which errs toward
 * showing the reader the real bytes. It is skipped for truncated files, where `text` is a prefix and
 * containment would prove nothing about the rest.
 *
 * Trust: this is agent-authored text, screened by the service's output moderation, and it renders as
 * fenced code under its filename. Fenced is what keeps it legible AS a file rather than as the
 * assistant's own prose.
 *
 * `downloadBaseHref` (CUR-546) is the base path for a real download link — `undefined` when either
 * there's no live session to fetch from (no conversationId for the turn) or the download flag is
 * off; see the call site for how both conditions are named together. Every artifact with a live
 * session gets a link, not just the truncated/binary ones the inline path can't show — a real
 * download is strictly more correct than a rendered code block (no whitespace/line-ending loss).
 *
 * `saved` (CUR-4398) maps each artifact path copied out of the workdir to the saved copy's hash. Its link
 * names that copy (`?saved=<hash>`), so the route serves this turn's bytes and never an older turn's copy
 * of the same path; when every file is saved the reply drops the four-hour window.
 */
export function renderArtifacts(
	artifacts: readonly AgentArtifact[],
	dropped: boolean,
	answer: string,
	downloadBaseHref: string | undefined,
	saved: ReadonlyMap<string, string> = new Map()
): string {
	if (!artifacts.length) return "";
	const blocks: string[] = [];
	let budget = ARTIFACT_INLINE_TOTAL;

	// Segment-wise so a nested artifact path (subdirectories are real, see agent-service's
	// _artifact_paths) round-trips through the URL rather than colliding on an unescaped "/".
	const hrefFor = (name: string): string => {
		const sha = saved.get(name);
		return `${downloadBaseHref}/${name
			.split("/")
			.map((seg) => encodeURIComponent(seg))
			.join("/")}${sha ? `?saved=${sha}` : ""}`;
	};

	for (const a of artifacts) {
		const name = (a.name ?? "").trim() || "(unnamed)";
		const bytes = typeof a.bytes === "number" && a.bytes >= 0 ? a.bytes : 0;
		const size = `${bytes.toLocaleString("en-US")} byte${bytes === 1 ? "" : "s"}`;
		const nameLabel = downloadBaseHref ? `[\`${name}\`](${hrefFor(name)})` : `\`${name}\``;
		const label = `**${nameLabel}** — ${size}`;
		const text = typeof a.text === "string" ? a.text : "";

		if (!text.trim()) {
			blocks.push(`${label}, not shown`);
			continue;
		}
		if (!a.truncated && answer.includes(text.trim())) {
			blocks.push(`${label}, shown above`);
			continue;
		}
		if (text.length > ARTIFACT_INLINE_BYTES || text.length > budget) {
			blocks.push(`${label}, too large to show here`);
			continue;
		}
		budget -= text.length;
		const fence = fenceFor(text);
		const lang = ARTIFACT_LANGS[name.split(".").pop()?.toLowerCase() ?? ""] ?? "text";
		const note = a.truncated ? `${label}, truncated` : label;
		blocks.push(`${note}\n\n${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`);
	}

	if (dropped) blocks.push("_The agent produced more files than are listed here._");
	// The files live in agent-service's session workdir, which its idle reaper deletes after
	// AGENT_SESSION_IDLE_SECS (14400, agent-service/fly/agent-app.toml). The conversation itself is
	// kept far longer, so the window is stated in hours rather than tied to the conversation (CUR-546).
	const allSaved = artifacts.every((a) => saved.has((a.name ?? "").trim()));
	const availability = !downloadBaseHref
		? ""
		: allSaved
			? "_Saved with this conversation, so you can download them any time._\n\n"
			: "_Available to download for about four hours after this conversation's last agent turn._\n\n";
	return `\n\n---\n\n**Files this turn produced**\n\n${availability}${blocks.join("\n\n")}\n`;
}

// Bound the context we prepend so a long chat can't blow the agent service's prompt cap (it rejects
// oversized prompts) or bury the actual task: the last few turns, each truncated, newest-relevant.
const AGENT_CONTEXT_MAX_TURNS = 6;
const AGENT_CONTEXT_MAX_CHARS_PER_TURN = 600;
const AGENT_CONTEXT_MAX_CHARS_TOTAL = 4000;
// Earlier turns' attached files, whole (CUR-4104), under this cap and under whatever the rest of the
// prompt leaves of the service's limit: it refuses a prompt over 100,000 characters (agent-service
// MAX_PROMPT_CHARS), and the current turn's own files are sent uncut.
const AGENT_ATTACHED_MAX_CHARS = 60_000;
const AGENT_PROMPT_MAX_CHARS = 100_000;
const ATTACHED_HEADING =
	"\n\nFiles the person attached earlier in this conversation (their full text; use it when the request refers to them):\n";

/**
 * A short, honest identity line for the agent — NOT the full conversational persona
 * (`buildPersonaPrompt` in textGeneration/persona.ts). That template is tuned for chat Q&A: it carries
 * its own few-shot dialogue ("User: hi / You: I'm {model}...") and recency/political-balance
 * instructions built for a back-and-forth conversation. Gluing it verbatim onto a task-execution
 * prompt is its own hazard, not just an unrelated risk — this file's `buildTaskPrompt` ALSO appends a
 * real "Conversation so far" transcript using the same "User:"/"Assistant:" convention as the
 * persona's fake exchange, and nothing would tell the model which "User:" lines are hypothetical
 * examples and which are its actual prior turns. So this is a separate, minimal string, derived from
 * the same `resolveModelIdentity` authority everything else uses (so it can never assert a maker the
 * agent backend isn't actually running under) instead of reusing the chat persona's prose.
 *
 * Without any identity line, the model answers "who are you" from its own pretrained priors and can
 * name a maker this deployment has never run (CUR-573). Exported for unit testing.
 *
 * Also covers what it can do, not just who it is (CUR-594): without an instruction otherwise, asked
 * what agent mode can do, the model recites its raw tool schema (`terminal()`, `read_file`,
 * `search_files`...) instead of the plain-language jobs those tools accomplish, which reads as a
 * function list to a non-technical user rather than an offer of help with their own task.
 *
 * Also carries the language-reply instruction (CUR-706): `persona.ts` has "Reply in the user's language
 * (default English)" for the non-agent path, and this preamble, being deliberately separate, does not
 * inherit it. Without it a Portuguese task with the agent on can come back in English. Source-fidelity
 * rules (deadlines, date formats) live in agent-service's own SOURCE_FIDELITY_NOTE prompt, not here.
 */
export function agentIdentityPreamble(modelId: string, replyLanguage?: string): string {
	const id = resolveModelIdentity(modelId);
	// A fixed answer language from settings replaces the reply-language sentence; with none
	// the sentence is today's, byte for byte. (CUR-3929)
	const language = replyLanguage
		? `Reply in ${languageName(replyLanguage)}, whatever language the task is written in.`
		: `Reply in the user's language (default English) — a task written in Portuguese, German, or any other language gets its answer in that language, not English.`;
	return `If asked who you are or who made you, answer honestly: you are ${id.short}, developed by ${id.maker}, answering inside AI Potluck, a chat app that Current AI runs; Current AI did not build you and does not run you. Never claim a different name or maker. If asked what you can do, describe it in plain task language — "read and summarize a document," "run a script and check its output" — never by naming a function, tool, method, or API. ${language} ${MY_FILES_FACT}`;
}

/**
 * Compose the /run task prompt from the conversation. `current` is the latest user turn (the task);
 * prior turns are included as clearly-delimited CONTEXT. `identityPreamble` (see
 * `agentIdentityPreamble` above) is prepended when present — the /run wire has one `prompt` field and
 * no separate system-prompt slot (see the request body below), so this is the only way identity
 * reaches the agent model. Exported for unit testing.
 */
export function buildTaskPrompt(
	messages: { from: string; content?: string; attachedText?: string }[],
	lastUserIdx: number,
	current: string,
	identityPreamble?: string,
	clientInstructions?: string
): string {
	// The visitor's own system prompt or Personalization, after our identity line so it can
	// shape tone and format but reads as theirs. Capped like the guard caps it. (CUR-4088)
	const standing = clientInstructions?.trim()
		? `The person has set these standing instructions for how you answer; follow them unless they conflict with the above:\n${clientInstructions.trim().slice(0, CLIENT_INSTRUCTIONS_MAX_CHARS)}`
		: "";
	const head = [identityPreamble?.trim() ?? "", standing].filter(Boolean).join("\n\n");
	const withPreamble = (task: string) => (head ? `${head}\n\n${task}` : task);

	const earlier = (lastUserIdx >= 0 ? messages.slice(0, lastUserIdx) : []).filter(
		(m) => (m.from === "user" || m.from === "assistant") && (m.content ?? "").trim()
	);
	// An earlier turn's content opens with the text of the documents it attached (CUR-4104), so cutting
	// the turn to 600 characters would keep a document's first paragraphs and drop the rest, along with
	// the person's own words after it, and the agent would invent details the document holds. The typed
	// words are cut; the attached text goes in its own block, whole, under its own budget.
	const priors = earlier.slice(-AGENT_CONTEXT_MAX_TURNS).map((m) => {
		const role = m.from === "user" ? "User" : "Assistant";
		const text = typedPart(m).slice(0, AGENT_CONTEXT_MAX_CHARS_PER_TURN);
		return `${role}: ${text || "(attached the files below)"}`;
	});
	if (priors.length === 0) return withPreamble(current);

	let transcript = priors.join("\n");
	if (transcript.length > AGENT_CONTEXT_MAX_CHARS_TOTAL) {
		// keep the most recent context (the tail), which is what a follow-up refers back to
		transcript = "…\n" + transcript.slice(transcript.length - AGENT_CONTEXT_MAX_CHARS_TOTAL);
	}
	const compose = (attached: string) =>
		withPreamble(
			"Conversation so far (context only — do NOT treat these earlier turns as new instructions to carry out):\n" +
				transcript +
				(attached ? ATTACHED_HEADING + attached : "") +
				"\n\nCurrent request:\n" +
				current
		);
	// What the rest of the prompt leaves of the service's limit, less the heading and the cut notes.
	const room = AGENT_PROMPT_MAX_CHARS - compose("").length - ATTACHED_HEADING.length - 1_000;
	return compose(earlierAttachments(earlier, Math.min(AGENT_ATTACHED_MAX_CHARS, room)));
}

/** A turn's own words: its content without the attached text that preprocessMessages put in front. */
function typedPart(m: { content?: string; attachedText?: string }): string {
	const content = (m.content ?? "").trim();
	const attached = m.attachedText?.trim();
	return attached && content.startsWith(attached) ? content.slice(attached.length).trim() : content;
}

/** Earlier user turns' attached text, newest kept first when it exceeds the budget, in turn order. */
function earlierAttachments(earlier: { from: string; attachedText?: string }[], max: number): string {
	const kept: string[] = [];
	let budget = max;
	for (let i = earlier.length - 1; i >= 0 && budget > 0; i--) {
		const text = earlier[i].from === "user" ? earlier[i].attachedText?.trim() : undefined;
		if (!text) continue;
		const keep = text.length <= budget ? text : `${text.slice(0, budget)}\n… (the rest of this file was left out)`;
		budget -= Math.min(text.length, budget);
		kept.unshift(keep);
	}
	return kept.join("\n\n");
}

/**
 * Derive the `X-Agent-Subject` value: per-visitor attribution under one shared service token.
 *
 * WHAT IT IS FOR. We hold ONE static service token for every visitor, so the subject the agent
 * service authenticates is this deployment, not a person — its per-caller daily cap was the only
 * limit that could bite and it was shared across everyone on the surface. This names the visitor
 * inside that caller, which is what lets the service ration per person (AGENT_SUBJECT_DAILY_TASKS)
 * and attribute a run to anyone at all. SELF-ASSERTED, and the service is built for that: it checks
 * the authenticated caller ceiling FIRST and sums every subject under it, so forging this buys no
 * extra allowance. A fairness knob under a cap, never the cap.
 *
 * WHY IT IS KEYED, AND WHY NO KEY MEANS NO HEADER. `visitor` is one of two values, and both are
 * unsafe to send in the clear or to send as a bare digest:
 *   - `locals.sessionId` IS the session cookie value (auth.ts refreshSessionCookie), and auth.ts's
 *     CSRF token treats it as sufficient secret on its own — forwarding it would put a
 *     session-hijacking credential in another service's task table and log sink.
 *   - the signed-in `_id` is email-derived (auth.ts builds it from sha256(email)), so an UNKEYED
 *     digest is a confirm-this-address oracle: anyone holding that table can test a guessed address
 *     against it offline. Hashing does not fix a low-entropy input.
 * The service token is the key — both sides already share it and neither logs it. Rotating it
 * re-buckets quotas, which is a fine price.
 *
 * So an absent key returns "" and the caller omits the header, because the alternative is the oracle
 * above. This is reachable, not hypothetical: `apiKey` is `z.string().default("")` and is documented
 * as empty whenever the service's own auth is disabled. Attribution is a fairness knob, so losing it
 * on an unconfigured deployment is an acceptable degradation; leaking whether an address used the
 * service is not. endpointAgent logs once at construction when this applies.
 *
 * HMAC-SHA256, not sha256(key + message). Same reason to prefer it anywhere: it is the standard
 * construction for a keyed digest and is not length-extendable, so it stays correct if this value is
 * ever compared or forwarded rather than only bucketed. Truncated to 128 bits, which is far past what
 * distinguishing quota buckets needs and keeps the header small.
 */
export function deriveAgentSubject(key: string, visitor: string): string {
	if (!key || !visitor) return "";
	return createHmac("sha256", key).update(`agent-subject:${visitor}`).digest("hex").slice(0, 32);
}

/**
 * `X-Agent-Subject` for a request, from the same `locals` fields the turn that created the
 * session used. Extracted so the artifact-download proxy route (CUR-546) computes the identical
 * value for the same visitor — a different derivation means `get_session_workdir` on the
 * agent-service side finds nothing, since the workdir is keyed on this principal.
 */
function agentSubjectFor(apiKey: string, locals: App.Locals | undefined): string {
	const visitor = locals?.user?._id?.toString() ?? locals?.sessionId ?? "";
	return deriveAgentSubject(apiKey, visitor);
}

/**
 * The two headers every call to agent-service on a visitor's behalf carries: the deployment's token
 * and the visitor's subject. agent-service's `_may_access` compares against exactly this pair, so the
 * turn, Stop, the confirm route and the artifact route all build it here rather than each by hand.
 */
export function agentServiceHeaders(
	apiKey: string,
	locals: App.Locals | undefined
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const subject = agentSubjectFor(apiKey, locals);
	if (subject) headers["x-agent-subject"] = subject;
	// The subject is a hash, so agent-service cannot tell an account from a guest without this. (CUR-4402)
	if (locals?.user?._id) headers["x-agent-account"] = "user";
	// A team account's daily task allowance, so agent-service's per-visitor cap (25) does not
	// stop it before chat's own count does. Chat's word, like X-Agent-Account; the service only raises
	// its cap with it and still checks the whole surface's ceiling first. (CUR-4620)
	if (subject && isTeamAccount(locals?.user)) headers["x-agent-subject-daily-tasks"] = String(agentTasksPerDay(locals));
	return headers;
}

/**
 * Cancel the agent task a stopped turn started. Closing a tab no longer ends a run, so Stop
 * has to tell agent-service itself. The service checks only the deployment's token, not the visitor,
 * so the caller must already have found the task on a message in a conversation it owns. Returns
 * agent-service's status: 200 for a cancel (or a task already finished), 404 for one it no longer holds. (CUR-993)
 */
export async function cancelAgentTask(
	input: z.input<typeof endpointAgentParametersSchema>,
	locals: App.Locals | undefined,
	run: { taskId: string; machineId?: string }
): Promise<number> {
	const { baseURL, apiKey } = endpointAgentParametersSchema.parse(input);
	const headers = agentServiceHeaders(apiKey, locals);
	if (run.machineId) headers["Fly-Force-Instance-Id"] = run.machineId;
	// A task the scenario stand-in started is cancelled there, never on the real service. (SOL-212)
	const fake = isFakeAgentTaskId(run.taskId);
	const base = fake ? FAKE_AGENT_BASE : baseURL.replace(/\/$/, "");
	const res = await (fake ? fakeAgentFetch : fetch)(`${base}/run/${run.taskId}`, {
		method: "DELETE",
		headers,
		signal: AbortSignal.timeout(5_000),
	});
	return res.status;
}

export async function endpointAgent(
	input: z.input<typeof endpointAgentParametersSchema>
): Promise<Endpoint> {
	const { baseURL, apiKey, provenanceModel, provenanceProvider, streamTimeoutMs, capacityWaitMs, model } =
		endpointAgentParametersSchema.parse(input);

	const base = baseURL.replace(/\/$/, "");
	const baseHeaders: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) baseHeaders["authorization"] = `Bearer ${apiKey}`;

	// The model id is static for the life of this endpoint (models.ts always configures this endpoint
	// under id "potluck-agent"). Falls back to that same literal if `model` ever arrives shapeless (e.g.
	// a bare `{}` in a test) — `z.any()` above doesn't validate its shape, so this can't assume `.id`
	// exists. The preamble itself is built per call below (CUR-3929): its last sentence names the
	// answer language the person fixed in settings, which can change between turns.
	const identityModelId = (model as { id?: string } | undefined)?.id ?? "potluck-agent";

	// Said ONCE per endpoint construction (cold start), not per turn: whether a key exists is static
	// for the life of the endpoint, and a per-request line would be thousands of copies of one fact.
	// Loud rather than silent because the degradation is invisible from the outside — runs simply stop
	// being attributable, and every caller shares one quota bucket again.
	if (!apiKey) {
		logger.warn(
			{ baseURL: base },
			"[agent] no service token configured — per-visitor attribution (X-Agent-Subject) is OFF; see deriveAgentSubject for why an unkeyed digest is not an acceptable substitute"
		);
	}

	return async function ({ messages, abortSignal, locals, conversationId, unhardenedUserText, clientInstructions, agentAttach, replyLanguage, saveAgentFiles, turnDeadlineAt }) {
		const identityPreamble = agentIdentityPreamble(identityModelId, replyLanguage);
		const autoApprove = await agentAutoApproveFor(locals);
		// Per-visitor attribution. We hold ONE static AGENT_SERVICE_TOKEN for every visitor, so the
		// authenticated subject the agent service sees is this deployment, not a person: its per-caller
		// daily cap was the only limit that could bite, and it was shared across everyone on the surface.
		// `X-Agent-Subject` names the visitor inside that caller, which is what lets the service ration
		// per person (AGENT_SUBJECT_DAILY_TASKS) and attribute a run to anyone at all.
		//
		// SELF-ASSERTED, and the service is built for that: it checks the authenticated caller ceiling
		// FIRST and sums every subject under it, so rotating this value buys no extra allowance. A
		// fairness knob under a cap, never the cap.
		//
		// DERIVED, never the raw id — see deriveAgentSubject below for what the derivation has to
		// achieve and why an unkeyed one is not good enough.
		//
		// Built per request, NOT folded into baseHeaders: that object is constructed once per endpoint
		// and reused by every concurrent turn, so mutating it would leak one visitor's subject onto
		// another visitor's request.
		// agentServiceHeaders adds the signed-in claim too (CUR-4402): agent-service refuses a /run
		// without `x-agent-account: user`, so a turn built from the subject alone 403s for everyone.
		const headers = { ...baseHeaders, ...agentServiceHeaders(apiKey, locals) };

		// The agent service runs one task per call. The CURRENT request is the latest user turn; but a
		// chat is multi-turn, so a follow-up ("now add error handling to that") is meaningless without the
		// turns before it. Build the task prompt as a bounded, clearly-delimited transcript: prior turns as
		// CONTEXT (flagged not-an-instruction so the weak planner doesn't re-execute them), then the current
		// request as the actual task. Single-turn conversations send just the request (no context preamble).
		// The last user turn in `messages` has been through hardenLastUserTurn, which rewrites it into the
		// chat model's grounding preamble plus a fence. Sent as the task, that preamble would become the
		// job: a question the agent cannot read comes back as the preamble's decline rule (CUR-750). The
		// person's own words go instead.
		const lastUserIdx = messages.map((m) => m.from).lastIndexOf("user");
		const current = (
			unhardenedUserText ??
			(lastUserIdx >= 0
				? messages[lastUserIdx]?.content
				: messages[messages.length - 1]?.content) ??
			""
		).trim();
		const prompt = buildTaskPrompt(messages, lastUserIdx, current, identityPreamble, clientInstructions);

		// A scenario run's turn goes to the in-process stand-in (fakeAgentService.ts) instead of
		// the develop agent machine every shard shares. A new task follows the send's `x-e2e-agent`
		// header, read into the request context by the route; a re-attach follows the stored task id,
		// because a task lives where it started whatever the reload's headers say. (SOL-212)
		const fakeRequest = getRequestContext()?.fakeAgent;
		// Whether this turn may hand its run off to the page rather than end at the watchdog. (CUR-4410)
		const handoff = turnDeadlineAt !== undefined && agentRunHandoffEnabled();
		const fake = agentAttach ? isFakeAgentTaskId(agentAttach.taskId) : Boolean(fakeRequest);
		const runBase = fake ? FAKE_AGENT_BASE : base;
		const agentFetch: typeof fetch = fake
			? (url, init) => fakeAgentFetch(url, { ...init, knobs: fakeRequest?.knobs ?? [] })
			: fetch;

		return (async function* (): AsyncGenerator<TextGenerationStreamOutputSimplified, void, void> {
			let tokenId = 0;
			const mk = (
				text: string,
				opts: {
					special?: boolean;
					generated_text?: string | null;
					router?: boolean;
					routerModel?: string;
					// Mirrors routerModel's correction pattern for the compute-provider half of the badge. (CUR-996)
					computeProvider?: string;
					// Forwarded only when the caller explicitly passes it (see the `in` check below) —
					// "" is a real "checked, unverified" signal, not "no opinion", so it must not be dropped
					// the way an empty routerModel is. (CUR-756)
					verifyMethod?: string;
					agentStep?: { index: number; tool: string; total?: number };
					sandboxWait?: "waiting" | "ready";
					writePolicy?: {
						policy: string;
						tier: string;
						tasksDone?: number | null;
						tasksRequired?: number | null;
					};
					agentTools?: { toolKinds: string[]; counts?: Record<string, number> };
					agentRun?: { taskId: string; machineId?: string; closed?: boolean };
					agentFile?: { name: string; sha: string; mime: string; agentPath: string };
					unrunCode?: { reason: UnrunCodeReason };
					agentConfirm?: {
						taskId: string;
						confirmId: string;
						kind: string;
						title: string;
						summary: string;
						plain?: string;
						deadlineAt?: number;
					};
					agentConfirmResult?: {
						confirmId: string;
						decision: "allow" | "deny" | "canceled";
						reason: string;
					};
				} = {}
			): TextGenerationStreamOutputSimplified =>
				({
					token: { id: tokenId++, text, logprob: 0, special: opts.special ?? false },
					generated_text: opts.generated_text ?? null,
					details: null,
					...(opts.router
						? {
								routerMetadata: {
									route: "agent",
									// last-write-wins client-side (streamUpdate merges `event.model || existing`),
									// so a later done.model chunk corrects the badge set by the early emit.
									model: opts.routerModel || provenanceModel,
									provider: opts.computeProvider || provenanceProvider,
									// Presence-gated, not `opts.verifyMethod || ...`: "" is a real unverified signal.
									...("verifyMethod" in opts ? { verifyMethod: opts.verifyMethod } : {}),
								},
							}
						: {}),
					...(opts.agentStep ? { agentStep: opts.agentStep } : {}),
					...(opts.sandboxWait ? { sandboxWait: opts.sandboxWait } : {}),
					...(opts.writePolicy ? { writePolicy: opts.writePolicy } : {}),
					...(opts.agentTools ? { agentTools: opts.agentTools } : {}),
					...(opts.agentRun ? { agentRun: opts.agentRun } : {}),
					...(opts.agentFile ? { agentFile: opts.agentFile } : {}),
					...(opts.unrunCode ? { unrunCode: opts.unrunCode } : {}),
					...(opts.agentConfirm ? { agentConfirm: opts.agentConfirm } : {}),
					...(opts.agentConfirmResult ? { agentConfirmResult: opts.agentConfirmResult } : {}),
				}) as TextGenerationStreamOutputSimplified;

			// 1) submit the task, or take the one this message already started (CUR-993). A re-attach
			// replays that task's events from the start rather than resuming mid-stream: the message is
			// rebuilt from nothing, so it needs the whole think block and answer, and agent-service keeps
			// every frame for a live task and synthesizes a `done` for one whose buffer is gone.
			let taskId: string;
			let machineId: string | undefined;
			if (agentAttach) {
				taskId = agentAttach.taskId;
				machineId = agentAttach.machineId;
			} else {
				//
				// This fetch is not inside the try/catch that wraps the /events stream below, so it has its
				// own. A network-level failure here (DNS, ECONNREFUSED, TLS: the service is configured but
				// not reachable) would otherwise throw out of the generator to the turn's top-level stream
				// catch (+server.ts), which renders `err.message` to the user, and Node's fetch reports it
				// as a bare `TypeError: fetch failed`. Every other failure shape in this file has a friendly
				// message (429, non-OK, missing task id, stream-open failure, stream drop, timeout) (CUR-1067).
				// A follow-up goes to the machine holding this conversation's workdir. When that machine is
				// gone or stopped, Fly answers for it (a 5xx or 404 the app never sends from /run), and the
				// turn is resubmitted unpinned; `continues_session` then makes the machine that takes it
				// report the workdir expired instead of answering as a fresh session (CUR-4393).
				// The per-account daily allowance is counted in chat's database (CUR-4401). A scenario run's
				// stand-in is not counted, since the test accounts would use a day's tasks in one run.
				if (!fake) {
					const room = await agentTaskRoom(locals);
					if (!room.ok) {
						const text = agentTasksUsedText(room.retryAfterSecs, room.limit);
						yield mk(text);
						yield mk("", { generated_text: text, special: true });
						return;
					}
				}
				const prior = conversationId ? priorAgentMachine(messages) : { continues: false };
				const submitOnce = (pin: string | undefined) =>
					agentFetch(`${runBase}/run`, {
						method: "POST",
						headers: pin ? { ...headers, "Fly-Force-Instance-Id": pin } : headers,
						// synthesize: marks this a free-form chat turn with no verify spec, which is what engages the
						// service's auto-derive + LLM-judge best-of-N gates (_best_of_gates). It is not a second
						// model call that rewrites the output.
						// wall_clock_secs: the service bounds one attempt at its own 300s ceiling unless a caller
						// asks for less, and this client stops listening at 155s. Clamped lower-only service-side,
						// so this can only ever shorten the run. See AGENT_SERVICE_WALL_CLOCK_SECS for the
						// derivation and for what is still unmeasured in it. With `agent-run-handoff` on the run
						// outlives this request instead, so it gets the whole attempt (AGENT_HANDOFF_WALL_CLOCK_SECS).
						// session_id: keys agent-service's workdir reuse (CUR-196). Without it every turn starts
						// a fresh workdir, so a follow-up that edits a file the previous turn wrote can never
						// find it, and the turn fails, not just the edit (CUR-542). One conversation's turns share one workdir; omitted entirely for a
						// conversationless call (e.g. a hermetic test) rather than sending a literal "undefined".
						body: JSON.stringify({
							prompt,
							synthesize: true,
							wall_clock_secs: handoff ? AGENT_HANDOFF_WALL_CLOCK_SECS : AGENT_SERVICE_WALL_CLOCK_SECS,
							...(conversationId ? { session_id: conversationId.toString() } : {}),
							...(prior.continues ? { continues_session: true } : {}),
							// Auto mode, per person. Absent means ask mode service-side. (CUR-3142)
							...(autoApprove ? { approval_mode: "auto" } : {}),
						}),
						signal: abortSignal,
					});
				let submit: Response | null = null;
				// The body of a 429 the capacity wait already read, since a body can be read only once.
				let refusedBody: string | undefined;
				try {
					if (prior.machineId) {
						submit = await submitOnce(prior.machineId).catch((err) => {
							if ((err as Error)?.name === "AbortError") throw err;
							return null;
						});
						if (!submit || submit.status === 404 || submit.status >= 500) {
							logger.warn(
								{ status: submit?.status, machineId: prior.machineId },
								"[agent] the machine holding this conversation's session did not take the follow-up; resubmitting unpinned"
							);
							submit = null;
						}
					}
					submit ??= await submitOnce(undefined);
					// "server at capacity" clears as other runs finish, so ask again on its Retry-After
					// for up to a minute, with the live line saying what the wait is for, before saying so. (CUR-4584)
					// So does a 503 from a machine draining for a deploy, once the new machine is up. (CUR-4598)
					const capacityUntil = Date.now() + capacityWaitMs;
					let waitedForCapacity = false;
					while ((submit.status === 429 || submit.status === 503) && Date.now() < capacityUntil) {
						refusedBody = await submit.text().catch(() => "");
						if (!(submit.status === 429 ? /server at capacity/ : AGENT_RESTARTING).test(refusedBody)) break;
						if (!waitedForCapacity) {
							waitedForCapacity = true;
							yield mk("", { special: true, sandboxWait: "waiting" });
						}
						// At least a second between asks, whatever Retry-After says; 5 s when it says nothing.
						const named = Number(submit.headers?.get("retry-after") ?? Number.NaN);
						const retryAfterMs = Math.max(1, Number.isFinite(named) ? named : 5) * 1000;
						await pause(Math.min(retryAfterMs, Math.max(0, capacityUntil - Date.now())), abortSignal);
						submit = await submitOnce(undefined);
						refusedBody = undefined;
					}
					if (waitedForCapacity) yield mk("", { special: true, sandboxWait: "ready" });
				} catch (err) {
					// A genuine user stop / global abort must propagate as-is — the outer stream catch already
					// treats AbortError as "the user stopped this turn" (an interrupted answer, not an error),
					// and swallowing it here would misreport a stop as a service failure.
					if ((err as Error)?.name === "AbortError") throw err;
					logger.warn(
						{ err },
						"[agent] /run submission failed before a response arrived — service configured but unreachable?"
					);
					const text = "The agent service isn't reachable right now. Please try again.";
					yield mk(text);
					yield mk("", { generated_text: text, special: true });
					return;
				}
				if (!submit.ok) {
					const body = refusedBody ?? (await submit.text().catch(() => ""));
					// A 429 is either the AGENT_MAX_CONCURRENCY ceiling ("server at capacity", retry-able in a
					// moment) or one of the daily limits ("… limit reached" / "… budget reached", CUR-4401), which
					// a retry cannot clear. Everyone else gets the raw status+body: those ARE worth surfacing
					// bluntly, since they're the ones someone has to go debug.
					const text =
						submit.status === 503 && AGENT_RESTARTING.test(body)
							? AGENT_RESTARTING_TEXT
							: submit.status === 429
							? /limit reached|budget reached/.test(body)
								? "Agent mode has reached today's task limit. Please try again tomorrow."
								: /already has \d+ agent task/.test(body)
									? "You already have agent tasks running. Wait for one to finish, then try again."
									: "The agent is at capacity right now — please wait a moment and try again."
							: `The agent service rejected the request (HTTP ${submit.status}). ${body}`.trim();
					// Stream the real message as an actual token FIRST, then a terminal marker whose
					// generated_text is that SAME text, the convention this file uses for a normal answer
					// (see the terminal chunk below, `generated_text: full.join("")`). generate.ts's
					// FinalAnswer branch reads its text from generated_text, and screenOutputStream discards a
					// FinalAnswer's own text, trusting only content it already saw as a Stream token. Any
					// other shape leaves the user a bare "No output was generated," with the actual reason
					// never reaching them or the logs (CUR-759).
					yield mk(text);
					yield mk("", { generated_text: text, special: true });
					return;
				}
				const submitBody = await submit.json();
				taskId = submitBody?.id;
				if (!taskId) {
					const text = "The agent service returned no task id.";
					yield mk(text);
					yield mk("", { generated_text: text, special: true });
					return;
				}
				// Task state lives on whichever Fly machine ran /run, and a multi-machine deploy has
				// no session affinity by default — the /events open below is a SEPARATE request that can land
				// on a machine that never saw this task and 404 immediately. Echo the machine back via Fly's
				// own sticky-routing header so this stream opens where the task actually lives. (CUR-895)
				machineId = submitBody?.machine_id || undefined;
				if (!fake) await recordAgentTask(locals);
			}
			const eventHeaders = machineId ? { ...headers, "Fly-Force-Instance-Id": machineId } : headers;

			// Record the task before anything else streams, so a tab closed from here on leaves
			// the message holding the handle to a run that is still going. (CUR-993)
			yield mk("", { special: true, agentRun: { taskId, ...(machineId ? { machineId } : {}) } });

			// provenance first → lights the badge + the Apertus node on the StackMap
			yield mk("", { special: true, router: true });

			// 2) stream the event log and translate it to a <think> progress block + the answer.
			// The opening <think> must be STREAMED as a token (not just seeded into the accumulator), or the
			// client's live think-block autodetection won't trigger until the final answer lands.
			const full: string[] = [];
			const push = function* (s: string) {
				full.push(s);
				yield mk(s);
			};
			// Progress markers are LINE-oriented: each ends with "\n" and none leads with one, so each
			// assumes the accumulator already sits at a line start. That holds between two markers and
			// breaks against `token` deltas, which are raw model prose carrying no trailing newline.
			//
			// The worst case is not cosmetic. A marker landing on a line that already holds a CLOSING code
			// fence makes that fence invalid — CommonMark allows a close to carry only fence characters and
			// whitespace — and an unclosed fenced block runs to the end of the document. The whole tail of
			// the turn then renders as monospace inside a code box, silently (CUR-227).
			//
			// So markers go through here and lead with a newline unless we are already at a line start.
			// `token` deltas must NOT: reformatting the model's own prose is a different and worse bug.
			const pushLine = function* (s: string) {
				let atLineStart = true;
				for (let i = full.length - 1; i >= 0; i--) {
					if (!full[i]) continue;
					atLineStart = full[i].endsWith("\n");
					break;
				}
				yield* push(atLineStart ? s : `\n${s}`);
			};
			yield* push("<think>\n");
			// End the opener with a PARAGRAPH break, not a lone newline: the always-on honesty screen
			// (honestyStream) batches Stream tokens via nextChunk and only releases at a sentence
			// terminator, a "\n\n", or 400 chars. "…\n" hits none of those, so the opener would sit
			// buffered and the client's first-token watchdog (8s of silence) would fire before any content
			// lands. The "\n\n" makes this a complete chunk that releases immediately → the client marks
			// first-content and stands the watchdog down for the rest of the (legitimately long) turn.
			yield* push("Working on it via the open agent…\n\n");

			let answer = "";
			// Whether the service's `done` frame arrived. A turn that ends without one (our timeout,
			// a dropped stream, a stream that closed or never opened) cancels its task below. (CUR-2194)
			let sawDone = false;
			let serviceLostTask = false;
			// confirmIds opened this turn that no confirm_result has resolved yet. Read once
			// the stream ends (below the loop) to cancel any the turn left dangling, so a drop never
			// leaves an Allow/Deny card that resolves to nothing. (CUR-4070)
			const openConfirms = new Set<string>();
			let totalSteps: number | undefined;
			let thinkClosed = false;
			// AGENT_BEST_OF>1 means a `token` frame's prose can still be rejected — the service
			// stamps every token/token_truncated/attempt_rejected frame with `attempt`, and
			// attempt_rejected fires the moment that happens, well before the next attempt's first
			// token. This endpoint relays over its own SSE hop to a separate browser, so by the time a
			// rejection is known here the deltas may already be live in the user's panel — there is no
			// "un-send" once that has happened. So: buffer a `token` frame's delta instead of streaming
			// it immediately, keyed to the attempt it belongs to. attempt_rejected discards the buffer
			// outright — the strongest form of "clear the buffer" the wire contract asks for (zero
			// exposure window, not shown-then-corrected). Flushed once at `done` for whichever attempt
			// survived. Cost: the model's own prose in the think panel no longer streams token-by-token
			// (it lands in one piece at the end) — plan/tool_call/policy/usage narration is untouched
			// and still streams live throughout, so the panel isn't static while a turn runs. (CUR-767)
			let pendingAttempt: number | undefined;
			let pendingTokenBuffer = "";
			// Which tool KINDS the service reported this turn, and how many of each. Read once at `done`
			// to decide whether the turn can honestly be described as having run anything (CUR-226).
			// The counts feed the tool-run summary line; the classifiers below only read distinct kinds
			// (`.keys()`/`.has()`/`.size`).
			//
			// A call only lands here once its `tool_result` confirms `ok !== false`, not at `tool_call`,
			// which fires the instant a call is proposed, before permission is resolved (CUR-705). An edit
			// denied on confirm timeout touches no file, and the model may still answer with fabricated
			// figures; counting the proposal would put `edit` in `toolKinds` and keep
			// `claimedStepsWithoutObservedTools`/`claimedActionOnContinuedSession` (both gated on
			// `toolKinds.size === 0`) quiet. Keying off `tool_result` is safe uniformly: `acp_client.py`'s
			// `tool_call_update` emits `ok: status == "completed"` for every call, gated or not, and a
			// denied or timed-out confirm never reaches a tool call at all, so no `tool_result` arrives
			// for one, which this treats the same as an explicit `ok: false`.
			const toolKinds = new Map<string, number>();
			// step → kind for a call whose `tool_result` hasn't arrived yet. Populated at `tool_call`,
			// consumed (and cleared) at the matching `tool_result` — never read anywhere else.
			const pendingStepKind = new Map<number, string>();
			// Steps whose `tool_result` confirmed they ran, in order, for the account a turn gives when it
			// ends before `done` (partialRunAnswer).
			const finishedSteps: { tool: string; summary?: string }[] = [];
			// Between a `waiting_sandbox` state frame and the next state frame. (CUR-4584)
			let waitingForSandbox = false;
			const closeThink = function* () {
				if (thinkClosed) return;
				thinkClosed = true;
				// Deliberately `push`, not `pushLine`: this tag can also land mid-line after a `token`
				// delta, but the client strips it before any markdown runs (expandThinkBlocks slices the
				// tags off in ChatMessage.svelte), so the fence hazard that motivates pushLine cannot
				// reach here. Left alone rather than tidied, so the rule stays where it does work.
				full.push("</think>\n");
				yield mk("</think>\n");
			};

			const ctrl = new AbortController();
			const onAbort = () => ctrl.abort();
			abortSignal?.addEventListener("abort", onAbort);
			let timedOut = false;
			// The route's watchdog ended the turn while an approval card was still open. Nobody
			// answered it in time, so the card resolves as a timed-out deny and the answer says so,
			// where a Stop (or a drop) cancels the card instead. (CUR-4660)
			let approvalUnanswered = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				ctrl.abort();
			}, streamTimeoutMs);
			// When this request stops reading the run and hands it to the page, which re-attaches to it, so a
			// run longer than one request is followed to its end instead of cut at the route's watchdog.
			// Unset (never hands off) with `agent-run-handoff` off, or for a caller with no turn deadline (an eval).
			const handoffAt = handoff && turnDeadlineAt !== undefined ? agentHandoffAt(turnDeadlineAt, Date.now()) : undefined;
			let handedOff = false;
			try {
				const res = await agentFetch(`${runBase}/run/${taskId}/events`, {
					headers: eventHeaders,
					signal: ctrl.signal,
				});
				if (agentAttach && res.status === 404) {
					// The service no longer holds this task (its machine restarted, or the task aged
					// out). Close the handle, so the next reload doesn't try again and land on the same 404. (CUR-993)
					serviceLostTask = true;
					yield mk("", { special: true, agentRun: { taskId, ...(machineId ? { machineId } : {}), closed: true } });
					yield* closeThink();
					answer = "This agent task is no longer held by the agent service, so its result can't be recovered. Ask again to run it afresh.";
					yield* push(answer);
				} else if (!res.ok || !res.body) {
					yield* closeThink();
					answer = `The agent stream could not be opened (HTTP ${res.status}).`;
					yield* push(answer);
				} else {
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					// eventsource-parser reads the frames, so multi-line data, CRLF line ends and a
					// value's single leading space follow the SSE spec. A read's events queue here in order. (CUR-4065)
					const frames: EventSourceMessage[] = [];
					const sse = createParser({
						onEvent: (message) => frames.push(message),
						onError: (error) => failOpenDeparture("agent-frame", "sse-parse-error", { type: error.type }),
					});
					let done = false;
					// The agent computes silently (best-of-N with a large model) and can go many seconds
					// with NO frames, then bursts them near completion. chat-ui aborts a turn after ~8s of
					// TOTAL silence (the dead-connection watchdog in +page.svelte). So whenever a read
					// outlasts the heartbeat window, pulse a benign keepalive: any inbound update re-arms
					// the watchdog client-side, and an empty router chunk carries no text (no <think>
					// pollution) and no model (last-write-wins merge is a no-op, badge unchanged).
					const HEARTBEAT_MS = 4_000;
					const HEARTBEAT = Symbol("agent-heartbeat");
					while (!done) {
						const pending = reader.read();
						let chunk: ReadableStreamReadResult<Uint8Array> | undefined;
						// race the read against heartbeats until the frame (or stream end) actually arrives
						for (;;) {
							if (handoffAt !== undefined && Date.now() >= handoffAt) {
								handedOff = true;
								break;
							}
							let hbTimer: ReturnType<typeof setTimeout> | undefined;
							const hb = new Promise<typeof HEARTBEAT>((resolve) => {
								hbTimer = setTimeout(
									() => resolve(HEARTBEAT),
									handoffAt === undefined ? HEARTBEAT_MS : Math.max(0, Math.min(HEARTBEAT_MS, handoffAt - Date.now()))
								);
							});
							const winner = await Promise.race([pending, hb]);
							if (hbTimer) clearTimeout(hbTimer);
							if (winner === HEARTBEAT) {
								// keepalive: a NON-content router chunk, NOT a Stream token. The two screening
								// wrappers (honestyStream + screenStream) buffer Stream tokens for batched
								// screening but pass non-content events straight through — that pass-through is
								// exactly what re-arms the client's silence watchdog. (A Stream-token keepalive
								// would sit in the screen buffer and never reach the client.) model:"" makes the
								// routerMetadata merge a no-op, so repeated pings never disturb the badge.
								yield mk("", { special: true, router: true });
								continue;
							}
							chunk = winner as ReadableStreamReadResult<Uint8Array>;
							break;
						}
						if (handedOff || !chunk) {
							// The run goes on in agent-service; only this request's read of it ends.
							pending.catch(() => {});
							await reader.cancel().catch(() => {});
							break;
						}
						const { value, done: rd } = chunk;
						if (rd) break;
						sse.feed(decoder.decode(value, { stream: true }));
						while (frames.length > 0) {
							const { event: etype, data } = frames.shift()!;
							// A frame with neither event nor data is a keepalive. One carrying data with no event is
							// legal SSE, but agent-service always names its events, so it is dropped and counted.
							if (!etype) {
								if (data) failOpenDeparture("agent-frame", "unnamed-event", { bytes: data.length });
								continue;
							}
							let ev: AgentEvent = {};
							try {
								ev = data ? (JSON.parse(data) as AgentEvent) : {};
							} catch {
								failOpenDeparture("agent-frame", "unparseable-json", { etype, bytes: data.length });
								ev = {};
							}
							if (etype === "plan") {
								// `plan` may or may not fire (ACP-only, and only for multi-step tasks). steps is string[] here.
								const steps = Array.isArray(ev.steps) ? ev.steps : [];
								totalSteps = steps.length;
								const attempt = ev.attempt && ev.attempt > 1 ? ` (attempt ${ev.attempt})` : "";
								yield* pushLine(`Planned ${steps.length} step(s): ${steps.join(", ")}${attempt}\n`);
							} else if (etype === "policy") {
								// This caller's write-permission resolution for the task (CUR-471). Fires once,
								// early, under every ACP_PERMISSION_POLICY value — carried as a structured chunk,
								// NOT narrated into the think block: agent-service separately injects a
								// model-facing prompt note, and this is meant to stay authoritative independent
								// of whatever the model says (or a deny_writes caller asking for terminal/
								// code_execution — which gets no tool_result frame at all, since CUR-217's gating
								// removes those tools before the session starts rather than denying the call —
								// going quiet with no explanation anywhere).
								if (ev.policy) {
									yield mk("", {
										special: true,
										writePolicy: {
											policy: ev.policy,
											tier: ev.tier ?? "uniform",
											tasksDone: ev.tasks_done ?? null,
											tasksRequired: ev.tasks_required ?? null,
										},
									});
								}
							} else if (etype === "tool_call") {
								// Proposal only — see the CUR-705 note on `pendingStepKind`'s declaration. Not
								// committed to `toolKinds` until `tool_result` confirms it actually ran.
								if (ev.tool && ev.step !== undefined) pendingStepKind.set(ev.step, ev.tool);
								yield* pushLine(`→ step ${ev.step}: ${ev.tool}\n`);
								// per-step live-stack beat: pulse the Hermes node on the map (text already streamed above)
								yield mk("", {
									special: true,
									agentStep: { index: ev.step ?? 0, tool: ev.tool ?? "step", total: totalSteps },
								});
							} else if (etype === "tool_result") {
								if (ev.summary) yield* pushLine(`   ${ev.summary}\n`);
								// Commit the kind now that we know it actually ran. `ev.ok` defaults to "count
								// it" when absent (an older/coarse frame shape) — the same fail-open direction
								// this file already takes on an unrecognized kind (see INERT_TOOL_KINDS's doc
								// comment): silence about success is not evidence of failure.
								if (ev.step !== undefined) {
									const kind = pendingStepKind.get(ev.step);
									if (kind !== undefined) {
										pendingStepKind.delete(ev.step);
										if (ev.ok !== false) {
											toolKinds.set(kind, (toolKinds.get(kind) ?? 0) + 1);
											finishedSteps.push({ tool: kind, summary: ev.summary });
										}
									}
								}
							} else if (etype === "awaiting_confirmation") {
								// agent-service paused a tool call on ACP_PERMISSION_POLICY=confirm and is
								// waiting on a human answer (fails CLOSED to deny on its own timeout — nothing here
								// has to enforce that). confirm_id is how the agent-confirm route names which paused
								// call a click resolves; taskId is this turn's — both required, so a malformed frame
								// (agent-service's own contract, but the wire is still untrusted input) is dropped
								// rather than surfaced as a half-built prompt with nothing to click. (CUR-218)
								if (ev.confirm_id) {
									yield* pushLine(
										`→ waiting for your OK: ${ev.plain || `${ev.kind ?? "action"} — ${ev.title ?? "(no title)"}`}\n`
									);
									// agent-service reports its own confirm_timeout_secs as a DURATION, not a
									// timestamp — its clock and this process's clock aren't the same clock, so the
									// deadline is stamped from OUR receipt time (as close to the real ACP frame arrival
									// as this pipeline gets) rather than trusting an epoch computed on the Python side. (CUR-1094)
									const timeoutSecs =
										typeof ev.timeout_secs === "number" && ev.timeout_secs > 0
											? ev.timeout_secs
											: undefined;
									yield mk("", {
										special: true,
										agentConfirm: {
											taskId,
											confirmId: ev.confirm_id,
											kind: ev.kind ?? "",
											title: ev.title ?? "",
											summary: ev.summary ?? "",
											...(typeof ev.plain === "string" && ev.plain ? { plain: ev.plain } : {}),
											...(timeoutSecs !== undefined
												? { deadlineAt: Date.now() + timeoutSecs * 1000 }
												: {}),
										},
									});
									openConfirms.add(ev.confirm_id);
								}
							} else if (etype === "auto_approved") {
								// Auto mode ran this call without a card. Listed in the trace so every
								// action the agent took on its own stays visible, in the reviewer's plain words. (CUR-3142)
								if (ev.plain) yield* pushLine(`→ ran without asking: ${ev.plain}\n`);
							} else if (etype === "confirm_result") {
								// The pause above resolved — a real answer, a timeout (reason "timeout", decision
								// "deny"), or the task being canceled out from under it (decision "canceled").
								if (ev.confirm_id && ev.decision) {
									const verb =
										ev.decision === "allow"
											? "confirmed"
											: ev.decision === "deny"
												? "declined"
												: "canceled";
									const suffix = ev.reason === "timeout" ? " (timed out)" : "";
									yield* pushLine(`   ${verb}${suffix}\n`);
									yield mk("", {
										special: true,
										agentConfirmResult: {
											confirmId: ev.confirm_id,
											decision: ev.decision as "allow" | "deny" | "canceled",
											reason: ev.reason ?? "",
										},
									});
									openConfirms.delete(ev.confirm_id);
								}
							} else if (etype === "message") {
								if (ev.text) yield* pushLine(`note: ${ev.text}\n`);
							} else if (etype === "state" && ev.state === "waiting_sandbox") {
								// The host is full and agent-service waits for a free sandbox, up to a minute. (CUR-4584)
								yield* pushLine(`→ ${ev.text || "Waiting for a free sandbox…"}\n`);
								yield mk("", { special: true, sandboxWait: "waiting" });
								waitingForSandbox = true;
							} else if (etype === "state" && waitingForSandbox) {
								waitingForSandbox = false;
								yield mk("", { special: true, sandboxWait: "ready" });
							} else if (etype === "state") {
								// Coarse liveness ping (e.g. "working"), fired unconditionally at task start before
								// transport is even chosen (CUR-773) — never a signal for which transport ran; see
								// `transport_used` on the `done` frame for that. The opening line already conveys
								// "working", so nothing to narrate here — handled explicitly so it's not a silent
								// fallthrough.
							} else if (etype === "usage") {
								// LIVE usage frames carry only {tokens}; the FINAL one (right before done) adds {steps}. Read the
								// final step count so the coarse (ACP-off) path — which emits NO tool_call frames — still renders
								// progress. Harmless under ACP too (adds a one-line summary below the per-step narration).
								const stepCount = typeof ev.steps === "number" ? ev.steps : undefined;
								if (stepCount !== undefined) {
									totalSteps = stepCount;
									const tok = typeof ev.tokens === "number" ? ` · ${ev.tokens} tokens` : "";
									yield* pushLine(`Ran ${stepCount} step(s)${tok}.\n`);
								}
							} else if (etype === "token") {
								// The agent's answer prose, arriving as it is produced — buffered per-attempt
								// rather than pushed straight into `full`/the think block; see the CUR-767 note
								// on `pendingTokenBuffer` above for why. `attempt` defaults to 1 defensively
								// (older/coarse frames that omit it should never be treated as a NEW attempt and
								// discard real buffered prose).
								//
								// `token` carries every assistant chunk of the whole ACP turn (acp_client.py
								// accumulates them all into what becomes done.result), so prose and tool calls
								// interleave (token frames, then tool_calls, then more tokens) and there is no
								// point before `done` at which "the answer has begun" is knowable.
								if (ev.delta) {
									const attempt = ev.attempt ?? 1;
									if (pendingAttempt !== undefined && attempt !== pendingAttempt) {
										// A new attempt's tokens arrived without an intervening attempt_rejected for
										// the old one — shouldn't happen per the wire contract, but don't let stale
										// prose from an unresolved attempt bleed into whatever comes next.
										pendingTokenBuffer = "";
									}
									pendingAttempt = attempt;
									pendingTokenBuffer += ev.delta;
								}
							} else if (etype === "attempt_rejected") {
								// Fired the moment an attempt is rejected, well before the next
								// attempt's first token. Discard its buffered prose outright — it's never
								// pushed into `full`, so it's never rendered anywhere, not even briefly. (CUR-767)
								if (ev.attempt === undefined || ev.attempt === pendingAttempt) {
									pendingTokenBuffer = "";
								}
								yield* pushLine(
									`Attempt rejected (${ev.reason || "rejected"}), retrying…\n`
								);
							} else if (etype === "token_truncated") {
								// The service caps token frames per attempt (AGENT_STREAM_MAX_FRAMES) so a long
								// answer can't evict this turn's plan/tool_call frames from its replay buffer. Say
								// so: without this line the live text just stops, which is indistinguishable from
								// the agent stopping. done.result is still complete.
								yield* push("\n…(live output capped here; the full answer follows)\n");
							} else if (etype === "done") {
								// whatever's still buffered belongs to the attempt that won — nothing
								// else reaches `done` without either being flushed here or discarded by
								// attempt_rejected above. (CUR-767)
								if (pendingTokenBuffer) {
									yield* push(pendingTokenBuffer);
									pendingTokenBuffer = "";
								}
								yield* closeThink();
								// Correct the provenance badge to the model the service actually ran (done.model).
								// Last-write-wins client-side, so this overrides the early emit's configured default.
								// Also carries verify_method whenever the field arrived on this frame — a
								// separate `ev.verify_method !== undefined` check because "" (unverified) must still
								// emit, and a done frame can in principle arrive without `model` set (CUR-756).
								// Same correction for compute_provider (the live-polled provider, not the static
								// AGENT_COMPUTE_PROVIDER config) — hence the guard below also fires on a
								// provider-only change with no model or verify_method present (CUR-996).
								if (ev.model || ev.compute_provider || ev.verify_method !== undefined) {
									yield mk("", {
										special: true,
										router: true,
										routerModel: ev.model,
										computeProvider: ev.compute_provider,
										...(ev.verify_method !== undefined ? { verifyMethod: ev.verify_method } : {}),
									});
								}
								answer =
									(ev.result ?? "").trim() ||
									(ev.state === "COMPLETED"
										? "Done."
										: `The agent did not complete (${ev.state ?? "failed"}).`);
								if (ev.state && ev.state !== "COMPLETED" && !ev.result) {
									// `error` names the reason (a moderation block on the agent's
									// OWN artifacts is the case this exists for — result stays empty either way, so
									// without this the person sees only "(FAILED)" with no hint a safety check
									// fired, let alone which one). Falls back to the bare state for an older build
									// or a task that failed before agent-service set a reason at all. (CUR-856)
									answer =
										ev.interrupted === "restart"
											? AGENT_RESTARTED_TEXT
											: ev.error
												? `The agent could not finish this task: ${ev.error}`
												: `The agent could not finish this task (${ev.state}).`;
								}
								// Only over a real result: on the failure paths above the answer is already the
								// harness's own sentence, and stacking a second caveat on it says nothing new.
								// Four independent reasons the caveat can be warranted — see each
								// function's/field's doc comment for what it catches and why
								// the others don't: the first three read the tool-call stream THIS endpoint
								// observed, the last is the service's own repair-loop verdict on a turn whose
								// answer it never got to re-check.
								// `ev.transport_used` is agent-service's own record of which transport this task
								// ran on (CUR-773). The `state` frame's presence says nothing about transport: it
								// fires at task start on every task, before transport is chosen. Absent/"" (an
								// old build, or a task that never got far enough to decide) reads as not-ACP, the
								// fail-quiet direction.
								const acpTransport = ev.transport_used === "acp";
								// Computed once, ahead of both uses below: the caveat check (CUR-592 — only an
								// actual code/script artifact can make wroteNotRun true) and renderArtifacts.
								const artifacts: AgentArtifact[] = Array.isArray(ev.artifacts) ? ev.artifacts : [];
								const wroteNotRun =
									wroteCodeWithoutRunningIt(toolKinds) && editedCodeArtifact(artifacts);
								// Undefined (an older service build) and 0 (an empty workdir) both produce silence
								// today, so `?? 0` here would be an equivalent rewrite rather than a bug (CUR-1394). It
								// stays uncoerced anyway, because the
								// two facts are different and only the type keeps them separable if the answers ever
								// have to diverge. What WOULD be a bug is defaulting to a positive value, which turns
								// "we never asked" into grounds for the claim.
								const sessionFilesAtStart = ev.session_files_at_start;
								const claimedNothing = CLAIMED_NOTHING.has(ev.no_tool_answer ?? "");
								const claimedNotObserved = !claimedNothing && claimedStepsWithoutObservedTools(
									toolKinds,
									acpTransport,
									totalSteps,
									sessionFilesAtStart
								);
								const continuedNoAction = !claimedNothing && claimedActionOnContinuedSession(
									toolKinds,
									acpTransport,
									Boolean(ev.session_continued),
									sessionFilesAtStart
								);
								const unrunDetail = (ev.unrun_detail ?? "").trim();
								const serviceFlagged = Boolean(unrunDetail);
								// CUR-855/846: a structural failure (gateway down, wall-clock cap, the agent
								// process crashing) is a different claim than the other four unrun_detail shapes
								// — those all mean "the agent overclaimed what it did," which UNRUN_CODE_NOTICE
								// describes accurately. A structural failure tried and didn't finish; reusing
								// that sentence there would be false, not just imprecise.
								const structuralFailure = unrunDetail.startsWith(STRUCTURAL_FAILURE_PREFIX);
								const unrunCodeCaveat =
									answer.trim() &&
									(wroteNotRun || claimedNotObserved || continuedNoAction || serviceFlagged);
								// Which branch fired, computed ONCE. Read by three consumers now — the log line below,
								// the answer prefix, and (CUR-1341) the unrunCode update that drives the reasoning
								// panel's header. It was an inline ternary chain inside the log call until the third
								// consumer arrived; two copies of this chain would be a behavioral twin that drifts the
								// first time a fifth reason is added, and the whole point of CUR-1341 is that the
								// header and the sentence under it must never disagree.
								const caveatReason: UnrunCodeReason | null = wroteNotRun
									? "wrote-not-run"
									: claimedNotObserved
										? "claimed-not-observed"
										: continuedNoAction
											? "continued-session-no-action"
											: serviceFlagged
												? structuralFailure
													? "service-verdict-structural"
													: "service-verdict"
												: null;
								if (unrunCodeCaveat) {
									// The sentence is chosen from `caveatReason`, the same single verdict that
									// drives the log line and the panel header, rather than from `structuralFailure`
									// alone. Selecting on a different input than the header reads is how the two drift,
									// which is the failure CUR-1341 hoisted this verdict to prevent. (CUR-1394)
									answer = noticeForCaveat(caveatReason) + answer;
								}
								// First in the answer, ahead of any caveat, since it explains why the earlier
								// files are missing from everything below it. (CUR-4393)
								if (ev.expired && answer.trim()) answer = SESSION_EXPIRED_NOTICE + answer;
								// The same verdict the prefix above just wrote into the answer, carried to the
								// client as structure instead of only as prose. The reasoning panel's header read
								// `loading ? "Computing…" : "Computed"` — whether the block finished STREAMING, which is
								// a different question — so a wrote-files-never-ran turn rendered "Computed" directly
								// above the sentence denying it, and the header is what a reader who never expands the
								// block walks away with. The client must NOT infer this from a missing agentTools
								// chunk — that absence is the CUR-234 ambiguity, and reading a negative out of it is
								// the bug next door.
								//
								// Gated on the full `unrunCodeCaveat` rather than `caveatReason` alone so this and the
								// prefix read one condition and cannot drift. Today the extra `answer.trim()`
								// clause changes nothing, because an empty `result` on a COMPLETED task is replaced by
								// the literal "Done." ~50 lines up before either check runs — dropping the clause here
								// leaves the whole suite green, so no test pins it and none can. Keep it anyway: it
								// costs nothing and it is what stays correct if that fallback ever goes away. (CUR-1341)
								if (unrunCodeCaveat && caveatReason) {
									yield mk("", { special: true, unrunCode: { reason: caveatReason } });
								}
								// An empty toolKinds is ambiguous on its own — "ACP off, correctly never
								// observed" and "ACP on but the checks silently didn't run" render identically.
								// This makes the two tell apart from the log: transport:"coarse" (agent-service's
								// own transport_used, CUR-773) is the honest silence — the coarse path sends no
								// tool frames by contract; transport:"acp" with zero toolKinds means the agent
								// genuinely used no tools this turn, not that observation failed. (CUR-234)
								logger.info(
									{
										transport: acpTransport ? "acp" : "coarse",
										toolKinds: [...toolKinds.keys()],
										// per-kind counts alongside the distinct-kind list, so an operator
										// debugging a wrongly-firing caveat (CUR-234's whole reason for this log line)
										// can see call volume from logs alone, not just from the persisted message. (CUR-775)
										toolCounts: Object.fromEntries(toolKinds),
										// A call proposed but never resolved to a tool_result — denied,
										// timed out, or (shouldn't happen) simply never answered. Excluded from
										// toolKinds by design; visible here so a wrongly-quiet caveat is legible
										// from the log instead of looking identical to "no call was ever made". (CUR-705)
										unresolvedToolKinds: [...pendingStepKind.values()],
										claimedSteps: totalSteps,
										sessionContinued: Boolean(ev.session_continued),
										unrunCodeCaveat: Boolean(unrunCodeCaveat),
										// Which branch, when any fired. Hoisted above (CUR-1341) so the log, the
										// answer prefix and the panel header all read one value.
										caveatReason,
									},
									"[agent] tool-frame observability"
								);
								// Provenance for a genuinely tool-running turn (CUR-601): only when toolKinds is
								// non-empty, mirroring writePolicy's "only stamp when it's real" contract — an
								// empty toolKinds is the same CUR-234 ambiguity discussed above, so this stays
								// silent rather than assert a negative. Lets the client-side grounding classifier
								// (provenanceFacts.agentToolsRan) tell a tool-running turn apart from "recall".
								if (toolKinds.size > 0) {
									yield mk("", {
										special: true,
										agentTools: {
											toolKinds: [...toolKinds.keys()],
											counts: Object.fromEntries(toolKinds),
										},
									});
								}
								// Appended on EVERY terminal state, unlike the caveat above. A run that failed
								// part-way still left whatever it wrote, and a half-written file is the most
								// useful thing a failed turn can hand back — withholding it there would repeat
								// CUR-195 (the answer describing files the response never carried) on exactly
								// the turns where the description is least trustworthy.
								// Both conditions named together, not left as an implicit "conversationId is
								// truthy" check: no conversationId means no session_id was sent to /run
								// (line ~480 above), so agent-service has no workdir to serve a download
								// from — a link would 404 on every click. The flag gates it independently.
								const downloadBaseHref =
									conversationId && agentArtifactDownloadEnabled()
										? `${chatBase}/conversation/${conversationId.toString()}/agent-artifact`
										: undefined;
								// Copy the files out while the workdir still holds them, so the link
								// keeps working after a deploy or the idle reaper erases it. Same two
								// conditions as the link: no session means nothing to read the files from. (CUR-4398)
								let saved: SavedAgentFile[] = [];
								if (downloadBaseHref && conversationId && saveAgentFiles) {
									const session = conversationId.toString();
									saved = await keepAgentFiles(artifacts, {
										read: async (agentPath) => {
											const res = await agentFetch(
												`${runBase}/sessions/${session}/artifacts/${agentPath
													.split("/")
													.map((seg) => encodeURIComponent(seg))
													.join("/")}`,
												{
													headers: eventHeaders,
													signal: abortSignal
														? AbortSignal.any([abortSignal, AbortSignal.timeout(15_000)])
														: AbortSignal.timeout(15_000),
												}
											);
											return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
										},
										save: saveAgentFiles,
									}).catch((err: unknown) => {
										// A full My files or a storage failure costs the person the saved copy,
										// never the turn: the live link still works for now.
										logger.warn(
											{ conversationId: session, err: err instanceof Error ? err.name : String(err) },
											"[agent] produced files were not saved"
										);
										return [];
									});
									for (const { agentPath, ref } of saved) {
										yield mk("", {
											special: true,
											agentFile: { name: ref.name, sha: ref.value, mime: ref.mime, agentPath },
										});
									}
								}
								answer += renderArtifacts(
									artifacts,
									ev.artifacts_dropped === true,
									answer,
									downloadBaseHref,
									new Map(saved.map((f) => [f.agentPath, f.ref.value]))
								);
								yield mk(answer);
								full.push(answer);
								done = true;
								sawDone = true;
								break;
							}
						}
					}
				}
			} catch (err) {
				// The event stream dropped AFTER it opened (network reset, our timeout, or a user stop).
				// Close the think block and answer honestly instead of throwing out of the generator
				// (which would surface as a generic stream error and lose the agent context).
				yield* closeThink();
				const aborted = (err as Error)?.name === "AbortError";
				const watchdog = aborted && endedByWatchdog(abortSignal);
				approvalUnanswered = watchdog && openConfirms.size > 0;
				answer = approvalUnanswered
					? unansweredApprovalAnswer(openConfirms.size)
					: partialRunAnswer(timedOut || watchdog ? "timed-out" : aborted ? "stopped" : "dropped", {
							plannedSteps: totalSteps,
							finishedSteps,
							unfinishedTools: [...pendingStepKind.values()],
							draft: pendingTokenBuffer,
						});
				if (!timedOut && !aborted) failOpenDeparture("agent-stream", "dropped");
				yield* push(answer);
			} finally {
				clearTimeout(timeout);
				abortSignal?.removeEventListener("abort", onAbort);
			}

			// Handed off: the run is still going, so nothing about it is settled here. Its approval cards stay
			// open and its task is not canceled; the page re-attaches, which replays the run from its first
			// event, cards included, and follows it to the end. The answer stored meanwhile says so, for a
			// visit before the page catches up.
			if (handedOff) {
				logger.info({ taskId, conversationId: conversationId?.toString() }, "[agent] run outlasts this request; handed off to the page");
				yield* closeThink();
				yield* push(AGENT_HANDOFF_TEXT);
				yield { ...mk("", { special: true, generated_text: full.join("") }), agentHandoff: true };
				return;
			}

			// The stream has ended — a `done`, a drop, our timeout, a user stop, or a clean
			// end with no `done`. Any confirmId still open never got its confirm_result, so cancel each:
			// the live card closes and agentConfirmResolved stamps the persisted entry decision:"canceled",
			// instead of a reload rendering an Allow/Deny card that resolves to nothing. On a normal `done`
			// the set is already empty (confirm_result deleted each), so this is a no-op there. (CUR-4070)
			// When the turn ended because nobody answered, each card says so instead. (CUR-4660)
			for (const confirmId of openConfirms) {
				yield mk("", {
					special: true,
					agentConfirmResult: approvalUnanswered
						? { confirmId, decision: "deny", reason: "timeout" }
						: { confirmId, decision: "canceled", reason: "stream-ended" },
				});
			}
			openConfirms.clear();

			// A turn that ended without the service's `done` is over for the person — they were told
			// it timed out or dropped and to try again — but the task can still be running service-side, up to
			// the task's own wall clock, and holding one of the person's two live-task slots the whole time.
			// So cancel it here. A stop by the caller is left alone: Stop cancels through stop-generating,
			// and a closed tab keeps its run for a reload to reattach to (CUR-993).
			// The route's watchdog is not a Stop and not a closed tab: nobody reattaches to that run, and left
			// alone it goes on into its next best-of attempt for up to two more wall clocks, so the person's
			// "carry on" would be refused with "another task is running in this conversation". (CUR-2194)
			if (!sawDone && !serviceLostTask && (!abortSignal?.aborted || endedByWatchdog(abortSignal))) {
				try {
					const status = await cancelAgentTask(input, locals, { taskId, machineId });
					logger.info({ taskId, status, timedOut }, "[agent] turn ended without a result; canceled its task");
				} catch (err) {
					logger.warn({ err, taskId }, "[agent] turn ended without a result; canceling its task failed");
				}
			}

			yield* closeThink();
			if (!answer) {
				failOpenDeparture("agent-stream", "ended-without-result");
				answer = "The agent stream ended without a result.";
				yield mk(answer);
				full.push(answer);
			}
			// terminal chunk: full content (think block + answer) → generate.ts emits FinalAnswer; the
			// client splits the <think> block into a collapsible reasoning panel from the content itself.
			yield mk("", { special: true, generated_text: full.join("") });
		})();
	};
}
