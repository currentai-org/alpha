<script lang="ts">
	import { base } from "$lib/chat/paths";
	import { ANSWER_REPORT_REASONS, GENERAL_REPORT_CATEGORIES, REPORT_STATUSES } from "$lib/chat/reportReasons";
	import type { PageData, ActionData } from "./$types";
	import StaffSignIn from "$lib/chat/components/StaffSignIn.svelte";

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const REASON_LABEL: Record<string, string> = Object.fromEntries(
		ANSWER_REPORT_REASONS.map((r) => [r.key, r.label])
	);
	const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
		GENERAL_REPORT_CATEGORIES.map((c) => [c.key, c.label])
	);

	function when(ts: string | Date): string {
		const d = typeof ts === "string" ? new Date(ts) : ts;
		return d.toLocaleString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	const short = (s: string | null | undefined, n = 10) => (s ? s.slice(0, n) : "—");
</script>

<svelte:head><title>Reports · admin</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8">
	<header class="mb-6 flex items-center justify-between gap-3">
		<h1 class="text-xl font-semibold">Reports</h1>
	</header>

	{#if data.needsLogin}
		<StaffSignIn signedIn={data.signedIn} />
	{:else if data.reports.length === 0}
		<p class="text-sm text-gray-500">No reports yet.</p>
	{:else}
		<p class="mb-3 text-sm text-gray-500">{data.reports.length} most recent</p>
		{#if form?.statusError}<p class="mb-3 text-small text-caution-text">{form.statusError}</p>{/if}
		<div class="overflow-x-auto rounded-lg border">
			<table class="w-full border-collapse text-sm">
				<thead class="bg-gray-50 text-left text-gray-600">
					<tr>
						<th class="px-3 py-2 font-medium">When</th>
						<th class="px-3 py-2 font-medium">Channel</th>
						<th class="px-3 py-2 font-medium">Type</th>
						<th class="px-3 py-2 font-medium">Detail</th>
						<th class="px-3 py-2 font-medium">Answer reported</th>
						<th class="px-3 py-2 font-medium">Conversation</th>
						<th class="px-3 py-2 font-medium">Session</th>
						<th class="px-3 py-2 font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					{#each data.reports as r (r.id)}
						<tr id="report-{r.id}" class="border-t align-top">
							<td class="px-3 py-2 whitespace-nowrap text-gray-500">{when(r.createdAt)}</td>
							<td class="px-3 py-2 text-xs whitespace-nowrap text-gray-500">
								{r.reason ? "Answer" : "General"}
							</td>
							<td class="px-3 py-2">
								{r.reason
									? (REASON_LABEL[r.reason] ?? r.reason)
									: (CATEGORY_LABEL[r.category ?? ""] ?? r.category ?? "—")}
							</td>
							<td class="max-w-xs px-3 py-2 text-gray-700">{r.detail ?? "—"}</td>
							<!-- CUR-997: the answer as it read when reported. It outlives a deleted conversation,
							     so this is the only place a retained report still says what was wrong. -->
							<td class="max-w-md px-3 py-2 text-fg-2">
								{#if r.answerText}
									<p class="line-clamp-4 whitespace-pre-wrap" title={r.answerText}>{r.answerText}</p>
									{#if r.answerModel}
										<p class="mt-1 font-mono text-micro text-fg-3">{r.answerModel}</p>
									{/if}
								{:else}
									<span class="text-micro text-fg-3">—</span>
								{/if}
							</td>
							<td class="px-3 py-2 whitespace-nowrap">
								{#if r.conversationId}
									<a
										href="{base}/admin/reports/{r.conversationId}{r.messageId
											? `?messageId=${r.messageId}`
											: ''}"
										class="font-mono text-xs text-[var(--ap-ink,#2563eb)] underline"
										title={r.messageId ? `message ${r.messageId}` : "whole conversation"}
									>
										{short(r.conversationId)}…
									</a>
								{:else}
									<span class="text-xs text-gray-400">—</span>
								{/if}
							</td>
							<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-gray-400">
								{short(r.sessionId ?? r.userId)}
							</td>
							<!-- CUR-3903: the reporter sees this on their own reports page. -->
							<td class="px-3 py-2 whitespace-nowrap">
								<form method="POST" action="?/setStatus" class="flex items-center gap-2">
									<input type="hidden" name="id" value={r.id} />
									<select
										name="status"
										aria-label="Status of this report"
										class="rounded-field border border-line-2 bg-surface-2 px-2 py-1 text-micro"
									>
										{#each REPORT_STATUSES as s (s.key)}
											<option value={s.key} selected={s.key === r.status}>{s.label}</option>
										{/each}
									</select>
									<button class="text-micro underline">Save</button>
									{#if form?.statusSet === r.id}<span class="text-micro text-fg-3">Saved</span>{/if}
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
