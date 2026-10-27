<script lang="ts">
	import { ANSWER_REPORT_REASONS, GENERAL_REPORT_CATEGORIES, REPORT_STATUSES } from "$lib/chat/reportReasons";
	import type { PageData } from "./$types";

	// Settings → Your reports (CUR-3903). Each row is one report this visitor sent: what it was about,
	// the words they wrote, and what the team decided. Nothing here promises a reply; the status is
	// the answer, and it only changes when someone on the team sets it.
	let { data }: { data: PageData } = $props();

	const label = (list: readonly { key: string; label: string }[], key: string | null) =>
		list.find((x) => x.key === key)?.label ?? key ?? "";

	// The report dialog appends its technical-context block after an em-dash line; the visitor wrote
	// only what comes before it.
	const ownWords = (detail: string | null) => (detail ?? "").split("\n\n—\n")[0].trim();

	const when = (ts: string | Date) =>
		new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
</script>

<div class="flex flex-col gap-4">
	<p class="type-body text-fg-2">
		Reports you sent from under an answer or from “Report a problem”, newest first, with what the team
		decided about each one.
	</p>
	{#if data.reports.length === 0}
		<p class="type-body text-fg-3" data-own-reports-empty>
			You haven’t sent any reports from this {data.signedIn ? "account" : "browser"} yet.
		</p>
	{:else}
		<ul class="flex flex-col gap-3" aria-label="Your reports">
			{#each data.reports as r (r.id)}
				<li class="flex flex-col gap-1 border border-line-2 p-3 rounded-card" data-own-report={r.id}>
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<span class="type-label text-fg-1">
							{r.reason ? label(ANSWER_REPORT_REASONS, r.reason) : label(GENERAL_REPORT_CATEGORIES, r.category)}
						</span>
						<span class="type-caption text-fg-2" data-own-report-status={r.status}>
							{label(REPORT_STATUSES, r.status)}
						</span>
					</div>
					{#if ownWords(r.detail)}
						<p class="type-body text-fg-2 whitespace-pre-wrap">{ownWords(r.detail)}</p>
					{/if}
					<p class="type-caption text-fg-3">
						{r.reason ? "About an answer" : "About the chat"} · sent {when(r.createdAt)}{#if r.statusUpdatedAt}
							· updated {when(r.statusUpdatedAt)}{/if}
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</div>
