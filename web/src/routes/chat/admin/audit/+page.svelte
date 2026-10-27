<script lang="ts">
	import { base } from "$lib/chat/paths";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

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
	const short = (s: string | null | undefined, n = 8) => (s ? s.slice(0, n) : "—");
</script>

<svelte:head><title>Audit log · admin</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8">
	<header class="mb-6 flex items-center justify-between gap-3">
		<h1 class="text-xl font-semibold">Audit log</h1>
		<a href="{base}/admin" class="text-sm text-gray-500 underline hover:text-gray-800">← Admin</a>
	</header>

	<p class="mb-4 text-sm text-gray-600">
		Admin-area actions (config changes, logins). Records who / what / when and a redacted summary —
		never secret values or full config payloads. IPs are stored hashed.
	</p>

	{#if data.entries.length === 0}
		<p class="text-sm text-gray-500">No admin actions recorded yet.</p>
	{:else}
		<p class="mb-3 text-sm text-gray-500">{data.entries.length} most recent</p>
		<div class="overflow-x-auto rounded-lg border">
			<table class="w-full border-collapse text-sm">
				<thead class="bg-gray-50 text-left text-gray-600">
					<tr>
						<th class="px-3 py-2 font-medium">When</th>
						<th class="px-3 py-2 font-medium">Actor</th>
						<th class="px-3 py-2 font-medium">Action</th>
						<th class="px-3 py-2 font-medium">Target</th>
						<th class="px-3 py-2 font-medium">Summary</th>
						<th class="px-3 py-2 font-medium">Source</th>
					</tr>
				</thead>
				<tbody>
					{#each data.entries as e (e.id)}
						<tr class="border-t align-top">
							<td class="px-3 py-2 whitespace-nowrap text-gray-500">{when(e.createdAt)}</td>
							<td class="px-3 py-2 whitespace-nowrap">{e.actor}</td>
							<td class="px-3 py-2 font-mono text-xs whitespace-nowrap">{e.action}</td>
							<td class="px-3 py-2 whitespace-nowrap text-gray-600">{e.target ?? "—"}</td>
							<td class="max-w-md px-3 py-2 text-gray-700">{e.summary ?? "—"}</td>
							<td
								class="px-3 py-2 font-mono text-xs whitespace-nowrap text-gray-400"
								title={e.ipHash ?? "no IP recorded"}
							>
								{short(e.ipHash)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
