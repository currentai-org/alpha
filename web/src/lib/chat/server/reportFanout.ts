// Fan a saved answer report out to Slack and Linear, behind the `report-fanout` flag.
//
// The `reports` row is the record; this only tells people it exists. So every sink is best-effort:
// the row is already written before this runs, a Slack or Linear outage loses nothing, and nothing
// here throws. Slack gets a link to the admin anchor and the reason, never the answer or anything the
// person typed, because a report filed as "privacy" is often a report about pasted personal details.
// Linear gets "User report: <reason>: <first line of the answer>", with the answer left out for a
// privacy report.
//
// Dedupe: a burst of reports from one person, each within DEDUPE_WINDOW_MS of the one before, makes one
// Linear issue. The burst's first report creates it and posts to Slack; each later one finds that issue
// through the attachment URL (the first report's admin anchor) and comments the running count. The
// burst is walked back report by report, not cut at one window before the newest, which would make a steady
// stream's third report look for an issue under the second, a repeat with none (CUR-2913). If a later
// report's fan-out runs before the first one's issue exists, or a burst runs past BURST_LOOKBACK_MS,
// the count comment is skipped and logged; the rows themselves are all on the admin page either way. (CUR-997)

import { and, desc, eq, gte } from "drizzle-orm";
import { ANSWER_REPORT_REASONS } from "$lib/chat/reportReasons";
import { config } from "$lib/chat/server/config";
import { getDb } from "$lib/chat/server/db/client";
import { reports, type ReportRow } from "$lib/chat/server/db/schema";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { postSlackWebhook } from "../../../../scripts/lib/slackWebhook.mjs";

export const REPORT_FANOUT_FLAG = "report-fanout";
export const DEDUPE_WINDOW_MS = 2 * 60_000;
const BURST_LOOKBACK_MS = 60 * 60_000;
const TITLE_SNIPPET_MAX = 80;
const LINEAR_API = "https://api.linear.app/graphql";

type FanoutRow = Pick<
	ReportRow,
	"id" | "reason" | "category" | "answerText" | "answerModel" | "userId" | "sessionId" | "createdAt"
>;

export interface FanoutDeps {
	flagOn: () => boolean;
	origin: () => string | undefined;
	/** Reports from the same person since `since`, oldest first, including `row` itself. */
	recentFromReporter: (row: FanoutRow, since: Date) => Promise<FanoutRow[]>;
	slack: ((text: string) => Promise<void>) | null;
	linear: LinearSink | null;
}

export interface LinearSink {
	createIssue(input: { title: string; description: string; url: string }): Promise<string | null>;
	findIssueByUrl(url: string): Promise<string | null>;
	comment(issueId: string, body: string): Promise<void>;
}

export function reportAnchorUrl(origin: string, reportId: string): string {
	return `${origin.replace(/\/$/, "")}/chat/admin/reports#report-${reportId}`;
}

function reasonLabel(row: FanoutRow): string {
	const known = ANSWER_REPORT_REASONS.find((r) => r.key === row.reason);
	return known?.label ?? row.reason ?? row.category ?? "unspecified";
}

/** The first non-empty line of the answer, capped, or "" for a privacy report or no answer. */
function titleSnippet(row: FanoutRow): string {
	if (row.reason === "privacy" || !row.answerText) return "";
	const line = row.answerText.split("\n").find((l) => l.trim()) ?? "";
	const t = line.trim();
	return t.length > TITLE_SNIPPET_MAX ? `${t.slice(0, TITLE_SNIPPET_MAX - 1)}…` : t;
}

export function linearTitle(row: FanoutRow): string {
	const snippet = titleSnippet(row);
	return snippet
		? `User report: ${reasonLabel(row)}: ${snippet}`
		: `User report: ${reasonLabel(row)}`;
}

/** The reports of `row`'s burst, oldest first: each within DEDUPE_WINDOW_MS of the next, ending at `row`. */
function burstEndingAt(rows: FanoutRow[], row: FanoutRow): FanoutRow[] {
	const end = rows.findIndex((r) => r.id === row.id);
	if (end < 0) return [row];
	let start = end;
	while (
		start > 0 &&
		rows[start].createdAt.getTime() - rows[start - 1].createdAt.getTime() <= DEDUPE_WINDOW_MS
	)
		start--;
	return rows.slice(start, end + 1);
}

/** Fan one saved report out. Never throws; returns what it did, for tests and logs. */
export async function fanOutReport(
	row: FanoutRow,
	deps: FanoutDeps = defaultDeps()
): Promise<{ skipped?: string; slack?: boolean; issue?: string | null; counted?: number }> {
	try {
		if (!deps.flagOn()) return { skipped: "flag-off" };
		const origin = deps.origin();
		if (!origin || (!deps.slack && !deps.linear)) {
			// Flag on with nothing to send to is a misconfiguration, so it warns every time.
			logger.warn(
				{ reportId: row.id, origin: !!origin, slack: !!deps.slack, linear: !!deps.linear },
				"[report-fanout] flag on but PUBLIC_ORIGIN or every sink is unset; report not fanned out"
			);
			return { skipped: "unconfigured" };
		}

		const since = new Date(row.createdAt.getTime() - BURST_LOOKBACK_MS);
		const recent = await deps.recentFromReporter(row, since).catch((e) => {
			logger.warn({ err: String(e), reportId: row.id }, "[report-fanout] dedupe lookup failed");
			return [row];
		});
		const burst = burstEndingAt(recent, row);
		const first = burst[0];

		if (first.id !== row.id) {
			const firstUrl = reportAnchorUrl(origin, first.id);
			const issue = deps.linear ? await deps.linear.findIssueByUrl(firstUrl) : null;
			if (!issue) {
				logger.info(
					{ reportId: row.id, firstReportId: first.id },
					"[report-fanout] repeat report but no issue for the first one yet; count not recorded"
				);
				return { counted: burst.length, issue: null };
			}
			await deps.linear!.comment(
				issue,
				`${burst.length} reports from this person, each within ${DEDUPE_WINDOW_MS / 60_000} minutes of the last. Latest: ${reasonLabel(row)}, ${reportAnchorUrl(origin, row.id)}`
			);
			return { counted: burst.length, issue };
		}

		const url = reportAnchorUrl(origin, row.id);
		const results = await Promise.allSettled([
			deps.slack?.(`New answer report (${reasonLabel(row)}): ${url}`),
			deps.linear?.createIssue({
				title: linearTitle(row),
				description: `Reason: ${reasonLabel(row)}\nModel: ${row.answerModel ?? "unknown"}\n\nThe report, with the answer it kept: ${url}`,
				url,
			}),
		]);
		const [slackRes, linearRes] = results;
		for (const r of results) {
			if (r.status === "rejected")
				logger.warn({ err: String(r.reason), reportId: row.id }, "[report-fanout] sink failed");
		}
		return {
			slack: !!deps.slack && slackRes.status === "fulfilled",
			issue: linearRes.status === "fulfilled" ? (linearRes.value ?? null) : null,
		};
	} catch (e) {
		logger.warn({ err: String(e), reportId: row.id }, "[report-fanout] failed");
		return { skipped: "error" };
	}
}

// ── Real sinks ──────────────────────────────────────────────────────────────────────────────────────

function defaultDeps(): FanoutDeps {
	const webhook = firstKey(["REPORT_SLACK_WEBHOOK"], "reportSlackWebhook", { allowEmpty: true });
	const linearKey = firstKey(["REPORT_LINEAR_API_KEY"], "reportLinearApiKey", { allowEmpty: true });
	const teamId = firstKey(["REPORT_LINEAR_TEAM_ID"], "reportLinearTeamId", { allowEmpty: true });
	return {
		flagOn: () => flagEnabledOr(REPORT_FANOUT_FLAG, () => false),
		origin: () => config.PUBLIC_ORIGIN || undefined,
		recentFromReporter,
		slack: webhook ? (text) => postSlackWebhook(webhook, text, { timeoutMs: 8_000 }) : null,
		linear: linearKey && teamId ? linearSink(linearKey, teamId) : null,
	};
}

async function recentFromReporter(row: FanoutRow, since: Date): Promise<FanoutRow[]> {
	const who = row.userId
		? eq(reports.userId, row.userId)
		: row.sessionId
			? eq(reports.sessionId, row.sessionId)
			: undefined;
	if (!who) return [row];
	// The newest 50, so the lookback can't push `row` itself past the limit; oldest first for the caller.
	const rows = await getDb()
		.select()
		.from(reports)
		.where(and(who, gte(reports.createdAt, since)))
		.orderBy(desc(reports.createdAt))
		.limit(50);
	return rows.reverse();
}

export function linearSink(
	apiKey: string,
	teamId: string,
	fetchImpl: typeof fetch = fetch
): LinearSink {
	async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const res = await fetchImpl(LINEAR_API, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: apiKey },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(8_000),
		});
		const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
		if (!res.ok || body.errors?.length || !body.data)
			throw new Error(`Linear ${res.status}: ${body.errors?.[0]?.message ?? "no data"}`);
		return body.data;
	}
	return {
		async createIssue({ title, description, url }) {
			const d = await gql<{ issueCreate: { issue: { id: string } | null } }>(
				`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }`,
				{ input: { teamId, title, description } }
			);
			const id = d.issueCreate.issue?.id ?? null;
			if (id)
				await gql(
					`mutation($issueId: String!, $url: String!) { attachmentLinkURL(issueId: $issueId, url: $url, title: "Report") { success } }`,
					{ issueId: id, url }
				);
			return id;
		},
		async findIssueByUrl(url) {
			const d = await gql<{ attachmentsForURL: { nodes: { issue: { id: string } }[] } }>(
				`query($url: String!) { attachmentsForURL(url: $url) { nodes { issue { id } } } }`,
				{ url }
			);
			return d.attachmentsForURL.nodes[0]?.issue.id ?? null;
		},
		async comment(issueId, body) {
			await gql(
				`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
				{ input: { issueId, body } }
			);
		},
	};
}
