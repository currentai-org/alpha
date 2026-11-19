<script lang="ts">
	import type { AnswerReportReason, ReportStatus } from "$lib/chat/reportReasons";
	import { m } from "$lib/paraglide/messages.js";
	import { getLocale } from "$lib/paraglide/runtime.js";
	import type { PageData } from "./$types";

	// Settings → Your reports. Each row is one report this visitor sent: what it was about,
	// the words they wrote, and what the team decided. Nothing here promises a reply; the status is
	// the answer, and it only changes when someone on the team sets it.
	let { data }: { data: PageData } = $props();

	// reportReasons.ts keeps the English labels for the server and the admin page; the reporter reads
	// their own language. An unknown key (a label added there first) falls back to the key itself.
	const REASON: Record<AnswerReportReason, () => string> = {
		harmful: () => m.message_reportHarmful(),
		inaccurate: () => m.message_reportInaccurate(),
		refused: () => m.message_reportRefused(),
		language: () => m.message_reportLanguage(),
		privacy: () => m.message_reportPrivacy(),
		other: () => m.message_reportOther(),
	};
	const CATEGORY: Record<string, () => string> = {
		bug: () => m.report_bugLabel(),
		ux: () => m.report_uxLabel(),
		content: () => m.report_contentLabel(),
		other: () => m.report_otherLabel(),
	};
	const STATUS: Record<ReportStatus, () => string> = {
		received: () => m.reports_statusReceived(),
		looking: () => m.reports_statusLooking(),
		addressed: () => m.reports_statusAddressed(),
		wont_fix: () => m.reports_statusWontFix(),
		duplicate: () => m.reports_statusDuplicate(),
	};
	const label = (map: Record<string, () => string>, key: string | null) =>
		(key && map[key]?.()) || key || "";

	// The report dialog appends its technical-context block after an em-dash line; the visitor wrote
	// only what comes before it.
	const ownWords = (detail: string | null) => (detail ?? "").split("\n\n—\n")[0].trim();

	const when = (ts: string | Date) =>
		new Date(ts).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" });
</script>

<div class="flex flex-col gap-4">
	<p class="type-body text-fg-2">
		{m.reports_intro()}
	</p>
	{#if data.reports.length === 0}
		<p class="type-body text-fg-3" data-own-reports-empty>
			{data.signedIn ? m.reports_emptyAccount() : m.reports_emptyBrowser()}
		</p>
	{:else}
		<ul class="flex flex-col gap-3" aria-label={m.product_yourReports()}>
			{#each data.reports as r (r.id)}
				<li class="flex flex-col gap-1 border border-line-2 p-3 rounded-card" data-own-report={r.id}>
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<span class="type-label text-fg-1">
							{r.reason ? label(REASON, r.reason) : label(CATEGORY, r.category)}
						</span>
						<span class="type-caption text-fg-2" data-own-report-status={r.status}>
							{label(STATUS, r.status)}
						</span>
					</div>
					{#if ownWords(r.detail)}
						<p class="type-body text-fg-2 whitespace-pre-wrap">{ownWords(r.detail)}</p>
					{/if}
					<p class="type-caption text-fg-3">
						{m.reports_metaSent({
							about: r.reason ? m.reports_aboutAnswer() : m.reports_aboutChat(),
							date: when(r.createdAt),
						})}{#if r.statusUpdatedAt}
							· {m.reports_metaUpdated({ date: when(r.statusUpdatedAt) })}{/if}
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</div>
