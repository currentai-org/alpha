#!/usr/bin/env node
// axiom-alert — run threshold queries against Axiom and hand the exceedances to the workflow's shared poster.
//
// VOCABULARY: these are counts crossing a configured threshold, and the word for that is "over", not
// "breach". A chat alert reading BREACH about a 5xx count reads as a security event to whoever is  (vocab-ok:security)
// on call, and none of these checks can detect one. Reserve "breach" for something actually getting  (vocab-ok:security)
// out. check-vocabulary.mjs enforces this.
//
// WHY WE POLL INSTEAD OF USING NATIVE NOTIFIERS. SLACK_ALERT_WEBHOOK is a Slack WORKFLOW trigger
// (hooks.slack.com/triggers/…), not an incoming app webhook. A Workflow trigger validates the POST body
// against the variables the workflow declares and rejects anything else, so a native notifier that
// sends Slack's own app message format fails with "input validation error". A custom-webhook notifier,
// where the body is ours to define, would fit but depends on the Axiom plan.
//
// So anything we control posts {"text": …} itself, in the same shape as the app's postSlack and the
// synthetic-turn failure step: one delivery path.
//
// An Axiom monitor evaluating with no notifier attached is a check that cannot go red, so any such
// monitor duplicating a check here should be deleted rather than left as a silent duplicate.
//
// Usage:  node scripts/axiom-alert.mjs [--window 15m | --since <ISO time> [--until <ISO time>]] [--dry-run]
//
// Every threshold is per 15 minutes. Scheduled runs are about 2 hours apart, not four an hour, so the
// scheduled run passes --since, the previous run's start (axiom-alert.yml). Every check
// reads from there in 15m bins and goes over when any one bin passes its bar (CUR-4169); bins sit on
// the clock's quarter hours, so a burst straddling one is split across two. A manual --window read is
// one total. server-errors is the check most likely to trip (model
// substitution shedding, a role naming a model its provider does not serve, stream errors), then
// http-5xx; empty-answers trips rarely and log-ingest and email-send should stay at zero. The boot-time "provider list
// could not be read" line is a warn, not an error, so it does not count toward server-errors.
// Env:    AXIOM_ALERT_QUERY_TOKEN (required — needs query:read on BOTH `aipotluck-eu` and `vercel-eu`, see below),
//         GITHUB_OUTPUT (optional): `over` gets the sorted keys over threshold and `what` one line
//         naming them. axiom-alert.yml hands both to the shared poster, which posts on a change only
//         (CUR-2713); this script never posts to Slack itself, so --dry-run only skips that output.
//
// NO SHARED AXIOM_DATASET (CUR-1415). Each check below names its own dataset, because the checks
// genuinely want different ones and a single module-level default is silently wrong for at least one
// of them whichever way it is set:
//   - server-errors needs `aipotluck-eu` (our own pino `level`, vocabulary info/warn/error/fatal, a
//     top-level column there). Pointed at `vercel-eu` instead, `level` resolves to VERCEL'S OWN request-
//     log field (vocabulary info/warning), so the check would not error; it would silently match
//     zero rows forever.
//   - http-5xx and empty-answers read `aipotluck-eu`, scoped by its `env` column, so the Vercel drain
//     can be retired (CUR-2591). Both lose what the app's own stream loses while its ingest is down;
//     log-ingest below is what reports that.
//   - log-ingest and email-send still read `vercel-eu`: each has to keep counting while app-side ingest
//     is broken, which a check reading that same stream cannot do.
// This is also why AXIOM_ALERT_QUERY_TOKEN needs query:read on both datasets, not one.

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const arg = (n, d) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// AXIOM_TOKEN in prd is the app's ingest-only token for the EU datasets, so the checks read with their own
// query token. Falling back to AXIOM_TOKEN keeps a local run with one admin token working.
const TOKEN = process.env.AXIOM_ALERT_QUERY_TOKEN || process.env.AXIOM_TOKEN || "";
const WINDOW = arg("window", "15m");
const SINCE = arg("since", "");
const UNTIL = arg("until", "");
const BIN = "15m";
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The span every check reads: from --since in 15m bins, else the --window ending at --until or now. */
function spanOf() {
	const end = UNTIL ? new Date(UNTIL) : new Date();
	if (SINCE) {
		return { start: SINCE, end: end.toISOString(), label: `${SINCE} to ${UNTIL || "now"}`, binned: true };
	}
	const m = /^(\d+)([mhd])$/.exec(WINDOW);
	if (!m) throw new Error(`--window ${WINDOW} is not a count of m, h or d`);
	const start = new Date(end.getTime() - Number(m[1]) * UNIT_MS[m[2]]).toISOString();
	return { start, end: end.toISOString(), label: UNTIL ? `${WINDOW} to ${UNTIL}` : `the last ${WINDOW}` };
}
const DRY = flag("dry-run");

// Thresholds sit above production's baseline.
// Both are deliberately above 1: a single 500 from one malformed request is noise, and an alert that
// fires on noise gets muted.
const CHECKS = [
	{
		key: "server-errors",
		label: "server errors",
		threshold: 3,
		// PRODUCTION ONLY, like http-5xx below (CUR-4358). A line that is expected and handled logs at
		// warn at its source rather than being excluded here, so this stays "every error our code logged".
		apl: `['aipotluck-eu'] | where env == 'production' | where level in ('error','fatal')`,
		runbook:
			"OUR code, not a vendor — no dependency probe will be red. Group them in PostHog error tracking, then check Axiom for full context on one error_id.",
	},
	{
		key: "http-5xx",
		label: "HTTP 5xx responses",
		threshold: 3,
		// The app's own request lines, where status_code is a column (CUR-2591). It sees what the
		// drain sees except while app-side ingest is down. A failure at the edge or in the adapter
		// never produces an app line, so it is invisible here: Better Stack's page check is what sees
		// the site down. PRODUCTION ONLY (CUR-1690), since the alert line says "prod".
		apl: `['aipotluck-eu'] | where env == 'production' | where toint(column_ifexists('status_code', int(null))) >= 500`,
		runbook:
			"Requests our app answered with a 5xx. Check the latest deploy first, then group the errors in PostHog error tracking.",
	},
	{
		key: "empty-answers",
		label: "empty grounded answers (hedgeGuard replacements)",
		threshold: 2,
		// PRODUCTION ONLY, and that filter is the check, not decoration. hedgeGuard fires constantly on
		// preview during eval runs, so an unfiltered version would alert on our own testing and get
		// muted. The guard name sits in the `mutations` array of the "[honesty] final-only mutations"
		// line, not in `message` (CUR-2591).
		apl: `['aipotluck-eu'] | where env == 'production' | where message == '[honesty] final-only mutations' | where tostring(column_ifexists('mutations', '')) contains 'groundedHedgeReplacement'`,
		runbook:
			"The model returned citations with no prose and hedgeGuard swapped in the sources pointer — the user got no answer. Suspect a RAG corpus or prompt-budget change: on 2026-08-04 raising the curated snippet cap 480->1200 produced this on 3 of 6 runs. Check what last shipped to the RAG index, then reproduce with `pnpm eval:policy-grounding`.",
	},
	{
		key: "log-ingest",
		label: "log lines rejected by Axiom ingest",
		threshold: 0,
		// axiomStream.ts writes `[axiom] ingest <status> for dataset …` to stderr for every rejected
		// batch, and the drain carries stderr here. A token without ingest scope produces these on every
		// batch and leaves the app's own log search empty until someone reads them (CUR-1690).
		//
		// 4xx ONLY, and that is what makes a threshold of zero safe. A 4xx is a token or dataset name
		// that is wrong, which never fixes itself. `[axiom] ingest unreachable` is a network blip that
		// shows up about once a day in production, so counting it would page most days.
		apl: `['vercel-eu'] | where environment == 'production' | where message matches regex @'\\[axiom\\] ingest 4[0-9][0-9] '`,
		runbook:
			"The app's logs are not reaching the aipotluck-eu dataset, so Axiom log search is missing everything since this started. A 403 means AXIOM_TOKEN in Doppler alpha-chat/prd lacks ingest on aipotluck-eu: Axiom fixes a token's permissions at creation, so mint a replacement, set it Encrypted in Doppler, and redeploy production. Confirm by a new row in aipotluck-eu, not by a 200 from a hand POST.",
	},
	{
		key: "email-send",
		label: "sign-in and invitation emails Resend refused",
		threshold: 0,
		// CUR-1252. Email is the only route into an account, and Resend's plan caps sends at 100/day.
		// betterAuth.ts logs "[auth] Resend send failed" (OTP) and
		// "[auth] Resend send failed (workspace invite)" at error level; `contains` reads both. Read from
		// the drain rather than `aipotluck`, so it still counts while app-side ingest is down (see
		// log-ingest above). Zero is safe: sends essentially never fail,
		// so one failure is somebody who could not sign in.
		apl: `['vercel-eu'] | where environment == 'production' | where message contains '[auth] Resend send failed'`,
		runbook:
			"Someone asked for a sign-in or invitation email and Resend refused it. A 429 or a quota message in the logged body means the daily cap: check usage in the Resend dashboard (the prod key is send-only). Sends vs failures over time: the same query on 'Resend' in Axiom's vercel dataset, split by whether the message says 'send failed'.",
	},
	{
		key: "search-refusals",
		label: "search engine refusals (402/403/429)",
		// CUR-2597. One line per engine or reranker, with its own bar: a paid one refusing us (Firecrawl out of
		// credit, a revoked key) never fixes itself, so one is the alert; free OpenAlex and arXiv
		// answer 429 in short bursts under load, so each gets a bar of 5. Status reads from the logged field, falling
		// back to the `<url> → <status>` message lines.
		perGroup: "engine",
		threshold: 0,
		thresholds: { openalex: 5, arxiv: 5 },
		apl: `['aipotluck-eu'] | where env == 'production' | where message startswith '[search] engine failed' or (message startswith '[rerank] ' and message contains ' non-OK') | extend st = coalesce(tostring(column_ifexists('status', '')), extract(@'→ ([0-9]{3})', 1, tostring(column_ifexists('err.message', '')))) | where st in ('402','403','429') | extend engine = tostring(column_ifexists('engine', 'unknown'))`,
		runbook:
			"A search engine refused our calls, so turns ran without its sources. 402 or 403 from Firecrawl: credit or key, check the Firecrawl dashboard and FIRECRAWL_API_KEY in Doppler alpha-chat/prd. 429 from OpenAlex or arXiv: their rate limit, which passes; if it holds for an hour, lower that engine's per-turn calls.",
	},
];

// WHAT THIS THRESHOLD DOES AND DOES NOT CATCH, said out loud because a bound nobody states reads as
// full coverage. Production baseline is 2 events in 19,351 turns over 30 days, and prod runs ~6.7
// turns per 15m window. So >2 in 15m catches a collapse affecting roughly half of all turns and will
// NOT catch a slow 5% drop, which stays under the threshold in every window. Catching that needs a longer bin per check, which this does not do.

if (!TOKEN) {
	console.error("AXIOM_ALERT_QUERY_TOKEN unset — cannot query. This job is inert without it, by design: see CUR-82.");
	process.exit(2);
}

// The count per group (or under "" with no group): the largest in any one bin when the span is binned,
// else the span's total. An empty result still comes back as one row with a null group and a zero count.
async function runQuery(where, perGroup, span) {
	const by = [span.binned && "bin15", perGroup].filter(Boolean).join(", ");
	const binned = span.binned ? ` | extend bin15 = bin(_time, ${BIN})` : "";
	const apl = `${where}${binned} | summarize count()${by ? ` by ${by}` : ""}`;
	const res = await fetch("https://api.axiom.co/v1/datasets/_apl?format=legacy", {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ apl, startTime: span.start, endTime: span.end }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`Axiom HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = await res.json();
	const worst = new Map();
	for (const t of data?.buckets?.totals ?? []) {
		const group = perGroup ? String(t?.group?.[perGroup] ?? "unknown") : "";
		const n = Number(t?.aggregations?.[0]?.value ?? 0);
		if (n > (worst.get(group) ?? 0)) worst.set(group, n);
	}
	return [...worst].map(([group, n]) => ({ group, n }));
}

const per = (span) => (span.binned ? `in one ${BIN} bin` : `in ${WINDOW}`);
const overChecks = [];
let failures = 0;

for (const check of CHECKS) {
	try {
		const span = spanOf();
		if (check.perGroup) {
			const rows = (await runQuery(check.apl, check.perGroup, span)).filter((r) => r.n > 0);
			if (rows.length === 0) console.log(`${check.key}: 0 ${per(span)} ok, ${span.label}`);
			for (const { group, n } of rows) {
				const bar = check.thresholds?.[group] ?? check.threshold;
				const isOver = n > bar;
				console.log(
					`${check.key}[${group}]: ${n} ${per(span)} (threshold ${bar}) ${isOver ? "OVER" : "ok"}, ${span.label}`
				);
				if (isOver) {
					overChecks.push({
						key: `${check.key}:${group}`,
						text: `${check.label}, ${group}: ${n} ${per(span)} (threshold ${bar}), ${span.label}`,
					});
					console.log(`::warning::${check.key}[${group}]: ${check.runbook}`);
				}
			}
			continue;
		}
		const n = (await runQuery(check.apl, undefined, span))[0]?.n ?? 0;
		const isOver = n > check.threshold;
		console.log(
			`${check.key}: ${n} ${per(span)} (threshold ${check.threshold}) ${isOver ? "OVER" : "ok"}, ${span.label}`
		);
		if (isOver) {
			overChecks.push({
				key: check.key,
				text: `${check.label} ${n} ${per(span)} (threshold ${check.threshold}), ${span.label}`,
			});
			console.log(`::warning::${check.key}: ${check.runbook}`);
		}
	} catch (e) {
		// One broken check must not hide the others, but it must NOT pass silently either — a query that
		// errors every run is an alert that never fires.
		failures++;
		console.error(`::error::${check.key} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

overChecks.sort((a, b) => a.key.localeCompare(b.key));
const outFile = process.env.GITHUB_OUTPUT;
if (outFile && !DRY) {
	appendFileSync(
		outFile,
		`over=${overChecks.map((c) => c.key).join(",")}\nwhat=${overChecks.map((c) => c.text).join("; ")}\n`
	);
}
console.log(`done — ${CHECKS.length} checks, ${overChecks.length} over threshold, ${failures} failure(s)`);
process.exit(failures > 0 ? 1 : 0);
