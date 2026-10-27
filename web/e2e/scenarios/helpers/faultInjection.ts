import type { Page } from '@playwright/test';

// Install the fault-injection header pair on exactly the chat send request, so a spec can
// prove it goes red for the failure it's named after (CUR-1614) — see
// $lib/chat/server/textGeneration/faultInjection.ts for the server-side gate and the full fault
// vocabulary (`no_assistant_reply`, `generation_timeout`, `title_latency_10s`, `primary_lane_down`, `primary_lane_hangs`, `output_screen_timeout`, `output_screen_window_short`, `tts_canned_clip`, `tts_slow_canned_clip`, `tts_canned_clip_output_blocked`, `output_guard_unreachable`, `input_guard_unreachable`, `output_screen_recheck_clears`, `tts_space_down`, `lane_rate_limited`, `lane_not_found`, `primary_lane_rate_limited`, `tool_round_rate_limited`, `tool_round_rate_limited_sustained`, `chat_500`, `stream_truncates_midway`, `provenance_header_stripped`, `question_save_delayed`, `wrong_model_served`, `latency_30s`, `canned_reply`, `answer_recites_preamble`, `caret_cited_reply`, `crisis_line_reply`, `model_replay` and `mcp_stub_server` are wired to a real simulation today).
//
// Scoped via page.route() rather than Playwright's global `use.extraHTTPHeaders`, same reason
// signIn.ts's installOtpBypassHeader is: a header sent on every request forces a CORS preflight on
// cross-origin ones (fonts.gstatic.com doesn't allow arbitrary custom headers), so a global header
// broke font loading there. Routing it to one path means nothing else on the page ever sees it.
//
// Matched on `/conversation/<id>` as a path SUFFIX rather than a fixed `/chat/conversation/` prefix,
// so the route (src/routes/chat/conversation/[id]/+server.ts) is still found if chat's base moves.
const CONVERSATION_SEND_PATH = /\/conversation\/[a-f0-9]+$/;
/** `POST /chat/conversation`, the request that makes a new chat, for a fault its route reads
 *  (`conversation_limit_reached`, CUR-2875). */
export const CONVERSATION_CREATE_PATH = /\/conversation$/;

/** Every fault the server simulates, as a list a model's tool schema can offer (the cold walk's
 *  force_fault, SOL-164). */
export const FAULT_INJECTION_NAMES = [
	'no_assistant_reply',
	'generation_timeout',
	'title_latency_10s',
	'provenance_header_stripped',
	'stream_truncates_midway',
	'chat_500',
	'latency_30s',
	'wrong_model_served',
	'primary_lane_down',
	'primary_lane_hangs',
	'every_lane_hangs',
	'every_lane_rate_limited',
	'output_screen_timeout',
	'output_screen_window_short',
	'tts_canned_clip',
	'tts_slow_canned_clip',
	'tts_space_down',
	'lane_rate_limited',
	'lane_not_found',
	'lane_server_error',
	'primary_lane_rate_limited',
	'tool_round_rate_limited',
	'tool_round_rate_limited_sustained',
	'gap_map_db_down',
	'csam_scanner_down',
	'guest_file_move_skipped',
	'question_save_delayed',
	'agent_turn_deadline_20s',
	'output_screen_blocks',
	'output_screen_blocks_rule',
	'tts_canned_clip_output_blocked',
	'output_guard_unreachable',
	'input_guard_unreachable',
	'input_screen_declines_rule',
	'output_screen_recheck_clears',
	'session_rate_limit_low',
	'answer_holds_midway',
	'storage_listing_down',
	'storage_hub_rate_limited',
	'storage_hub_read_rate_limited',
	'storage_quota_full',
	'conversation_limit_reached',
	'canned_reply',
	'answer_recites_preamble',
	'caret_cited_reply',
	'grounded_answer_hedges',
	'crisis_line_reply',
	'crisis_number_reply',
	'emergency_number_reply',
	'answer_loops',
	'model_replay',
	'model_replay_none',
	'mcp_stub_server',
	'sandbox_host_full',
	'input_screen_unfinished',
	'agent_route_down',
	'agent_route_screened',
	'groundcheck_removes_claim',
	'answer_streams_past_cap',
	'coop_report_rate_limited',
	'web_search_hangs',
	'status_page_degraded',
	'pangolin_stub',
	'sandbox_stub'
] as const;

export type FaultInjectionName = (typeof FAULT_INJECTION_NAMES)[number];

/** The header pair that asks the server for `fault`. Both install helpers below send it, and so does
 *  a spec whose own route handler sends the request (`route.fetch`): Playwright runs the newest
 *  matching route first, and a handler that fulfills ends the chain, so installFaultInjectionHeader's
 *  handler never runs. Throws on a missing token for the reason installFaultInjectionHeader gives. */
export function faultInjectionHeaders(fault: FaultInjectionName): Record<string, string> {
	const token = process.env.E2E_FAULT_INJECT_TOKEN;
	if (!token) {
		throw new Error(
			'E2E_FAULT_INJECT_TOKEN is not set — the fault-injection proof cannot run without it ' +
				'(set in Doppler preview/dev configs only, never prd; see config/env-manifest.mjs).'
		);
	}
	return { 'x-e2e-fault-inject-token': token, 'x-e2e-fault-inject': fault };
}

/** Throws (rather than silently no-op like installOtpBypassHeader) when the token is unset: this is
 *  only ever called by a spec that explicitly needs the fault to fire, so a silent no-op here would
 *  make an injury proof pass for the wrong reason — a green because no fault ever reached the server,
 *  which is indistinguishable on screen from the app surviving a real one.
 *
 *  `disarm()` lets later sends through clean, for a spec that presses Retry after the failure. The
 *  spec says when, because the client resends a failed turn by itself and a count of sends would
 *  let that resend through. */
export async function installFaultInjectionHeader(
	page: Page,
	fault: FaultInjectionName,
	path: RegExp = CONVERSATION_SEND_PATH,
	method: 'POST' | 'DELETE' | 'GET' = 'POST'
): Promise<{ disarm: () => void }> {
	const faultHeaders = faultInjectionHeaders(fault);
	const base = process.env.SCENARIO_BASE_URL;
	let armed = true;
	await page.route(
		(url) => (!base || url.origin === new URL(base).origin) && path.test(url.pathname),
		(route) => {
			if (route.request().method() !== method || !armed) return route.continue();
			return route.continue({
				headers: { ...route.request().headers(), ...faultHeaders }
			});
		}
	);
	return {
		disarm: () => {
			armed = false;
		}
	};
}

/** The same header pair on one page navigation (a GET of `path`) rather than on the chat send: for
 *  a fault a page's server load reads, such as `gap_map_db_down` (CUR-2304). Throws on a missing
 *  token for the reason installFaultInjectionHeader does. */
export async function installPageFaultHeader(
	page: Page,
	fault: FaultInjectionName,
	path: string
): Promise<void> {
	const faultHeaders = faultInjectionHeaders(fault);
	const base = process.env.SCENARIO_BASE_URL;
	await page.route(
		(url) => (!base || url.origin === new URL(base).origin) && url.pathname === path,
		(route) => {
			if (route.request().resourceType() !== 'document') return route.continue();
			return route.continue({
				headers: { ...route.request().headers(), ...faultHeaders }
			});
		}
	);
}

/**
 * The journey gallery's recordings are the demo reels (CUR-2954), so a canned answer there puts "This
 * is a canned reply" on screen as Alpha's answer. journey-gallery.yml sets this and canned replies
 * stand down, leaving the turn to the replay store, whose answers are a real model's, recorded.
 * Replay and the Stop hold stay armed (SOL-287), so the gallery calls no live model on a turn.
 */
function noCannedReplies(): boolean {
	return process.env.SCENARIO_NO_CANNED_REPLIES === '1';
}

/**
 * Answer this page's chat turns with the server's canned reply instead of a model, for a spec
 * that checks only our own UI. Unlike installFaultInjectionHeader it never throws on a missing token:
 * where the token is unset (a run against production, whose server ignores the header anyway) the turn
 * gets a real answer, which such a spec accepts, since nothing it asserts depends on what the answer
 * says. Returns whether the canned reply was armed, for a spec that wants to annotate which it got.
 */
export async function installCannedReplies(page: Page): Promise<boolean> {
	const armed = Boolean(process.env.E2E_FAULT_INJECT_TOKEN) && !noCannedReplies();
	if (armed) await installFaultInjectionHeader(page, 'canned_reply');
	return armed;
}

/**
 * Answer this page's model calls from a recording, for a spec that checks what our pipeline
 * does around an answer (provenance, the routing record, the stream filters) and not what the model
 * writes. Recordings live in a store every run shares, read from this branch's scope, then
 * the base branch's. A request with no recording goes to the live model and is recorded under this branch;
 * with `E2E_REPLAY_MODE=none` it fails instead, so a green run proves it made no live model call.
 * Without the token it does nothing and the turn is live, which such a spec accepts. Returns whether
 * replay was armed.
 */
export async function installModelReplay(page: Page): Promise<boolean> {
	const armed = Boolean(process.env.E2E_FAULT_INJECT_TOKEN);
	if (armed)
		await installFaultInjectionHeader(
			page,
			process.env.E2E_REPLAY_MODE === 'none' ? 'model_replay_none' : 'model_replay'
		);
	return armed;
}

/**
 * A spec that presses Stop needs an answer still streaming when it does. A PR run answers
 * from the replay store, which hands over the whole answer in milliseconds, so Stop was gone before
 * the click on most runs. This holds the turn after one sentence (`answer_holds_midway`, 20s) so
 * Stop is certainly there. It stands down where there is no token (a run against production), since
 * a live answer streams slowly enough (CUR-4027). Returns the fault's disarm, or null where it stood down.
 */
export async function holdAnswerForStop(page: Page): Promise<{ disarm: () => void } | null> {
	const armed = Boolean(process.env.E2E_FAULT_INJECT_TOKEN);
	return armed ? installFaultInjectionHeader(page, 'answer_holds_midway') : null;
}

/** Send this page's document loads with a busy-mark scope, so the chat shell reads the marks
 *  `runModelProbe` wrote under it and no one else's. Only document requests and the open tab's re-read
 *  of the marks (`/chat/api/busy`, CUR-4629) carry it. */
export async function installBusyScopeHeader(page: Page, scope: string): Promise<void> {
	const { 'x-e2e-fault-inject-token': token } = faultInjectionHeaders('canned_reply');
	const base = process.env.SCENARIO_BASE_URL;
	await page.route(
		(url) => !base || url.origin === new URL(base).origin,
		(route) => {
			const busyRead = new URL(route.request().url()).pathname.endsWith('/api/busy');
			if (route.request().resourceType() !== 'document' && !busyRead) return route.continue();
			return route.continue({
				headers: {
					...route.request().headers(),
					'x-e2e-fault-inject-token': token,
					'x-e2e-busy-scope': scope
				}
			});
		}
	);
}

type ProbeVerdict =
	| { ok: true; ms: number; served?: string; identity: string }
	| { ok: false | null; ms: number; reason: string };

/** Run the warm cron's probe on `model` now, through `/chat/api/warm`, writing its verdict
 *  under `scope`. `refuse` makes every lane of the model answer 429 (`every_lane_rate_limited`). */
export async function runModelProbe(
	page: Page,
	{ model, scope, refuse }: { model: string; scope: string; refuse: boolean }
): Promise<ProbeVerdict> {
	const { 'x-e2e-fault-inject-token': token } = faultInjectionHeaders('every_lane_rate_limited');
	const res = await page.request.get('/chat/api/warm', {
		headers: {
			'x-e2e-fault-inject-token': token,
			'x-e2e-busy-scope': scope,
			'x-e2e-probe-model': model,
			...(refuse ? { 'x-e2e-fault-inject': 'every_lane_rate_limited' } : {})
		},
		timeout: 90_000
	});
	if (res.status() !== 200) {
		throw new Error(
			`the probe route answered ${res.status()}: ${(await res.text()).slice(0, 300)}`
		);
	}
	return ((await res.json()) as { verdict: ProbeVerdict }).verdict;
}
