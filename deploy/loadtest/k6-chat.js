// k6 load run against the compose stack (deploy/compose.yaml) answering from a mock model. Started by
// .github/workflows/load.yml in grafana/k6, once per concurrency level and once for the soak.
//
// Each VU is one guest chatting: it opens a conversation (POST /conversation, which also mints its
// session), sends a turn the way the browser does (POST /conversation/<id>, multipart `data`), reads the
// whole answer stream, waits THINK_SECS and sends the next. The model is aimock (aimock.compose.yaml), so
// no tokens are spent and every turn takes the app's real model path. The numbers measure the app and its
// database, never inference.
//
// A VU starts a fresh conversation every TURNS_PER_CONVERSATION turns, under the per-conversation message
// limit, and a fresh guest session every TURNS_PER_SESSION, under the per-account daily turn cap. Its own
// pace (one turn per THINK_SECS plus the answer) stays under the per-session 20 a minute.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
// Thousands of turns from synthetic guests: only a stack on this machine may take them.
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
	throw new Error(`refusing to load ${BASE}: this harness loads a stack on localhost only`);
}
// Where chat's routes are: the root on the chat build deploy/compose.yaml runs, /chat on a site build.
const CHAT = __ENV.CHAT_PATH || '';
const VUS = Number(__ENV.VUS || 10);
const HOLD = __ENV.HOLD || '2m';
const RAMP = __ENV.RAMP || '20s';
const THINK_SECS = Number(__ENV.THINK_SECS || 5);
const LABEL = __ENV.LABEL || `${VUS}vu`;
const TURNS_PER_CONVERSATION = 20;
const TURNS_PER_SESSION = 120;
const PROMPTS = [
	'What is the capital of Norway?',
	'What is the capital of Finland?',
	"Give me three tips for a good night's sleep.",
	'How do I boil an egg?'
];

export const options = {
	// k6 empties each VU's cookie jar at every iteration by default, which drops the guest session after
	// one turn: the next turn then reads as a stranger's and gets 404 on the conversation. The VU rotates
	// its session itself, every TURNS_PER_SESSION turns.
	noCookiesReset: true,
	scenarios: {
		chat: {
			executor: 'ramping-vus',
			startVUs: 0,
			stages: [
				{ target: VUS, duration: RAMP },
				{ target: VUS, duration: HOLD }
			],
			gracefulRampDown: '30s',
			gracefulStop: '60s'
		}
	},
	// Always true: they make k6 report the hold-phase submetrics in the summary.
	thresholds: {
		'turn_ms{phase:hold}': ['p(95)>=0'],
		'turn_ttfb_ms{phase:hold}': ['p(95)>=0'],
		'create_ms{phase:hold}': ['p(95)>=0'],
		'turn_failed{phase:hold}': ['rate>=0']
	},
	summaryTrendStats: ['med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count']
};

const turnMs = new Trend('turn_ms', true); // POST to the stream's end: what a person waits for the whole answer
const turnTtfb = new Trend('turn_ttfb_ms', true); // POST to the first byte of the stream
const createMs = new Trend('create_ms', true);
const turnFailed = new Rate('turn_failed');
const turns429 = new Counter('turn_429');
const turns5xx = new Counter('turn_5xx');
const createFailed = new Counter('create_failed');
const turnsDeclined = new Counter('turn_declined');

// The request schema takes the turn's `id` only as a UUID; anything else is refused at parse, before the
// turn path runs, so a non-UUID id measures the error path instead of chat.
function uuid() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
		return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function createConversation(model, tags) {
	const res = http.post(`${BASE}${CHAT}/conversation`, JSON.stringify({ model }), {
		headers: { origin: BASE, 'content-type': 'application/json' },
		tags: { name: 'create', ...tags },
		timeout: '60s'
	});
	return { res, id: res.status === 200 ? res.json('conversationId') : null };
}

// One turn the way the browser sends it. Answered only when the stream carried the final answer, no error
// status and no safety decline. A decline also ends in a final answer (its decline copy), and a stack
// that declines every turn would otherwise read as a fast, healthy one.
const declinedIn = (body) => body.includes('"type":"safety"') || body.includes('"type":"outputSafety"');
function sendTurn(id, inputs, tags) {
	const turnId = uuid();
	const payload = JSON.stringify({ inputs, id: turnId, is_retry: false, webSearchMode: 'off' });
	// Not from __VU/__ITER: setup() sends a turn too, and k6 defines neither there.
	const boundary = `k6chat${turnId.replace(/-/g, '')}`;
	const body = `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
	const res = http.post(`${BASE}${CHAT}/conversation/${id}`, body, {
		headers: { origin: BASE, 'content-type': `multipart/form-data; boundary=${boundary}` },
		tags: { name: 'turn', ...tags },
		timeout: '120s'
	});
	const declined = typeof res.body === 'string' && declinedIn(res.body);
	const answered =
		res.status === 200 &&
		typeof res.body === 'string' &&
		res.body.includes('"finalAnswer"') &&
		!res.body.includes('"status":"error"') &&
		!declined;
	return { res, answered, declined };
}

const snippet = (res) => (typeof res.body === 'string' ? res.body.slice(0, 200) : '');

export function setup() {
	const res = http.get(`${BASE}${CHAT}/api/models`, { timeout: '30s' });
	if (res.status !== 200) throw new Error(`GET ${CHAT}/api/models answered ${res.status}`);
	const models = res.json();
	const model = Array.isArray(models) && models.length ? models[0].id || models[0].name : null;
	if (!model) throw new Error(`no model advertised by ${CHAT}/api/models`);
	// One probe turn must answer before any load starts; a level whose turns all fail measures nothing.
	const created = createConversation(model, { phase: 'setup' });
	if (!created.id) throw new Error(`probe: POST ${CHAT}/conversation answered ${created.res.status}`);
	const probe = sendTurn(created.id, 'Probe turn: reply ok', { phase: 'setup' });
	if (!probe.answered) {
		throw new Error(`probe turn not answered: HTTP ${probe.res.status} ${snippet(probe.res)}`);
	}
	console.log(`probe turn answered in ${Math.round(probe.res.timings.duration)} ms`);
	return { model, t0: Date.now() };
}

// The ramp's numbers mix a warming stack with a loaded one, so only the hold is reported.
const rampMs = (() => {
	const m = /^(\d+)(s|m)$/.exec(RAMP);
	return m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : 1_000) : 20_000;
})();
const phaseOf = (t0) => (Date.now() - t0 < rampMs ? 'ramp' : 'hold');

let conversationId = null;
let failureLogged = false;
let turnsInConversation = 0;
let turnsInSession = 0;

function openConversation(model, tags) {
	if (turnsInSession >= TURNS_PER_SESSION) {
		http.cookieJar().clear(BASE);
		turnsInSession = 0;
	}
	const { res, id } = createConversation(model, tags);
	createMs.add(res.timings.duration, tags);
	if (!id) {
		createFailed.add(1, { ...tags, status: String(res.status) });
		return false;
	}
	conversationId = id;
	turnsInConversation = 0;
	return true;
}

export default function (data) {
	const tags = { phase: phaseOf(data.t0) };
	if (!conversationId || turnsInConversation >= TURNS_PER_CONVERSATION) {
		if (!openConversation(data.model, tags)) {
			sleep(THINK_SECS);
			return;
		}
	}
	const { res, answered, declined } = sendTurn(
		conversationId,
		PROMPTS[(__VU + __ITER) % PROMPTS.length],
		tags
	);
	turnsInConversation += 1;
	turnsInSession += 1;
	turnMs.add(res.timings.duration, tags);
	turnTtfb.add(res.timings.waiting, tags);
	turnFailed.add(!answered, tags);
	if (!answered && !failureLogged) {
		failureLogged = true; // one line per VU, so a failing level says why without flooding the log
		console.warn(`VU ${__VU} turn not answered: HTTP ${res.status} ${snippet(res)}`);
	}
	check(res, { 'turn answered': () => answered });
	if (declined) turnsDeclined.add(1, tags);
	if (res.status === 429) turns429.add(1, tags);
	if (res.status >= 500 || res.status === 0) turns5xx.add(1, tags);
	if (!answered) conversationId = null; // start clean after a failure, as a person would reload
	sleep(THINK_SECS);
}

export function handleSummary(data) {
	const m = data.metrics;
	const v = (name, stat) =>
		m[name] && m[name].values[stat] !== undefined ? m[name].values[stat] : null;
	const holdSecs = (() => {
		const mm = /^(\d+)(s|m)$/.exec(HOLD);
		return mm ? Number(mm[1]) * (mm[2] === 'm' ? 60 : 1) : null;
	})();
	const turns = v('turn_ms{phase:hold}', 'count') || 0;
	const row = {
		label: LABEL,
		vus: VUS,
		think_secs: THINK_SECS,
		hold_secs: holdSecs,
		turns_hold: turns,
		turns_per_min: holdSecs ? Math.round((turns / holdSecs) * 60) : null,
		turn_p50_ms: Math.round(v('turn_ms{phase:hold}', 'med') || 0),
		turn_p95_ms: Math.round(v('turn_ms{phase:hold}', 'p(95)') || 0),
		turn_p99_ms: Math.round(v('turn_ms{phase:hold}', 'p(99)') || 0),
		ttfb_p50_ms: Math.round(v('turn_ttfb_ms{phase:hold}', 'med') || 0),
		ttfb_p95_ms: Math.round(v('turn_ttfb_ms{phase:hold}', 'p(95)') || 0),
		create_p95_ms: Math.round(v('create_ms{phase:hold}', 'p(95)') || 0),
		error_rate: v('turn_failed{phase:hold}', 'rate'),
		turn_429: v('turn_429', 'count') || 0,
		turn_5xx: v('turn_5xx', 'count') || 0,
		turn_declined: v('turn_declined', 'count') || 0,
		create_failed: v('create_failed', 'count') || 0
	};
	const line =
		`${LABEL}: ${VUS} VUs, ${row.turns_hold} turns in the hold (${row.turns_per_min}/min), ` +
		`turn p50 ${row.turn_p50_ms}ms p95 ${row.turn_p95_ms}ms, first byte p95 ${row.ttfb_p95_ms}ms, ` +
		`errors ${row.error_rate === null ? 'n/a' : (row.error_rate * 100).toFixed(2) + '%'} ` +
		`(declined ${row.turn_declined}, 429 ${row.turn_429}, 5xx ${row.turn_5xx}, create failed ${row.create_failed})\n`;
	return {
		stdout: line,
		[`/out/${LABEL}.json`]: JSON.stringify(row),
		[`/out/${LABEL}-full.json`]: JSON.stringify(data)
	};
}
