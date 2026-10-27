<!-- Admin RAG console (session-admin), beside the tuning panel. -->
<script lang="ts">
	import { enhance } from "$app/forms";
	import { base } from "$lib/chat/paths";
	import type { SubmitFunction } from "@sveltejs/kit";
	import type { PageData, ActionData } from "./$types";
	import FileDropZone from "$lib/chat/components/rag/FileDropZone.svelte";
	import StaffSignIn from "$lib/chat/components/StaffSignIn.svelte";

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let busy = $state(false);
	let editingId = $state<string | null>(null);

	// Create-form fields are controlled so ingest-from-url can pre-fill them.
	let cTitle = $state("");
	let cText = $state("");
	let cSource = $state("");
	let cUrl = $state("");
	let cSourceType = $state("");
	let cSourceDate = $state("");

	// Ingest-from-url (fetch + extract → pre-fill the create form for review).
	let ingestUrlVal = $state("");
	let ingesting = $state(false);
	let ingestError = $state("");
	async function runIngest() {
		const u = ingestUrlVal.trim();
		if (!u) return;
		ingesting = true;
		ingestError = "";
		try {
			const res = await fetch(`${base}/admin/rag/ingest`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: u }),
			});
			if (!res.ok) {
				ingestError = (await res.text()) || `Ingest failed (${res.status}).`;
			} else {
				const d = (await res.json()) as { title: string; text: string; url: string };
				cTitle = d.title || cTitle;
				cText = d.text || cText;
				cUrl = d.url || cUrl;
				if (!cSource.trim()) {
					try {
						cSource = new URL(d.url).hostname;
					} catch {
						/* leave blank */
					}
				}
			}
		} catch {
			ingestError = "Ingest request failed.";
		} finally {
			ingesting = false;
		}
	}

	// Audit trail (fetched on demand per document).
	let auditFor = $state<string | null>(null);
	let auditLoading = $state(false);
	let auditRows = $state<
		Array<{
			action: string;
			byUser: string | null;
			at: string | null;
			fromStatus: string | null;
			toStatus: string | null;
		}>
	>([]);
	async function toggleAudit(id: string) {
		if (auditFor === id) {
			auditFor = null;
			return;
		}
		auditFor = id;
		auditLoading = true;
		auditRows = [];
		try {
			const res = await fetch(`${base}/admin/rag/audit?id=${encodeURIComponent(id)}`);
			if (res.ok) auditRows = (await res.json()).audit;
		} catch {
			/* leave empty */
		} finally {
			auditLoading = false;
		}
	}

	// Live preview (separate fetch endpoint — no navigation).
	let previewQuery = $state("");
	let previewing = $state(false);
	let previewError = $state("");
	let previewResult = $state<{
		minScore: number;
		hits: Array<{ title: string; snippet: string; score?: number; passes: boolean; url?: string }>;
	} | null>(null);

	async function runPreview() {
		const q = previewQuery.trim();
		if (!q) return;
		previewing = true;
		previewError = "";
		try {
			const res = await fetch(`${base}/admin/rag/preview`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: q }),
			});
			if (!res.ok) {
				previewError = (await res.text()) || `Preview failed (${res.status}).`;
				previewResult = null;
			} else {
				previewResult = await res.json();
			}
		} catch {
			previewError = "Preview request failed.";
			previewResult = null;
		} finally {
			previewing = false;
		}
	}

	const isoOf = (d: unknown): string => {
		if (!d) return "";
		const dt = new Date(d as string);
		return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
	};
	const ymd = (d: unknown): string => isoOf(d).slice(0, 10);

	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			await update();
			busy = false;
		};
	};

	const statusColor = (s: string) =>
		s === "active" ? "var(--ap-live)" : s === "retired" ? "var(--ap-gap)" : "var(--ap-building)";

	// Committed catalog (read-only), grouped by source for the collapsible panel. Source ids match
	// the build script: categories / exemplars / stack-map / project.
	const SOURCE_LABELS: Record<string, string> = {
		categories: "Gap-map categories",
		exemplars: "Exemplar repos",
		"stack-map": "Stack-map narrative",
		project: "Project context",
	};
	const catalogGroups = $derived.by(() => {
		// Grouping accumulator inside a $derived — the whole derivation re-runs, so mutation of this
		// local is never the reactivity signal.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const groups = new Map<string, typeof data.catalog.chunks>();
		for (const c of data.catalog.chunks) {
			const arr = groups.get(c.source) ?? [];
			arr.push(c);
			groups.set(c.source, arr);
		}
		return [...groups.entries()].map(([source, chunks]) => ({
			source,
			label: SOURCE_LABELS[source] ?? source,
			chunks,
		}));
	});
</script>

<svelte:head><title>RAG admin · AI Potluck</title></svelte:head>

<div class="mx-auto max-w-4xl px-4 py-8">
	{#if data.needsLogin}
		<div class="mx-auto mt-20 max-w-sm">
			<a href="{base}/admin" class="text-xs text-[var(--ap-ink-2)] hover:underline">← Admin</a>
			<h1 class="mt-1 mb-5 font-serif text-2xl">RAG admin</h1>
			<StaffSignIn signedIn={data.signedIn} />
		</div>
	{:else}
		<header class="mb-6">
			<div class="flex items-start justify-between gap-3">
				<a href="{base}/admin" class="text-xs text-[var(--ap-ink-2)] hover:underline">← Admin</a>
			</div>
			<h1 class="mt-1 font-serif text-2xl">RAG admin — community catalog</h1>
			<p class="mt-1 text-sm text-[var(--ap-ink-2)]">
				Author content for the public catalog RAG. Create a draft, preview what it retrieves, then
				activate it. Active chunks are served to chat turns
				{#if data.adminEnabled}
					<span style="color:var(--ap-live)">— the store is ENABLED.</span>
				{:else}
					<span style="color:var(--ap-building)"
						>— but the store is OFF (set <code>RAG_ADMIN_ENABLED=true</code> to serve them).</span
					>
				{/if}
			</p>
		</header>

		<!-- How-to: author + deploy a RAG document (collapsible, open by default). -->
		<details
			class="mb-6 rounded-lg border border-[var(--ap-rule)] bg-[var(--ap-rule)]/5 p-4 text-sm"
			open
		>
			<summary class="cursor-pointer font-semibold">How to add &amp; deploy a RAG document</summary>
			<ol class="mt-3 ml-4 list-decimal space-y-1.5 text-[var(--ap-ink-2)]">
				<li>
					<strong>Add content.</strong> Type or paste text into <em>New document</em>, fetch a
					public URL to pre-fill it, or <em>Upload files</em> (text, Markdown, CSV, JSON, PDF, DOCX,
					or images). Each item is split into chunks and embedded on save as an inactive
					<strong>draft</strong>.
				</li>
				<li>
					<strong>Preview.</strong> Use <em>Preview retrieval</em> to run a test query against
					<strong>active</strong> chunks and confirm what a chat turn would receive, and at what score.
				</li>
				<li>
					<strong>Activate to deploy.</strong> Click <em>Activate</em> on a draft to serve its
					chunks to live chat turns. <em>Retire</em> reverses it (chunks are kept, just hidden); activating
					again restores them.
				</li>
				<li>
					<strong>Edit &amp; refresh.</strong> <em>Edit</em> changes metadata (title, source, date)
					in place; to change body text, create a new document. After a global embedding-model
					change, use
					<em>Re-embed</em> to refresh a document's vectors.
				</li>
			</ol>
			<p class="mt-2 text-xs text-[var(--ap-ink-3)]">
				Serving is gated by <code>RAG_ADMIN_ENABLED</code>: while it's off you can author and
				preview, but activated chunks aren't sent to chat until it's on.
			</p>
		</details>

		{#if form?.error}
			<div
				class="mb-4 rounded border border-[var(--ap-gap)] bg-[var(--ap-gap)]/10 px-3 py-2 text-sm"
				role="alert"
			>
				{form.error}
			</div>
		{:else if form?.ok}
			<div
				class="mb-4 rounded border border-[var(--ap-live)] bg-[var(--ap-live)]/10 px-3 py-2 text-sm"
			>
				{form.action} succeeded.{#if form.warning}
					<span class="text-[var(--ap-building-text)]"> {form.warning}</span>{/if}
			</div>
		{/if}

		<!-- Live preview -->
		<section class="mb-8 rounded-lg border border-[var(--ap-rule)] p-4">
			<h2 class="mb-2 font-semibold">Preview retrieval</h2>
			<p class="mb-2 text-xs text-[var(--ap-ink-3)]">
				Ranks against the <strong>active</strong> chunks exactly as a chat turn would. Hits at or above
				the score threshold are what a turn receives.
			</p>
			<div class="flex gap-2">
				<input
					class="flex-1 rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1 text-sm"
					placeholder="Test query, e.g. open source inference servers"
					bind:value={previewQuery}
					onkeydown={(e) => e.key === "Enter" && runPreview()}
				/>
				<button
					class="rounded bg-[var(--ap-ink)] px-3 py-1 text-sm text-[var(--ap-paper)] disabled:opacity-50"
					onclick={runPreview}
					disabled={previewing || !previewQuery.trim()}>Run</button
				>
			</div>
			{#if previewError}
				<p class="mt-2 text-sm" style="color:var(--ap-gap)">{previewError}</p>
			{/if}
			{#if previewResult}
				<p class="mt-3 text-xs text-[var(--ap-ink-3)]">
					score threshold (RAG_MIN_SCORE): {previewResult.minScore.toFixed(3)} · {previewResult.hits
						.length} ranked
				</p>
				{#if previewResult.hits.length === 0}
					<p class="mt-1 text-sm text-[var(--ap-ink-2)]">No active chunks matched.</p>
				{:else}
					<ol class="mt-2 flex flex-col gap-1.5">
						{#each previewResult.hits as h, i (i)}
							<li class="flex gap-2 text-sm leading-snug">
								<span
									class="shrink-0 font-mono text-xs"
									style="color:{h.passes ? 'var(--ap-live)' : 'var(--ap-ink-3)'}"
									>{h.passes ? "✓" : "·"}
									{(h.score ?? 0).toFixed(3)}</span
								>
								<span class="min-w-0">
									<span class="font-medium">{h.title}</span>
									<span class="text-[var(--ap-ink-3)]"> — {h.snippet.slice(0, 120)}</span>
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			{/if}
		</section>

		<!-- Upload files (multimodal): drag-drop → each file becomes an inactive draft -->
		<section class="mb-8 rounded-lg border border-[var(--ap-rule)] p-4">
			<h2 class="mb-1 font-semibold">Upload files</h2>
			<p class="mb-3 text-xs text-[var(--ap-ink-3)]">
				Drop documents, datasets, or images. Each is parsed (images are described + OCR'd by a
				vision model), split into chunks, embedded, and saved as a draft for review.
			</p>
			<FileDropZone />
		</section>

		<!-- Create draft -->
		<section class="mb-8 rounded-lg border border-[var(--ap-rule)] p-4">
			<h2 class="mb-3 font-semibold">New document (draft)</h2>

			<!-- Ingest from URL: fetch + extract to pre-fill the fields for review. -->
			<div class="mb-3 rounded border border-dashed border-[var(--ap-rule)] p-2">
				<p class="mb-1 text-xs text-[var(--ap-ink-3)]">
					Optional: fetch a public page to pre-fill title + text (review before saving).
				</p>
				<div class="flex gap-2">
					<input
						class="flex-1 rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1 text-sm"
						placeholder="https://example.org/article"
						bind:value={ingestUrlVal}
						onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), runIngest())}
					/>
					<button
						type="button"
						class="rounded border border-[var(--ap-ink)] px-3 py-1 text-sm disabled:opacity-50"
						onclick={runIngest}
						disabled={ingesting || !ingestUrlVal.trim()}>{ingesting ? "Fetching…" : "Fetch"}</button
					>
				</div>
				{#if ingestError}
					<p class="mt-1 text-xs" style="color:var(--ap-gap)">{ingestError}</p>
				{/if}
			</div>

			<form method="POST" action="?/create" use:enhance={submit} class="flex flex-col gap-3">
				<div class="grid grid-cols-2 gap-3">
					<label class="text-sm">
						Title*
						<input
							name="title"
							required
							bind:value={cTitle}
							class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
						/>
					</label>
					<label class="text-sm">
						Source* (e.g. "EPFL News")
						<input
							name="source"
							required
							bind:value={cSource}
							class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
						/>
					</label>
					<label class="text-sm">
						Source URL
						<input
							name="url"
							type="url"
							placeholder="https://…"
							bind:value={cUrl}
							class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
						/>
					</label>
					<label class="text-sm">
						Source date*
						<input
							name="sourceDate"
							type="date"
							required
							bind:value={cSourceDate}
							class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
						/>
					</label>
					<label class="col-span-2 text-sm">
						Source type (e.g. article, dataset, note)
						<input
							name="sourceType"
							bind:value={cSourceType}
							class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
						/>
					</label>
				</div>
				<label class="text-sm">
					Text* (split into bounded chunks and embedded on save)
					<textarea
						name="text"
						required
						rows="6"
						bind:value={cText}
						class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1 font-mono text-xs"
					></textarea>
				</label>
				<div>
					<button
						class="rounded bg-[var(--ap-ink)] px-4 py-1.5 text-sm text-[var(--ap-paper)] disabled:opacity-50"
						disabled={busy}>Create draft</button
					>
				</div>
			</form>
		</section>

		<!-- Documents -->
		<section>
			<h2 class="mb-3 font-semibold">Documents ({data.documents.length})</h2>
			{#if data.documents.length === 0}
				<p class="text-sm text-[var(--ap-ink-2)]">No documents yet.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each data.documents as d (d.id)}
						<li class="rounded-lg border border-[var(--ap-rule)] p-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<div class="flex items-center gap-2">
										<span
											class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
											style="color:{statusColor(d.status)};border:1px solid {statusColor(d.status)}"
											>{d.status}</span
										>
										<span class="truncate font-medium">{d.title}</span>
									</div>
									<p class="mt-1 text-xs text-[var(--ap-ink-3)]">
										{d.source}{d.sourceDate ? ` · ${ymd(d.sourceDate)}` : ""} · {d.activeChunkCount}/{d.chunkCount}
										chunks active · v{d.version}
										{#if d.url}
											· <a href={d.url} target="_blank" rel="noreferrer" class="hover:underline"
												>source ↗</a
											>
										{/if}
									</p>
								</div>
								<div class="flex shrink-0 gap-1.5">
									<button
										type="button"
										class="rounded border border-[var(--ap-rule)] px-2 py-1 text-xs text-[var(--ap-ink-2)]"
										onclick={() => (editingId = editingId === d.id ? null : d.id)}
										>{editingId === d.id ? "Close" : "Edit"}</button
									>
									{#if d.status !== "active"}
										<form method="POST" action="?/activate" use:enhance={submit}>
											<input type="hidden" name="id" value={d.id} />
											<input type="hidden" name="expectedVersion" value={d.version} />
											<button
												class="rounded border border-[var(--ap-live)] px-2 py-1 text-xs"
												style="color:var(--ap-live)"
												disabled={busy || d.chunkCount === 0}
												title={d.chunkCount === 0 ? "No embedded chunks" : "Serve these chunks"}
												>Activate</button
											>
										</form>
									{/if}
									{#if d.status === "active"}
										<form method="POST" action="?/retire" use:enhance={submit}>
											<input type="hidden" name="id" value={d.id} />
											<input type="hidden" name="expectedVersion" value={d.version} />
											<button
												class="rounded border border-[var(--ap-gap)] px-2 py-1 text-xs"
												style="color:var(--ap-gap)"
												disabled={busy}>Retire</button
											>
										</form>
									{/if}
									{#if d.chunkCount > 0}
										<form method="POST" action="?/reembed" use:enhance={submit}>
											<input type="hidden" name="id" value={d.id} />
											<input type="hidden" name="expectedVersion" value={d.version} />
											<button
												class="rounded border border-[var(--ap-rule)] px-2 py-1 text-xs text-[var(--ap-ink-2)]"
												disabled={busy}
												title="Re-embed chunk texts with the current embedding model"
												>Re-embed</button
											>
										</form>
									{/if}
									<button
										type="button"
										class="rounded border border-[var(--ap-rule)] px-2 py-1 text-xs text-[var(--ap-ink-2)]"
										onclick={() => toggleAudit(d.id)}
										>{auditFor === d.id ? "Hide log" : "Log"}</button
									>
								</div>
							</div>

							{#if auditFor === d.id}
								<div class="mt-3 border-t border-[var(--ap-rule)] pt-2 text-xs">
									{#if auditLoading}
										<p class="text-[var(--ap-ink-3)]">Loading…</p>
									{:else if auditRows.length === 0}
										<p class="text-[var(--ap-ink-3)]">No audit entries.</p>
									{:else}
										<ol class="flex flex-col gap-1">
											{#each auditRows as a, i (i)}
												<li class="flex gap-2 text-[var(--ap-ink-2)]">
													<span class="font-mono text-[var(--ap-ink-3)]">{ymd(a.at)}</span>
													<span class="font-semibold">{a.action}</span>
													{#if a.fromStatus && a.toStatus && a.fromStatus !== a.toStatus}
														<span class="text-[var(--ap-ink-3)]">{a.fromStatus} → {a.toStatus}</span
														>
													{/if}
													{#if a.byUser}<span class="text-[var(--ap-ink-3)]"
															>by {a.byUser.slice(0, 8)}</span
														>{/if}
												</li>
											{/each}
										</ol>
									{/if}
								</div>
							{/if}

							{#if editingId === d.id}
								<!-- Metadata edit (not text — re-embedding is a separate path). OCC by version. -->
								<form
									method="POST"
									action="?/update"
									use:enhance={submit}
									class="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--ap-rule)] pt-3"
								>
									<input type="hidden" name="id" value={d.id} />
									<input type="hidden" name="expectedVersion" value={d.version} />
									<label class="text-xs"
										>Title*
										<input
											name="title"
											required
											value={d.title}
											class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
										/></label
									>
									<label class="text-xs"
										>Source*
										<input
											name="source"
											required
											value={d.source}
											class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
										/></label
									>
									<label class="text-xs"
										>Source URL
										<input
											name="url"
											type="url"
											value={d.url ?? ""}
											class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
										/></label
									>
									<label class="text-xs"
										>Source date*
										<input
											name="sourceDate"
											type="date"
											required
											value={ymd(d.sourceDate)}
											class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
										/></label
									>
									<label class="col-span-2 text-xs"
										>Source type
										<input
											name="sourceType"
											value={d.sourceType ?? ""}
											class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
										/></label
									>
									<div class="col-span-2">
										<button
											class="rounded bg-[var(--ap-ink)] px-3 py-1 text-xs text-[var(--ap-paper)] disabled:opacity-50"
											disabled={busy}>Save changes</button
										>
									</div>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Committed catalog (read-only): the baked-in Tier-A index — gap-map categories, exemplar
			     repos, the stack-map narrative, and the project blurb — built offline by
			     scripts/build-rag-index.mjs and served from a static import. Not editable here; shown so
			     the gap-map grounding is visible alongside the DB-backed documents above. -->
		<section class="mt-8">
			<details class="rounded-lg border border-[var(--ap-rule)] bg-[var(--ap-rule)]/5 p-4">
				<summary class="cursor-pointer font-semibold">
					Committed catalog — read-only ({data.catalog.chunks.length} chunks)
				</summary>
				<p class="mt-2 text-xs text-[var(--ap-ink-3)]">
					The baked-in Tier-A index that grounds every chat turn. Built offline by
					<code>scripts/build-rag-index.mjs</code> from <code>categories.json</code>,
					<code>exemplars.json</code>, and <code>stack-map.json</code>, then served from a static
					import — to change it, edit the source JSON and rebuild. It can't be edited here.
					{#if data.catalog.builtAt}
						<br />Embedded with <code>{data.catalog.model}</code> (dim {data.catalog.dim}), built
						{ymd(data.catalog.builtAt)} ·
						{#if data.catalog.served}
							<span style="color:var(--ap-live)">served</span>
						{:else}
							<span style="color:var(--ap-building)"
								>NOT served — embedding model changed since build; rebuild the index</span
							>
						{/if}
					{/if}
				</p>
				{#if data.catalog.chunks.length === 0}
					<p class="mt-3 text-sm text-[var(--ap-ink-2)]">
						No committed catalog index found (run <code>node scripts/build-rag-index.mjs</code>).
					</p>
				{:else}
					<div class="mt-3 flex flex-col gap-2">
						{#each catalogGroups as g (g.source)}
							<details class="rounded border border-[var(--ap-rule)] p-2">
								<summary class="cursor-pointer text-sm font-medium">
									{g.label} <span class="text-[var(--ap-ink-3)]">({g.chunks.length})</span>
								</summary>
								<ul class="mt-2 flex flex-col gap-2">
									{#each g.chunks as c (c.id)}
										<li class="text-sm leading-snug">
											<span class="font-medium">{c.title}</span>
											{#if c.url}
												· <a
													href={c.url}
													target="_blank"
													rel="noreferrer"
													class="text-xs hover:underline">source ↗</a
												>
											{/if}
											<span class="mt-0.5 block text-xs text-[var(--ap-ink-3)]"
												>{c.text.slice(0, 220)}{c.text.length > 220 ? "…" : ""}</span
											>
										</li>
									{/each}
								</ul>
							</details>
						{/each}
					</div>
				{/if}
			</details>
		</section>
	{/if}
</div>
