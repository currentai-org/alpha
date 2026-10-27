<script lang="ts">
	import { base } from "$lib/chat/paths";
	import type { PageData } from "./$types";
	import StaffSignIn from "$lib/chat/components/StaffSignIn.svelte";

	let { data }: { data: PageData } = $props();

	// The admin panels this portal links to. All share the one admin login (shared cookie), so a
	// signed-in operator reaches every panel without a second sign-in.
	const panels = [
		{
			href: `${base}/admin/journeys`,
			title: "Journeys",
			desc: "Recorded walkthroughs of the documented user journeys, with the grader’s verdict on each and the reply-language matrix.",
		},
		{
			href: `${base}/admin/reports`,
			title: "Reports",
			desc: "User-submitted reports — per-answer flags and the general “report a problem” channel.",
		},
		{
			href: `${base}/admin/safety`,
			title: "Safety",
			desc: "Trust & safety — turns declined by the Coop moderation gate, plus a link to Coop’s dashboard.",
		},
		{
			href: `${base}/admin/rag`,
			title: "RAG console",
			desc: "Knowledge base — ingest, audit, preview, and upload documents for retrieval grounding.",
		},
		{
			href: `${base}/admin/tuning`,
			title: "Tuning",
			desc: "Persona, decoding, grounding, and starter prompts — live edits without a deploy.",
		},
		{
			href: `${base}/admin/audit`,
			title: "Audit log",
			desc: "Admin actions — config changes and logins, with who / what / when for review.",
		},
	];
</script>

<svelte:head><title>Admin · AI Potluck</title></svelte:head>

<div class="mx-auto w-full max-w-3xl px-4 py-8">
	<header class="mb-6 flex items-center justify-between gap-3">
		<h1 class="text-xl font-semibold">Admin</h1>
	</header>

	{#if data.needsLogin}
		<StaffSignIn signedIn={data.signedIn} />
	{:else}
		<div class="grid gap-3 sm:grid-cols-2">
			{#each panels as p (p.href)}
				<a
					href={p.href}
					class="group rounded-lg border p-4 transition-colors hover:border-gray-400 hover:bg-gray-50"
				>
					<h2 class="font-medium group-hover:underline">{p.title}</h2>
					<p class="mt-1 text-sm text-gray-600">{p.desc}</p>
				</a>
			{/each}
		</div>

		<p class="mt-6 text-xs text-gray-400">
			Conversation export is an API endpoint (<code class="font-mono">POST {base}/admin/export</code
			>, Bearer-authenticated), not a panel.
		</p>
	{/if}
</div>
