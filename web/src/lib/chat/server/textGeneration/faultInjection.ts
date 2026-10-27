// This repo's rule 2 (injure the thing a gate guards, watch it exit non-zero) is normally a one-time
// proof at wiring time, performed by the author, on whatever fixture is convenient. It establishes
// nothing about whether a journey spec still detects its own named failure months later, as the
// suite drifts: a negative assertion whose matcher never matches anything passes vacuously, even
// through a real stall where turns never answer.
//
// This module closes that gap (CUR-1614): a live-request lever, gated to preview/development
// only, that lets a tagged spec run against an actually-injured backend rather than only a mocked
// one — a green under fault injection means nothing survived to answer with, which is what "the
// gate goes red for the failure it's named after" (a gate must be proven red for its named failure) requires proof of.
//
// Gating mirrors betterAuth.ts's otpSendCapCarveOut (CUR-1553) exactly, minus its third (target-
// email) narrowing condition: that one exists because a leaked OTP-bypass secret could otherwise be
// used to defeat anti-abuse rate limiting broadly, a cross-user abuse vector. A leaked fault-inject
// secret's worst case is a single self-authored turn in the caller's OWN conversation coming back
// empty — self-directed, bounded to one request, no other user's data or spend touched — so the
// env allow-list plus the HMAC-compared secret is the whole gate.
//
//   1. deployEnv() must be explicitly "preview" or "development" — an allow-list, not `!== "production"`,
//      so a misconfigured/undeclared environment fails closed rather than being treated as "not prod".
//   2. a secret header (`x-e2e-fault-inject-token`) matching E2E_FAULT_INJECT_TOKEN, set ONLY in
//      Doppler's preview/dev configs, never prd — compared as fixed-width HMAC digests, never a raw
//      string `===`. Only once this validates does the fault NAME header even get read.
//
// FAULT_NAMES holds the full fault vocabulary. Most are wired to a simulation. Three
// are in textGeneration/index.ts: `no_assistant_reply`; `generation_timeout` (CUR-1921), which holds
// the turn open until the route's own generation watchdog aborts it, shortened to 15s (CUR-2757); and `title_latency_10s`
// (CUR-1907), which starts the title call 10s after the answer's FinalAnswer. `primary_lane_down`
// (CUR-1933) is in endpoints/failover.ts and fails the answer's first lane, so the backup lane serves
// it. `primary_lane_hangs` (CUR-2316), in the same file, makes that lane accept the call and send no
// headers, so only `failover-on-silent-lane`'s deadline can move the turn to the backup. `output_screen_timeout` (CUR-1872) holds generation open in index.ts without a model call,
// while the route shortens output screening's phase deadline, so the turn ends on screenStream's
// no-token at-capacity notice within seconds. `output_screen_window_short` (CUR-1884, CUR-2705) leaves
// generation alone and shortens that same deadline to one Coop call's own timeout, so a healthy answer that streams for longer finishes
// only because each released batch re-arms the window. `linked_page_firecrawl_down` (CUR-2152) skips Firecrawl
// in fetchLinkedPage, so a pasted link takes the direct-read path a preview with a key never reaches. `tts_canned_clip` (CUR-2253) answers
// a read-aloud turn with a canned clip this deployment serves itself instead of calling the TTS Space,
// so the gating read-aloud specs test our pipeline and not a third party's uptime. `tts_space_down`
// (CUR-2268) makes that same call skip as a timed-out Space does, so a spec reads the note a visitor
// gets when read-aloud fails. `tts_slow_canned_clip` (CUR-3810) sends the canned clip twenty seconds late,
// so a spec sees whether the reply's text shows before its audio. `mcp_stub_server` (CUR-3026) adds a stub MCP server, answered inside this
// deployment (mcp/e2eStub.ts), to the configured servers, so a spec drives a read, a confirmed write and
// a tool error from /chat without a third party's server. `lane_rate_limited`
// (CUR-2307) makes the answer's endpoint call throw the 429 a model host's rate cap produces, in
// generate.ts, so a spec sees what a visitor reads when a model host's key is over its cap. `lane_server_error` (CUR-2829)
// throws the SDK's 500 from that same call, an error neither the busy nor the dropped-stream copy maps,
// so a spec reads the generic failure notice. `primary_lane_rate_limited`
// (CUR-2346) throws that same 429 from the first lane inside endpoints/failover.ts, so the turn takes the
// path a real over-cap answer takes: no same-lane retry, then the backup lane when there is one.
// `tool_round_rate_limited` (CUR-2432) refuses the tool loop's first request after round 1 with that 429,
// once, in endpoints/openai/endpointOai.ts, so a spec sees the later round retry on the same lane.
// `tool_round_rate_limited_sustained` (CUR-2307) refuses every such request on the first lane, so the
// retries run out and the backup lane continues the transcript. `gap_map_db_down`
// (CUR-2304) fails the gap map dataset read in gapMap/pageRead.ts, so a product or org page renders
// from the committed snapshot. `csam_scanner_down` (CUR-2382) makes the known-CSAM scan in My files and
// in a chat turn's image attachments (parseRequest.ts) fail as an unreachable HMA does, so a spec reads the refusal and sees nothing stored. `question_save_delayed`
// (CUR-1893) holds the question's first write in the chat route for QUESTION_SAVE_DELAY_MS, so a spec can
// reload before the server has saved the turn. `agent_turn_deadline_20s` (CUR-993) shortens an agent
// turn's generation watchdog to 20s in the conversation route, so the route gives up on a run
// agent-service is still doing, which is the turn a reload re-attaches to. `answer_holds_midway`
// (CUR-2805), in textGeneration/index.ts, streams a fixed first sentence and holds the turn open before
// the rest, so a spec can cut the visitor's connection while an answer is certainly still streaming. `chat_500` (CUR-1614) fails
// the conversation send with a 500 before any stream exists. `stream_truncates_midway` (CUR-1614) lets
// twelve answer tokens through in generate.ts and then throws the "terminated" TypeError undici raises
// when a lane's socket closes mid-answer. `provenance_header_stripped` (CUR-1614), also in generate.ts,
// drops the lane's routerMetadata report so nothing names the model that served. `wrong_model_served`
// (CUR-1614) makes every response body on the first lane name SEA-LION while its headers still name the
// requested model, in endpoints/openai/endpointOai.ts, so the served-model checks run on a real
// substitution shape. `latency_30s` (CUR-1614), in textGeneration/index.ts, holds a turn
// 30s with keepalives flowing and then streams a fixed reply, so a spec sees a slow answer that does arrive.
// `input_screen_unfinished` (CUR-3531) ends the input screen once every child-safety query has answered,
// so the content queries go unasked the way a slow guard leaves them on a long paste.
// `output_screen_blocks` (CUR-2810) makes the route's output screen block every chunk as a content-policy
// hit, so a spec sees what a visitor reads when the screen withholds a composed answer.
// `output_screen_blocks_rule` (CUR-4051) does the same on the drugs rule, so a spec reads that rule's
// notice and the language it is written in.
// `tts_canned_clip_output_blocked` (CUR-3847) does both that and `tts_canned_clip`, so a spec with
// read-aloud on Always sees whether a declined answer's clip still reaches the visitor.
// `output_guard_unreachable` (CUR-3891) runs the guard output screen with a guard that never answers,
// so a spec sees the couldn't-check decline a visitor reads when the guard is unavailable.
// `input_guard_unreachable` (CUR-4101) does the same for the input screen, so a spec sees a turn whose
// attachment text could not be screened declined before any model call, never answered unscreened.
// `input_screen_declines_rule` (CUR-4093) answers the input screen's harassment question yes and every
// other no, so a spec sees a message declined under "Respectful communication".
// `output_screen_recheck_clears` (CUR-3975) flags every output batch on one content rule and answers the
// re-check with a stub "no", so a spec sees the flagged answer released whole.
// `session_rate_limit_low` (CUR-2804) lowers the per-session send limit to one message per
// SESSION_RATE_LIMIT_FAULT's window, so a spec trips our own rate limit and outwaits it in half a minute.
// `storage_listing_down` (CUR-2798) fails the stored-file listing in the data export route, so a spec
// opens the ZIP a person gets when My files cannot be read and reads what its README says.
// `storage_hub_rate_limited` (CUR-3120) makes My files' list and upload answer as Hugging Face does
// when it throttles the storage token, so a spec reads the busy message instead of a server error; a
// chat turn's attachment store answers the same way (parseRequest.ts), and so does deleting one chat
// (CUR-3666, `conversations/[id]/+server.ts`). `storage_quota_full` (CUR-2183)
// makes that store fail as if the owner's files were at their quota: a signed-in owner's turn is
// refused with 413 and the My files full line (CUR-3235, parseRequest.ts), and a guest's file falls
// back to the files table and the turn answers from it.
// `storage_hub_read_rate_limited` (CUR-3291) throttles only a chat turn's read of an attachment back from
// the bucket, twice, so a spec sees the turn name the file it could not read.
// `conversation_limit_reached` (CUR-2875) makes `POST /chat/conversation` refuse as if the visitor
// already held the conversation cap, so a spec sees what a new chat does when it is refused.
// `answer_loops` (CUR-3318), in textGeneration/index.ts, streams one sentence and then repeats another
// three hundred times with no model call, so a spec sees the loop cut end the answer with its notice.
// `canned_reply` (SOL-91), in textGeneration/index.ts, answers at once with fixed text and a title from
// the question's first words, calling no model for either, so a spec that checks only our UI spends no
// model call and cannot fail on what a model wrote. `caret_cited_reply` (CUR-3551) does the same with two
// web sources cited in Large 3's caret shapes ("Tokyo^1,2^"), so a spec sees each marker link to its
// source. `crisis_line_reply` (CUR-2697) does the same with a crisis answer that names the US 988 line
// first, so a spec sees the honesty stream put findahelpline.com and 112 ahead of it on whichever turn
// path the visitor is on. `model_replay` (SOL-92), in
// endpoints/openai/modelReplay.ts, answers the answer's model calls from a committed recording when one
// matches the request and records the live response when none does, so a spec that reads provenance or
// a stream filter runs the whole pipeline without a live answer. `model_replay_none` (SOL-148) does the
// same and fails any call with no recording, so a run proves it made no live model call. `agent_route_down` (CUR-2830) makes the
// chat route's call to the agent service's /route classifier fail as an unreachable service does, so a
// spec on Agent: Auto sees the note a visitor gets when nobody could decide whether the turn needed it.
// `agent_route_screened` (CUR-4056) answers that call with the agent service's input-screen 403, so a
// spec sees a refused prompt get no such note: the service was reached and gave a verdict.
// `answer_recites_preamble` (CUR-3886), in textGeneration/index.ts, streams the fenced turn's preamble in
// place of an answer with no model call, and the honesty stream's one retry then answers as
// `canned_reply`, so a spec sees the recital replaced on screen without a live model.
// `groundcheck_removes_claim` (CUR-2927) answers as `canned_reply` does, then runs groundcheck on it
// whatever the flag and the retrieval, with a stub detector and reviser that delete one word
// (groundcheckFaultCheck), so a spec reads X-ray's Fact check count without the detector service.
// `answer_streams_past_cap` (CUR-4009), in textGeneration/index.ts, streams a fixed answer a token every
// half second for longer than the watchdog's total cap, which the fault shortens to
// STREAMS_PAST_CAP_FAULT_MS, so a spec sees a turn still streaming at its cap finish instead of being cut.
// `grounded_answer_hedges` (CUR-4339), in textGeneration/index.ts, answers with two web sources and a
// one-sentence hedge and no model call, and the route skips the ungrounded re-answer, so a spec sees the
// sources pointer a visitor on www reads when a grounded answer bails, in the language they wrote in.

import { isTestDeployment } from "$lib/chat/server/deployEnv";
import type { ReplayMode } from "$lib/chat/server/endpoints/openai/modelReplay";
import {
	FAKE_AGENT_KNOBS,
	type FakeAgentKnob,
	type FakeAgentRequest,
} from "$lib/chat/server/endpoints/agent/fakeAgentService";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";
import { config } from "$lib/chat/server/config";
import { coopCallTimeoutMs } from "$lib/chat/server/moderation";
import type { JudgeFn } from "$lib/chat/server/guardScreenTypes";
import RULES from "$lib/chat/server/rules.json";

/** `input_guard_unreachable`'s guard (CUR-4101): every query comes back unanswered over a failed call,
 *  the way an unreachable guard leaves a screen. */
export const unreachableGuardJudge: JudgeFn = async () => ({ answer: { kind: "unknown" }, httpOk: false });

const HARASSMENT_QUERY = RULES["chat-block-harrasment"].guard.query;
/** `input_screen_declines_rule`'s guard (CUR-4093): yes to the harassment rule's question and no to every
 *  other, so a message is declined under "Respectful communication" even when it is a distress
 *  message. */
export const harassmentRuleJudge: JudgeFn = async (_target, query) => ({
	answer: { kind: "token", yes: query === HARASSMENT_QUERY },
	httpOk: true,
});

export const FAULT_NAMES = [
	"no_assistant_reply",
	"generation_timeout",
	"title_latency_10s",
	"provenance_header_stripped",
	"stream_truncates_midway",
	"chat_500",
	"latency_30s",
	"wrong_model_served",
	"primary_lane_down",
	"primary_lane_hangs",
	// Every lane accepts the call and sends nothing (endpoints/failover.ts), so the turn ends on
	// the last lane's give-up and a spec sees what Auto does when its choice stays silent everywhere. (CUR-4384)
	"every_lane_hangs",
	// Every lane of the model throws a 429 before any request leaves (endpointOai.ts), as a host
	// with a spent budget answers. The warm route's probe uses it to set a scoped busy mark with no turn. (CUR-4042)
	"every_lane_rate_limited",
	"output_screen_timeout",
	"output_screen_window_short",
	"linked_page_firecrawl_down",
	"tts_canned_clip",
	"tts_slow_canned_clip",
	"tts_space_down",
	"lane_rate_limited",
	// The turn's model throws the router's 404 before any text, so a spec sees Auto pick again. (CUR-4629)
	"lane_not_found",
	"lane_server_error",
	"primary_lane_rate_limited",
	"tool_round_rate_limited",
	"tool_round_rate_limited_sustained",
	"gap_map_db_down",
	"csam_scanner_down",
	"question_save_delayed",
	"agent_turn_deadline_20s",
	"output_screen_blocks",
	"output_screen_blocks_rule",
	"tts_canned_clip_output_blocked",
	"output_guard_unreachable",
	"input_guard_unreachable",
	"input_screen_declines_rule",
	"output_screen_recheck_clears",
	"session_rate_limit_low",
	"answer_holds_midway",
	"storage_listing_down",
	"guest_file_move_skipped",
	"storage_hub_rate_limited",
	"storage_hub_read_rate_limited",
	"storage_quota_full",
	"conversation_limit_reached",
	"canned_reply",
	"caret_cited_reply",
	"grounded_answer_hedges",
	"crisis_line_reply",
	// A French crisis answer naming 3115, split across tokens, for the helpline number guard. (CUR-4061)
	"crisis_number_reply",
	// A Russian answer naming Russia's police 102, which the guard must keep for any visitor. (CUR-4122)
	"emergency_number_reply",
	"answer_loops",
	"model_replay",
	"model_replay_none",
	"mcp_stub_server",
	// The conversation's sandbox is a stand-in for a full E2B host (mcp/sandboxWaitStub.ts): each run
	// sends "Waiting for a free sandbox…" as MCP progress and answers seconds later, so a spec reads the
	// live line's wait and then the result. (CUR-4584)
	"sandbox_host_full",
	"input_screen_unfinished",
	"agent_route_down",
	"agent_route_screened",
	"answer_recites_preamble",
	"groundcheck_removes_claim",
	"answer_streams_past_cap",
	// A user flag's forward to Coop's /report answers 429, so a spec can show the flag still
	// succeeds and the refusal is logged at error level. (CUR-2598)
	"coop_report_rate_limited",
	// Every web search on the turn hangs (runSearch.ts `hang`), on the scaffolded route and in
	// the native web_search tool alike, so only the web leg's deadline ends it and a spec reads the note a
	// visitor gets when search doesn't finish. (CUR-4091)
	"web_search_hangs",
	// /chat/api/status answers `degraded` without asking Better Stack, so a spec sees the chat's
	// incident banner while the real status page reads operational. (CUR-4062)
	"status_page_degraded",
	// The CLI pairing link provisions its managed endpoint against a stub Pangolin answered
	// inside the process (managedInference/e2eStub.ts), so a spec can pair a device on a preview, which
	// has no Pangolin. (CUR-4110)
	"pangolin_stub",
	// The conversation's sandbox is answered in-process (mcp/e2eStub.ts `stubSandboxServer`), so a
	// spec drives a run and the usage-tier limit message without a live E2B host. (CUR-4578)
	"sandbox_stub",
] as const;

/** `session_rate_limit_low`: one message per 30s window. The window has to outlast the first answer,
 *  so the second send lands inside it; every send records an event, a refused one included, so the
 *  spec waits out the window from the refusal before sending again. */
export const SESSION_RATE_LIMIT_FAULT = { limit: 1, windowMs: 30_000 } as const;

/** The generation watchdog an agent turn gets under `agent_turn_deadline_20s`. */
const AGENT_TURN_DEADLINE_FAULT_MS = 20_000;

/** The generation watchdog a turn gets under `generation_timeout` (CUR-2757). The fault exercises the
 *  watchdog's abort path, which does not depend on how long the watchdog waits, and the live line must
 *  have counted a few seconds before the abort (it appears at 5s). The real 45s would make the spec
 *  using it the slowest in its shard. */
const GENERATION_TIMEOUT_FAULT_MS = 15_000;

/** The total cap a turn gets under `answer_streams_past_cap` (CUR-4009): short enough that the fault's
 *  answer is still streaming when it arrives. */
const STREAMS_PAST_CAP_FAULT_MS = 4_000;

/** The generation watchdog's deadline for this turn: `configuredMs`, unless a fault that shortens the
 *  watchdog applies to this kind of turn. `primary_lane_hangs` with `failover-on-silent-lane` off has no
 *  way to end but the watchdog, so it gets the same short deadline as `generation_timeout`; with the
 *  flag on, the backup lane has to answer inside the real one. */
export function watchdogDeadlineMs(
	configuredMs: number,
	fault: FaultInjectionName | null,
	opts: { isAgentTurn: boolean; silentLaneFailover: boolean }
): number {
	if (opts.isAgentTurn && fault === "agent_turn_deadline_20s") return AGENT_TURN_DEADLINE_FAULT_MS;
	if (fault === "generation_timeout" || (fault === "primary_lane_hangs" && !opts.silentLaneFailover))
		return Math.min(configuredMs, GENERATION_TIMEOUT_FAULT_MS);
	if (fault === "answer_streams_past_cap") return Math.min(configuredMs, STREAMS_PAST_CAP_FAULT_MS);
	return configuredMs;
}

export type FaultInjectionName = (typeof FAULT_NAMES)[number];

/** `output_screen_window_short`: the screening window, the longest it may go without releasing a
 *  batch. It is never shorter than one Coop call's own timeout, so a slow but healthy screen cannot
 *  trip it (CUR-2705). */
export function outputScreenWindowFaultMs(): number {
	return coopCallTimeoutMs();
}

/** `question_save_delayed`: how long the question's first write is held (CUR-1893). The observed
 *  gap from send to save on a cold instance is about 7s; this sits just above it. */
export const QUESTION_SAVE_DELAY_MS = 8_000;

function isFaultInjectionName(value: string): value is FaultInjectionName {
	return (FAULT_NAMES as readonly string[]).includes(value);
}

const FAULT_INJECT_HASH_LABEL = "e2e-fault-inject-v1";

/** Resolves which named fault (if any) this request is authorized and asking to simulate. Never
 *  throws — every failure mode (wrong env, no token configured, wrong secret, unrecognized fault
 *  name) returns null, the same "apply real behavior" default otpSendCapCarveOut uses. */
export async function resolveFaultInjection(req: Request): Promise<FaultInjectionName | null> {
	if (!(await carriesFaultInjectToken(req))) return null;
	const requested = req.headers.get("x-e2e-fault-inject") ?? "";
	return isFaultInjectionName(requested) ? requested : null;
}

/** The model replay mode this request asked for, behind the same gate as a fault. Read from its
 *  own `x-e2e-replay` header (`mock` by default since SOL-208; `new_episodes`, or `all` on a retry, in a record run; `none`), so a scenario spec replays by default and can (SOL-148)
 *  still inject one named fault beside it; the `model_replay` faults still ask for it on their own. */
export async function resolveReplayMode(req: Request): Promise<ReplayMode | null> {
	const header = req.headers.get("x-e2e-replay");
	const fault = req.headers.get("x-e2e-fault-inject");
	if (!header && fault !== "model_replay" && fault !== "model_replay_none") return null;
	if (!(await carriesFaultInjectToken(req))) return null;
	if (header === "none" || fault === "model_replay_none") return "none";
	if (header === "all") return "all";
	if (header === "mock") return "mock";
	if (header === "nearest") return "nearest";
	return "new_episodes";
}

/** Whether this send asked for the live guard screen, from its own `x-e2e-guard: live` header
 *  behind the same gate as a fault. A `@real-screen` spec sends it on develop push, nightly and (SOL-258)
 *  promotion runs, so those runs read what the live screen says rather than a recording of it. */
export async function resolveGuardLive(req: Request): Promise<boolean> {
	if (req.headers.get("x-e2e-guard") !== "live") return false;
	return carriesFaultInjectToken(req);
}

/** Whether this send's agent turn goes to the in-process stand-in for agent-service
 *  (endpoints/agent/fakeAgentService.ts), behind the same gate as a fault. Read from its own (SOL-212)
 *  `x-e2e-agent: fake[;knob…]` header, so a spec can still inject one named fault beside it. */
export async function resolveFakeAgent(req: Request): Promise<FakeAgentRequest | null> {
	const [mode, ...rest] = (req.headers.get("x-e2e-agent") ?? "").split(";").map((s) => s.trim());
	if (mode !== "fake") return null;
	if (!(await carriesFaultInjectToken(req))) return null;
	return { knobs: rest.filter((k): k is FakeAgentKnob => (FAKE_AGENT_KNOBS as readonly string[]).includes(k)) };
}

/** The busy-mark scope a spec asks for, from `x-e2e-busy-scope` behind the same gate as a
 *  fault. The chat shell then reads, and the warm route's probe writes, marks under that scope only
 *  (modelBusy.ts), so a spec sees the whole probe-to-picker path without marking a model busy for every (CUR-4042)
 *  visitor on the preview. Null when the header is absent or the gate refuses it. */
export async function resolveBusyScope(req: Request): Promise<string | null> {
	const scope = req.headers.get("x-e2e-busy-scope")?.trim() ?? "";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(scope)) return null;
	if (!(await carriesFaultInjectToken(req))) return null;
	return scope;
}

/** A spec's request to run the warm probe now, on one model, under a busy scope: the scope
 *  above, the model from `x-e2e-probe-model`, and whether its lanes refuse (`every_lane_rate_limited` (CUR-4042)
 *  in `x-e2e-fault-inject`). Null unless the gate passes and both headers are present. */
export async function resolveProbeRequest(
	req: Request
): Promise<{ scope: string; model: string; refuse: boolean } | null> {
	const model = req.headers.get("x-e2e-probe-model")?.trim();
	if (!model) return null;
	const scope = await resolveBusyScope(req);
	if (!scope) return null;
	return { scope, model, refuse: req.headers.get("x-e2e-fault-inject") === "every_lane_rate_limited" };
}

/** The whole gate above minus the fault name: a preview or development deployment, and a request
 *  carrying the HMAC-matched `x-e2e-fault-inject-token`. Shared with previewScreenStub.ts. */
export async function carriesFaultInjectToken(req: Request): Promise<boolean> {
	if (!isTestDeployment()) return false;

	const bypassSecret = config.E2E_FAULT_INJECT_TOKEN;
	if (!bypassSecret) return false;

	const [supplied, expected] = await Promise.all([
		hmacSha256(FAULT_INJECT_HASH_LABEL, req.headers.get("x-e2e-fault-inject-token") ?? ""),
		hmacSha256(FAULT_INJECT_HASH_LABEL, bypassSecret),
	]);
	return timingSafeEqual(supplied, expected);
}
