<script lang="ts">
	import { base } from "$lib/chat/paths";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	const KIND_LABEL: Record<string, string> = {
		child_safety: "Child safety",
		prompt_injection: "Prompt injection",
		content_policy: "Content policy",
		toxicity: "Toxicity",
	};
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

<svelte:head><title>Safety · admin</title></svelte:head>

<div class="mx-auto w-full max-w-3xl px-4 py-8">
	<header class="mb-6 flex items-center justify-between gap-3">
		<h1 class="text-xl font-semibold">Trust &amp; Safety</h1>
		<a href="{base}/admin" class="text-sm text-gray-500 underline hover:text-gray-800">← Admin</a>
	</header>

	<p class="mb-6 text-sm text-gray-600">
		Moderation activity from the Coop safety gate — separate from user-submitted
		<a href="{base}/admin/reports" class="underline">Reports</a>. Content / child-safety /
		prompt-injection screening runs through Coop; the authoritative violation and strike records
		live in Coop’s own dashboard.
	</p>

	<div class="space-y-4">
		<section class="rounded-lg border p-4">
			<h2 class="font-medium">Coop dashboard</h2>
			<p class="mt-1 text-sm text-gray-600">
				Full rule-violation and strike history for the moderation gate.
			</p>
			{#if data.coopDashboardUrl}
				<a
					href={data.coopDashboardUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="mt-3 inline-block rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white"
				>
					Open Coop dashboard ↗
				</a>
			{:else}
				<p class="mt-3 text-sm text-amber-700">
					Set <code class="font-mono">COOP_DASHBOARD_URL</code> to link Coop’s dashboard here.
				</p>
			{/if}
		</section>

		<section class="rounded-lg border p-4">
			<div class="flex items-center justify-between gap-2">
				<h2 class="font-medium">Declined turns (in-app)</h2>
				<span class="text-xs text-gray-500">{data.declines.length} most recent</span>
			</div>
			<p class="mt-1 text-sm text-gray-600">
				Turns this app’s moderation gate declined. Verdict metadata only — the user’s text is never
				stored here.
			</p>
			{#if !data.moderationConfigured}
				<p class="mt-2 text-xs text-amber-700">
					Note: the in-app moderation gate isn’t configured on this deployment (COOP_URL /
					COOP_API_KEY unset), so no turns are being screened.
				</p>
			{/if}

			{#if data.declines.length === 0}
				<p class="mt-3 text-sm text-gray-500">No declined turns recorded.</p>
			{:else}
				<div class="mt-3 overflow-x-auto rounded border">
					<table class="w-full border-collapse text-sm">
						<thead class="bg-gray-50 text-left text-gray-600">
							<tr>
								<th class="px-3 py-2 font-medium">When</th>
								<th class="px-3 py-2 font-medium">Gate</th>
								<th class="px-3 py-2 font-medium">Label</th>
								<th class="px-3 py-2 font-medium">Score</th>
								<th class="px-3 py-2 font-medium">Conversation</th>
								<th class="px-3 py-2 font-medium">Session</th>
							</tr>
						</thead>
						<tbody>
							{#each data.declines as d (d.id)}
								<tr class="border-t align-top">
									<td class="px-3 py-2 whitespace-nowrap text-gray-500">{when(d.createdAt)}</td>
									<td class="px-3 py-2 whitespace-nowrap">{KIND_LABEL[d.kind] ?? d.kind}</td>
									<td class="px-3 py-2 text-gray-700">{d.label ?? "—"}</td>
									<td class="px-3 py-2 whitespace-nowrap text-gray-500">
										{d.score == null ? "—" : d.score.toFixed(2)}
									</td>
									<td class="px-3 py-2 whitespace-nowrap">
										{#if d.conversationId}
											<a
												href="{base}/conversation/{d.conversationId}"
												class="font-mono text-xs text-[var(--ap-ink,#2563eb)] underline"
												title={d.messageId ? `message ${d.messageId}` : "conversation"}
											>
												{short(d.conversationId)}…
											</a>
										{:else}
											<span class="text-xs text-gray-400">—</span>
										{/if}
									</td>
									<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-gray-400">
										{short(d.sessionId ?? d.userId)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	</div>
</div>
