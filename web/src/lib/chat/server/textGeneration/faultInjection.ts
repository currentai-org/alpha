// A gate must be proven red for the failure it names: injure the thing it guards and watch it exit
// non-zero. That proof is normally done once at wiring time, by the author, on whatever fixture is
// convenient. It establishes
// nothing about whether a journey spec still detects its own named failure months later, as the
// suite drifts: a negative assertion whose matcher never matches anything passes vacuously, even
// through a real stall where turns never answer.
//
// This module closes that gap: a live-request lever, gated to preview/development only, that lets a
// tagged spec run against an actually-injured backend rather than only a mocked one. A spec that
// goes red under fault injection proves it still detects the failure it is named after.
//
// Gating mirrors betterAuth.ts's otpSendCapCarveOut exactly, minus its third (target-
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
// are in textGeneration/index.ts: `no_assistant_reply`; `generation_timeout`, which holds
// the turn open until the route's own generation watchdog aborts it, shortened to 15s; and `title_latency_10s`,
// which starts the title call 10s after the answer's FinalAnswer. `primary_lane_down`
// is in endpoints/failover.ts and fails the answer's first lane, so the backup lane serves
// it. `primary_lane_hangs`, in the same file, makes that lane accept the call and send no
// headers, so only the silent-lane deadline (failover.ts `failoverAfterMs`) can move the turn to the backup. `output_screen_timeout` holds generation open in index.ts without a model call,
// while the route shortens output screening's phase deadline, so the turn ends on screenStream's
// no-token at-capacity notice within seconds. `output_screen_window_short` leaves
// generation alone and shortens that same deadline to one Coop call's own timeout, so a healthy answer that streams for longer finishes
// only because each released batch re-arms the window. `linked_page_firecrawl_down` skips Firecrawl
// in fetchLinkedPage, so a pasted link takes the direct-read path a preview with a key never reaches. `tts_canned_clip` answers
// a read-aloud turn with a canned clip this deployment serves itself instead of calling the TTS Space,
// so the gating read-aloud specs test our pipeline and not a third party's uptime. `tts_space_down`
// makes that same call skip as a timed-out Space does, so a spec reads the note a visitor
// gets when read-aloud fails. `tts_slow_canned_clip` sends the canned clip twenty seconds late,
// so a spec sees whether the reply's text shows before its audio. `mcp_stub_server` adds a stub MCP server, answered inside this
// deployment (mcp/e2eStub.ts), to the configured servers, so a spec drives a read, a confirmed write and
// a tool error from /chat without a third party's server. `lane_rate_limited`
// makes the answer's endpoint call throw the 429 a model host's rate cap produces, in
// generate.ts, so a spec sees what a visitor reads when a model host's key is over its cap. `lane_server_error`
// throws the SDK's 500 from that same call, an error neither the busy nor the dropped-stream copy maps,
// so a spec reads the generic failure notice. `primary_lane_rate_limited`
// throws that same 429 from the first lane inside endpoints/failover.ts, so the turn takes the
// path a real over-cap answer takes: no same-lane retry, then the backup lane when there is one.
// `tool_round_rate_limited` refuses the tool loop's first request after round 1 with that 429,
// once, in endpoints/openai/endpointOai.ts, so a spec sees the later round retry on the same lane.
// `tool_round_rate_limited_sustained` refuses every such request on the first lane, so the
// retries run out and the backup lane continues the transcript. `gap_map_db_down`
// fails the gap map dataset read in gapMap/pageRead.ts, so a product or org page renders
// from the committed snapshot. `question_save_delayed`
// holds the question's first write in the chat route for QUESTION_SAVE_DELAY_MS, so a spec can
// reload before the server has saved the turn. `agent_turn_deadline_20s` shortens an agent
// turn's generation watchdog to 20s in the conversation route, so the route gives up on a run
// agent-service is still doing, which is the turn a reload re-attaches to. `answer_holds_midway`,
// in textGeneration/index.ts, streams a fixed first sentence and holds the turn open before
// the rest, so a spec can cut the visitor's connection while an answer is certainly still streaming. `chat_500` fails
// the conversation send with a 500 before any stream exists. `stream_truncates_midway` lets
// twelve answer tokens through in generate.ts and then throws the "terminated" TypeError undici raises
// when a lane's socket closes mid-answer. `provenance_header_stripped`, also in generate.ts,
// drops the lane's routerMetadata report so nothing names the model that served. `wrong_model_served`
// makes every response body on the first lane name SEA-LION while its headers still name the
// requested model, in endpoints/openai/endpointOai.ts, so the served-model checks run on a real
// substitution shape. `latency_30s`, in textGeneration/index.ts, holds a turn
// 30s with keepalives flowing and then streams a fixed reply, so a spec sees a slow answer that does arrive.
// `input_screen_unfinished` ends the input screen once every child-safety query has answered,
// so the content queries go unasked the way a slow guard leaves them on a long paste.
// `output_screen_blocks` makes the route's output screen block every chunk as a content-policy
// hit, so a spec sees what a visitor reads when the screen withholds a composed answer.
// `output_screen_blocks_rule` does the same on the drugs rule, so a spec reads that rule's
// notice and the language it is written in.
// `tts_canned_clip_output_blocked` does both that and `tts_canned_clip`, so a spec with
// read-aloud on Always sees whether a declined answer's clip still reaches the visitor.
// `output_guard_unreachable` runs the guard output screen with a guard that never answers,
// so a spec sees the couldn't-check decline a visitor reads when the guard is unavailable.
// `input_guard_unreachable` does the same for the input screen, so a spec sees a turn whose
// attachment text could not be screened declined before any model call, never answered unscreened.
// `input_screen_declines_rule` answers the input screen's harassment question yes and every
// other no, so a spec sees a message declined under "Respectful communication".
// `output_screen_recheck_clears` flags every output batch on one content rule and answers the
// re-check with a stub "no", so a spec sees the flagged answer released whole.
// `session_rate_limit_low` lowers the per-session send limit to one message per
// SESSION_RATE_LIMIT_FAULT's window, so a spec trips our own rate limit and outwaits it in half a minute.
// `daily_turn_cap_low` lowers the per-account daily turn cap to DAILY_TURN_CAP_FAULT, so a
// spec sends past it in three turns and reads the limit message.
// `storage_listing_down` fails the stored-file listing in the data export route, so a spec
// opens the ZIP a person gets when My files cannot be read and reads what its README says.
// `storage_hub_rate_limited` makes My files' list and upload answer as Hugging Face does
// when it throttles the storage token, so a spec reads the busy message instead of a server error; a
// chat turn's attachment store answers the same way (parseRequest.ts), and so does deleting one chat
// (`conversations/[id]/+server.ts`). `storage_quota_full`
// makes that store fail as if the owner's files were at their quota: a signed-in owner's turn is
// refused with 413 and the My files full line (parseRequest.ts), and a guest's file falls
// back to the files table and the turn answers from it.
// `storage_hub_read_rate_limited` throttles only a chat turn's read of an attachment back from
// the bucket, twice, so a spec sees the turn name the file it could not read.
// `conversation_limit_reached` makes `POST /chat/conversation` refuse as if the visitor
// already held the conversation cap, so a spec sees what a new chat does when it is refused.
// `answer_loops`, in textGeneration/index.ts, streams one sentence and then repeats another
// three hundred times with no model call, so a spec sees the loop cut end the answer with its notice.
// `canned_reply`, in textGeneration/index.ts, answers at once with fixed text and a title from
// the question's first words, calling no model for either, so a spec that checks only our UI spends no
// model call and cannot fail on what a model wrote. It also answers Continue in a new chat's summary with
// fixed text (continueSummary.ts). `caret_cited_reply` does the same with two
// web sources cited in Large 3's caret shapes ("Tokyo^1,2^"), so a spec sees each marker link to its
// source. `crisis_line_reply` does the same with a crisis answer that names the US 988 line
// first, so a spec sees the honesty stream put findahelpline.com and the person's local emergency
// services ahead of it on whichever turn path the visitor is on. `model_replay`, in
// endpoints/openai/modelReplay.ts, answers the answer's model calls from a committed recording when one
// matches the request and records the live response when none does, so a spec that reads provenance or
// a stream filter runs the whole pipeline without a live answer. `model_replay_none` does the
// same and fails any call with no recording, so a run proves it made no live model call. `agent_route_down` makes the
// chat route's call to the agent service's /route classifier fail as an unreachable service does, so a
// spec on Agent: Auto sees the note a visitor gets when nobody could decide whether the turn needed it.
// `agent_route_screened` answers that call with the agent service's input-screen 403, so a
// spec sees a refused prompt get no such note: the service was reached and gave a verdict.
// `answer_recites_preamble`, in textGeneration/index.ts, streams the fenced turn's preamble in
// place of an answer with no model call, and the honesty stream's one retry then answers as
// `canned_reply`, so a spec sees the recital replaced on screen without a live model.
// `groundcheck_removes_claim` answers as `canned_reply` does, then runs groundcheck on it
// whatever the flag and the retrieval, with a stub detector and reviser that delete one word
// (groundcheckFaultCheck), so a spec reads X-ray's Fact check count without the detector service.
// `answer_streams_past_cap`, in textGeneration/index.ts, streams a fixed answer a token every
// half second for longer than the watchdog's total cap, which the fault shortens to
// STREAMS_PAST_CAP_FAULT_MS, so a spec sees a turn still streaming at its cap finish instead of being cut.
// `grounded_answer_hedges`, in textGeneration/index.ts, answers with two web sources and a
// one-sentence hedge and no model call, and the route skips the ungrounded re-answer, so a spec sees the
// sources pointer a visitor reads when a grounded answer bails, in the language they wrote in.

import { isTestDeployment } from "$lib/chat/server/deployEnv";
import type { ReplayMode } from "$lib/chat/server/endpoints/openai/modelReplay";
import {
	FAKE_AGENT_KNOBS,
	type FakeAgentKnob,
	type FakeAgentRequest,
} from "$lib/chat/server/endpoints/agent/fakeAgentService";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";
import { config } from "$lib/chat/server/config";
import { updateRequestContext } from "$lib/chat/server/requestContext";
import { coopCallTimeoutMs } from "$lib/chat/server/moderation";
import type { JudgeFn } from "$lib/chat/server/guardScreenTypes";
import RULES from "$lib/chat/server/rules.json";

/** `input_guard_unreachable`'s guard: every query comes back unanswered over a failed call,
 *  the way an unreachable guard leaves a screen. */
export const unreachableGuardJudge: JudgeFn = async () => ({ answer: { kind: "unknown" }, httpOk: false });

const HARASSMENT_QUERY = RULES["chat-block-harrasment"].guard.query;
/** `input_screen_declines_rule`'s guard: yes to the harassment rule's question and no to every
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
	// The lane's report still names the served model but neither the provider nor the backend host
	// (generate.ts), so a spec sees what an answer whose routing record names no host shows.
	"provenance_host_stripped",
	"stream_truncates_midway",
	"chat_500",
	"latency_30s",
	"wrong_model_served",
	"primary_lane_down",
	"primary_lane_hangs",
	// Every lane accepts the call and sends nothing (endpoints/failover.ts), so the turn ends on
	// the last lane's give-up and a spec sees what Auto does when its choice stays silent everywhere.
	"every_lane_hangs",
	// Every lane of the model throws a 429 before any request leaves (endpointOai.ts), as a host
	// with a spent budget answers. The warm route's probe uses it to set a scoped busy mark with no turn.
	"every_lane_rate_limited",
	// The same, with the 402 a host sends when it won't bill the provider (Hugging Face's "Pay-as-you
	// go is not enabled for provider scaleway yet."), so a spec sees the probe mark a model the host won't bill.
	"every_lane_payment_required",
	"output_screen_timeout",
	"output_screen_window_short",
	// The search-need classifier's reply is neither yes nor no (search/searchDecision.ts), and the
	// completion classifier decides the turn whatever the strategy, so a spec reads a malformed decision
	// on a preview, where the embedding gate otherwise decides.
	"search_classifier_malformed",
	"linked_page_firecrawl_down",
	"tts_canned_clip",
	"tts_slow_canned_clip",
	"tts_space_down",
	"lane_rate_limited",
	// The turn's model throws the router's 404 before any text, so a spec sees Auto pick again.
	"lane_not_found",
	"lane_server_error",
	"primary_lane_rate_limited",
	// The first lane's first call ends in a 500 stream error after its provenance chunk and before any text (endpoints/failover.ts).
	"primary_stream_errors_once",
	"tool_round_rate_limited",
	"tool_round_rate_limited_sustained",
	"gap_map_db_down",
	// A content page gets fixture blocks after its own (lib/server/blockFixtures.ts), so a spec can drive a
	// block no CMS page carries yet.
	"block_fixtures",
	// The homepage gains a Cards block above a same-tone Promo Banner (siteFault.ts), so a spec scrolls that seam under block lag.
	"home_cards_promo_pair",
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
	// The send route's per-account daily turn cap drops to DAILY_TURN_CAP_FAULT, so a spec sends past it
	// in a few turns and sees the limit message.
	"daily_turn_cap_low",
	"answer_holds_midway",
	// One sentence, then silence until the shortened watchdog cuts the turn; a Continue gets the rest
	// (textGeneration/index.ts), so a spec sees a cut answer kept and finished.
	"answer_cut_at_ceiling",
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
	// A French crisis answer naming 3115, split across tokens, for the helpline number guard.
	"crisis_number_reply",
	// A Russian answer naming Russia's police 102, which the guard must keep for any visitor.
	"emergency_number_reply",
	// An answer that is one HTML page in an html code block, whose script would mark the page if it ran,
	// so a spec can open a shared chat holding it and see the script wait for Preview.
	"html_page_reply",
	// mila-sp-output-guard: a short English answer that endorses self-harm with no method, which the Mila
	// classifier scores unsafe (p 0.88), so a spec sees the card and the ended conversation with
	// the real detector and no model call.
	"mila_sp_unsafe_reply",
	"answer_loops",
	"model_replay",
	"model_replay_none",
	"mcp_stub_server",
	// The same stub with pins on its entry, listing set_setting rewritten since it was pinned
	// (mcp/e2eStub.ts `stubMcpServerSwapped`), so a spec sees chat leave the changed tool out.
	"mcp_stub_server_swapped",
	// The conversation's sandbox is a stand-in for a full E2B host (mcp/sandboxWaitStub.ts): each run
	// sends "Waiting for a free sandbox…" as MCP progress and answers seconds later, so a spec reads the
	// live line's wait and then the result.
	"sandbox_host_full",
	"input_screen_unfinished",
	"agent_route_down",
	"agent_route_screened",
	"answer_recites_preamble",
	"groundcheck_removes_claim",
	"answer_streams_past_cap",
	// One sentence at once, then a sentence every two seconds, so a spec that drops the stream
	// after the first sentence sees new text arrive afterwards while the turn is still running.
	"answer_streams_slowly",
	// A user flag's forward to Coop's /report answers 429, so a spec can show the flag still
	// succeeds and the refusal is logged at error level.
	"coop_report_rate_limited",
	// Every web search on the turn hangs (runSearch.ts `hang`), on the scaffolded route and in
	// the native web_search tool alike, so only the web leg's deadline ends it and a spec reads the note a
	// visitor gets when search doesn't finish.
	"web_search_hangs",
	// /chat/api/status answers `degraded` without asking Better Stack, so a spec sees the chat's
	// incident banner while the real status page reads operational.
	"status_page_degraded",
	// The CLI pairing link provisions its managed endpoint against a stub Pangolin answered
	// inside the process (managedInference/e2eStub.ts), so a spec can pair a device on a preview, which
	// has no Pangolin.
	"pangolin_stub",
	// The conversation's sandbox is answered in-process (mcp/e2eStub.ts `stubSandboxServer`), so a
	// spec drives a run and the usage-tier limit message without a live E2B host.
	"sandbox_stub",
	// The conversation's sandbox lists its tools but never answers a call (mcp/sandboxWaitStub.ts), so
	// only the turn's budget ends it and a spec reads the "code run timed out" step and the answer
	// that follows.
	"sandbox_call_hangs",
	// The second-opinion panel's last listed panelist comes back with no take and no model call
	// (second-opinion/+server.ts), so a spec sees the panel keep it listed as "no response in time".
	"panelist_never_answers",
	// The send's history MACs are checked and written as after a MAC key rotation: the configured keys
	// kept for checking and a new one active (chat/sealedTurn.ts `withE2eRotation`), so a spec continues
	// a sealed chat across a rotation in a browser.
	"history_mac_key_rotated",
] as const;

/** `session_rate_limit_low`: one message per 30s window. The window has to outlast the first answer,
 *  so the second send lands inside it; every send records an event, a refused one included, so the
 *  spec waits out the window from the refusal before sending again. */
export const SESSION_RATE_LIMIT_FAULT = { limit: 1, windowMs: 30_000 } as const;

/** `daily_turn_cap_low`: the turns one account may send in 24 hours under the fault. Two answers, then
 *  the third send is refused; the spec's account is fresh, so nothing else has counted. */
export const DAILY_TURN_CAP_FAULT = 2;

/** The generation watchdog an agent turn gets under `agent_turn_deadline_20s`. */
const AGENT_TURN_DEADLINE_FAULT_MS = 20_000;

/** The generation watchdog a turn gets under `generation_timeout`. The fault exercises the
 *  watchdog's abort path, which does not depend on how long the watchdog waits, and the live line must
 *  have counted a few seconds before the abort (it appears at 5s). The real 45s would make the spec
 *  using it the slowest in its shard. */
const GENERATION_TIMEOUT_FAULT_MS = 15_000;

/** The total cap a turn gets under `answer_streams_past_cap`: short enough that the fault's
 *  answer is still streaming when it arrives. */
const STREAMS_PAST_CAP_FAULT_MS = 4_000;

/** The generation watchdog's deadline for this turn: `configuredMs`, unless a fault that shortens the
 *  watchdog applies to this kind of turn. `primary_lane_hangs` keeps the real one, since the backup lane
 *  the silent-lane deadline moves the turn to has to answer inside it. */
export function watchdogDeadlineMs(
	configuredMs: number,
	fault: FaultInjectionName | null,
	opts: { isAgentTurn: boolean }
): number {
	if (opts.isAgentTurn && fault === "agent_turn_deadline_20s") return AGENT_TURN_DEADLINE_FAULT_MS;
	if (fault === "generation_timeout" || fault === "answer_cut_at_ceiling")
		return Math.min(configuredMs, GENERATION_TIMEOUT_FAULT_MS);
	if (fault === "answer_streams_past_cap") return Math.min(configuredMs, STREAMS_PAST_CAP_FAULT_MS);
	return configuredMs;
}

export type FaultInjectionName = (typeof FAULT_NAMES)[number];

/** `output_screen_window_short`: the screening window, the longest it may go without releasing a
 *  batch. It is never shorter than one Coop call's own timeout, so a slow but healthy screen cannot
 *  trip it. */
export function outputScreenWindowFaultMs(): number {
	return coopCallTimeoutMs();
}

/** `question_save_delayed`: how long the question's first write is held, just above the usual gap
 *  from send to save on a cold instance. */
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
 *  own `x-e2e-replay` header (`mock` by default; `new_episodes`, or `all` on a retry, in a record run; `none`), so a scenario spec replays by default and can
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

/** Puts this request's replay mode (resolveReplayMode) in its request context, where every model call
 *  reads it, and returns it. hooks/handle.ts calls it for every request, so a route that never reads the
 *  mode itself still replays. Sets nothing, and returns null, for a request the gate refuses. */
export async function adoptReplayMode(req: Request): Promise<ReplayMode | null> {
	const mode = await resolveReplayMode(req);
	if (mode) updateRequestContext({ replayMode: mode });
	return mode;
}

/** Whether this send asked for the live guard screen, from its own `x-e2e-guard: live` header
 *  behind the same gate as a fault. A `@real-screen` spec sends it on develop push, nightly and
 *  promotion runs, so those runs read what the live screen says rather than a recording of it. */
export async function resolveGuardLive(req: Request): Promise<boolean> {
	if (req.headers.get("x-e2e-guard") !== "live") return false;
	return carriesFaultInjectToken(req);
}

/** Whether this send's agent turn goes to the in-process stand-in for agent-service
 *  (endpoints/agent/fakeAgentService.ts), behind the same gate as a fault. Read from its own
 *  `x-e2e-agent: fake[;knob…]` header, so a spec can still inject one named fault beside it. */
export async function resolveFakeAgent(req: Request): Promise<FakeAgentRequest | null> {
	const [mode, ...rest] = (req.headers.get("x-e2e-agent") ?? "").split(";").map((s) => s.trim());
	if (mode !== "fake") return null;
	if (!(await carriesFaultInjectToken(req))) return null;
	return { knobs: rest.filter((k): k is FakeAgentKnob => (FAKE_AGENT_KNOBS as readonly string[]).includes(k)) };
}

/** The busy-mark scope a spec asks for, from `x-e2e-busy-scope` behind the same gate as a
 *  fault. The chat shell then reads, and the warm route's probe writes, marks under that scope only
 *  (modelBusy.ts), so a spec sees the whole probe-to-picker path without marking a model busy for every
 *  visitor on the preview. Null when the header is absent or the gate refuses it. */
export async function resolveBusyScope(req: Request): Promise<string | null> {
	const scope = req.headers.get("x-e2e-busy-scope")?.trim() ?? "";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(scope)) return null;
	if (!(await carriesFaultInjectToken(req))) return null;
	return scope;
}

/** A spec's request to run the warm probe now, on one model, under a busy scope: the scope
 *  above, the model from `x-e2e-probe-model`, and whether its lanes refuse (`every_lane_rate_limited` for a 429 or
 *  `every_lane_payment_required` for a 402, in `x-e2e-fault-inject`). Null unless the gate passes and both headers are present. */
export async function resolveProbeRequest(
	req: Request
): Promise<{ scope: string; model: string; refuse: 429 | 402 | null } | null> {
	const model = req.headers.get("x-e2e-probe-model")?.trim();
	if (!model) return null;
	const scope = await resolveBusyScope(req);
	if (!scope) return null;
	const fault = req.headers.get("x-e2e-fault-inject");
	const refuse = fault === "every_lane_rate_limited" ? 429 : fault === "every_lane_payment_required" ? 402 : null;
	return { scope, model, refuse };
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
