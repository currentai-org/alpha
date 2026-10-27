/**
 * The reasons a person can give for reporting one answer, in the order the report menu shows them.
 * The menu, the report route's validation, the `reports.reason` column and the admin reports page
 * all read this one list, so a new reason cannot reach one of them and miss another.
 *
 * `refused` and `language` came in with CUR-997. Language reports are the ones the language-gap
 * work (CUR-394, CUR-395) routes on to data collectors and model builders.
 *
 * Kept free of `$lib` aliases: `db/schema.ts` imports it, and that file loads under plain Node.
 */
export const ANSWER_REPORT_REASONS = [
	{ key: "harmful", label: "Harmful or unsafe" },
	{ key: "inaccurate", label: "Inaccurate or misleading" },
	{ key: "refused", label: "It refused to answer" },
	{ key: "language", label: "It didn't work in my language" },
	{ key: "privacy", label: "Privacy or copyright" },
	{ key: "other", label: "Something else" },
] as const;

export type AnswerReportReason = (typeof ANSWER_REPORT_REASONS)[number]["key"];

export const ANSWER_REPORT_REASON_KEYS = ANSWER_REPORT_REASONS.map((r) => r.key) as [
	AnswerReportReason,
	...AnswerReportReason[],
];

/**
 * The kinds of problem the general "Report a problem" dialog offers, in its order. The dialog, the
 * admin reports page and the reporter's own reports page all label a category from here.
 */
export const GENERAL_REPORT_CATEGORIES = [
	{ key: "bug", label: "Something’s broken" },
	{ key: "ux", label: "Confusing or hard to use" },
	{ key: "content", label: "Problem with answers" },
	{ key: "other", label: "Something else" },
] as const;

/**
 * What staff decided about a report (CUR-3903). Set on the admin reports page, shown back to the
 * person who sent it on their own reports page, with the same label in both places.
 */
export const REPORT_STATUSES = [
	{ key: "received", label: "Received" },
	{ key: "looking", label: "Being looked at" },
	{ key: "addressed", label: "Addressed" },
	{ key: "wont_fix", label: "Won't change" },
	{ key: "duplicate", label: "Already reported" },
] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number]["key"];

export const REPORT_STATUS_KEYS = REPORT_STATUSES.map((s) => s.key) as [ReportStatus, ...ReportStatus[]];
