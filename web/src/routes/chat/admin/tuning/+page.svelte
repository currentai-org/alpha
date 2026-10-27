<!-- Admin tuning panel (session-admin): overrides of the persona, grounding and decoding, stored in the
     database over the code defaults ($lib/chat/server/tuning.ts). -->
<script lang="ts">
	import { enhance } from "$app/forms";
	import { base } from "$lib/chat/paths";
	import type { PageData, ActionData } from "./$types";

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let saving = $state(false);
	let confirmingReset = $state(false);

	const cur = $derived(data.current);
	const def = $derived(data.defaults);

	// Controlled values for the prompt fields so "Reset to default" (= clear → use the
	// built-in default) is one click. Initialized ONCE from the loaded overrides — they
	// shouldn't re-sync on save (the editor keeps their in-progress text).
	// svelte-ignore state_referenced_locally
	let persona = $state(data.current.persona ?? "");
	// svelte-ignore state_referenced_locally
	let grounding = $state(data.current.grounding ?? "");
	// svelte-ignore state_referenced_locally
	let starters = $state(data.current.starters?.join("\n") ?? "");
	// svelte-ignore state_referenced_locally
	let panelistPrompt = $state(data.current.panelistPrompt ?? "");
	// svelte-ignore state_referenced_locally
	let aggregatorPrompt = $state(data.current.aggregatorPrompt ?? "");
	// svelte-ignore state_referenced_locally
	let searchClassifierPrompt = $state(data.current.searchClassifierPrompt ?? "");

	// Optimistic-concurrency token: the editedAt this editor's in-progress text is based on. Like the
	// textareas it's set ONCE at load and advances ONLY on a successful save — NOT on a conflict
	// reload (where the server's editedAt jumps to the other editor's save). Submitted as a hidden
	// field; the server rejects the write if the stored row no longer matches it.
	// svelte-ignore state_referenced_locally
	let baseEditedAt = $state(data.current.editedAt ?? "");

	// Decoding bound to state (not uncontrolled) so "Load into editor" can restore it too. Inputs
	// keep their name= so the values still submit with the form. "" = use that field's code default.
	// svelte-ignore state_referenced_locally
	let decoding = $state({
		temperature: data.current.decoding?.temperature ?? "",
		frequency_penalty: data.current.decoding?.frequency_penalty ?? "",
		presence_penalty: data.current.decoding?.presence_penalty ?? "",
		max_tokens: data.current.decoding?.max_tokens ?? "",
	});

	// Recovery: pull a prior version (from the version-history backup) back INTO the editor so it can
	// be reviewed and re-Saved (which goes through the concurrency guard). Doesn't auto-save.
	function loadIntoEditor(snap: NonNullable<typeof data.current.history>[number]) {
		persona = snap.persona ?? "";
		grounding = snap.grounding ?? "";
		starters = (snap.starters ?? []).join("\n");
		panelistPrompt = snap.panelistPrompt ?? "";
		aggregatorPrompt = snap.aggregatorPrompt ?? "";
		searchClassifierPrompt = snap.searchClassifierPrompt ?? "";
		decoding = {
			temperature: snap.decoding?.temperature ?? "",
			frequency_penalty: snap.decoding?.frequency_penalty ?? "",
			presence_penalty: snap.decoding?.presence_penalty ?? "",
			max_tokens: snap.decoding?.max_tokens ?? "",
		};
	}

	// Manual off-DB backup: download the current saved tuning (incl. history) as JSON.
	function exportJson() {
		const blob = new Blob([JSON.stringify(data.current, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `tuning-backup-${(data.current.editedAt ?? "current").replace(/[:.]/g, "-")}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	const fmtWhen = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "unknown");

	// "Try it" — run a query against the UNSAVED draft persona (no save, no tab-switch).
	let testQuery = $state("");
	let testAnswer = $state("");
	let testSystem = $state("");
	let testing = $state(false);
	let testError = $state("");
	async function runTest() {
		testing = true;
		testError = "";
		testAnswer = "";
		try {
			const r = await fetch(`${base}/admin/tuning/try`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: testQuery, persona }),
			});
			const d = await r.json();
			if (!r.ok) testError = d.message ?? d.error ?? `error ${r.status}`;
			else {
				testAnswer = d.answer;
				testSystem = d.system;
			}
		} catch (e) {
			testError = e instanceof Error ? e.message : "request failed";
		}
		testing = false;
	}

	// "Run mini-eval" — a fast per-axis pass/fail canary of the UNSAVED draft persona against
	// the evals/mini slice (deterministic, no LLM-judge). A signal, not the gate — gate real
	// decisions on the full N=280 suite. The server runs the slice + the shared graders.
	type MiniItem = {
		id: string;
		axis: string;
		title: string;
		checks: string;
		pass: boolean;
		caved: boolean;
		detail: string;
	};
	type MiniScoreboard = {
		total: { pass: number; n: number };
		byAxis: Record<string, { pass: number; n: number }>;
		caved: number;
	};
	let evalRunning = $state(false);
	let evalError = $state("");
	let evalBoard = $state<MiniScoreboard | null>(null);
	let evalItems = $state<MiniItem[]>([]);
	async function runMiniEval() {
		evalRunning = true;
		evalError = "";
		evalBoard = null;
		evalItems = [];
		try {
			const r = await fetch(`${base}/admin/tuning/mini-eval`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ persona }),
			});
			const d = await r.json();
			if (!r.ok) evalError = d.message ?? d.error ?? `error ${r.status}`;
			else {
				evalBoard = d.scoreboard;
				evalItems = d.items;
			}
		} catch (e) {
			evalError = e instanceof Error ? e.message : "request failed";
		}
		evalRunning = false;
	}
</script>

<svelte:head><title>Gap Chat · tuning</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 px-4 py-8 text-sm">
	<header class="space-y-1">
		<a href="{base}/admin" class="text-xs text-gray-500 hover:underline">← Admin</a>
		<h1 class="text-xl font-semibold">Gap Chat — tuning</h1>
		<p class="text-gray-600">
			Edit the prompts and parameters live. Changes apply to new chats within ~20 seconds — no
			deploy. <strong>Leave a field blank to use the built-in default.</strong>
		</p>
		<p class="rounded bg-blue-50 px-3 py-2 text-xs text-blue-900">
			Your tuning is safe: it's saved in the database, so a code deploy never overwrites it, and
			every save keeps a backup in <em>Version history</em> below. Two editors can't clobber each
			other (you'll get a heads-up if someone else saved first). A blank field auto-tracks the
			latest built-in default, so it picks up improvements we ship;
			<em>Load default into editor</em> copies the current default in so you can tweak from it.
		</p>
		{#if cur.editedBy}
			<p class="text-xs text-gray-500">
				Last edited by {cur.editedBy} · {cur.editedAt?.replace("T", " ").slice(0, 16)} UTC
			</p>
		{/if}
		{#if form?.conflict}
			<p role="alert" class="rounded bg-red-100 px-3 py-2 text-red-800">
				<strong>Not saved.</strong>
				{form.conflictBy} changed the panel{form.conflictAt
					? ` at ${form.conflictAt.replace("T", " ").slice(0, 16)} UTC`
					: ""}, so saving now would overwrite their edits. Reload to see their changes, then
				re-apply yours. (Reloading discards your unsaved edits — copy anything you want to keep
				first.)
			</p>
		{:else if form?.error}
			<p role="alert" class="rounded bg-red-100 px-3 py-2 text-red-800">Error: {form.error}</p>
		{:else if form?.saved && form.warnings?.length}
			<p role="status" aria-live="polite" class="rounded bg-yellow-100 px-3 py-2 text-yellow-900">
				Saved. Heads up — your prompt no longer mentions: <strong>{form.warnings.join(", ")}</strong
				>. If that's intentional, all good; if not, use “Reset to default”.
			</p>
		{:else if form?.saved}
			<p role="status" aria-live="polite" class="rounded bg-green-100 px-3 py-2 text-green-800">
				Saved.
			</p>
		{:else if form?.reset}
			<p role="status" aria-live="polite" class="rounded bg-green-100 px-3 py-2 text-green-800">
				Reset — all overrides and history cleared; the chat now uses the built-in code defaults.
			</p>
		{/if}
		{#if form?.saved && form.rotationWarning}
			<p role="status" aria-live="polite" class="rounded bg-yellow-100 px-3 py-2 text-yellow-900">
				{form.rotationWarning}
			</p>
		{/if}
	</header>

	<!-- Try the unsaved draft persona without saving-to-prod or switching to the chat. -->
	<section class="space-y-2 rounded border border-dashed border-gray-300 p-3">
		<span class="font-medium"
			>Try it
			<span class="text-xs font-normal text-gray-500"
				>— runs your unsaved persona above, default decoding; nothing is saved</span
			></span
		>
		<textarea
			bind:value={testQuery}
			aria-label="Test query"
			rows="2"
			placeholder="Type a user message to test the current draft persona…"
			class="w-full rounded border p-2 text-xs"
		></textarea>
		<button
			type="button"
			onclick={runTest}
			disabled={testing || !testQuery.trim()}
			class="rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-50"
		>
			{testing ? "Running…" : "Run"}
		</button>
		{#if testError}
			<p role="alert" class="rounded bg-red-100 px-3 py-2 text-xs text-red-800">{testError}</p>
		{/if}
		{#if testAnswer}
			<div
				role="status"
				aria-live="polite"
				class="rounded bg-gray-50 p-2 text-xs whitespace-pre-wrap"
			>
				{testAnswer}
			</div>
			<details class="text-xs text-gray-500">
				<summary class="cursor-pointer">Show the assembled system prompt sent to the model</summary>
				<pre class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{testSystem}</pre>
			</details>
		{/if}
	</section>

	<!-- Run the mini-eval slice (evals/mini) against the UNSAVED draft persona: a fast per-axis
	     canary before saving-to-prod. Deterministic (temp 0), no LLM-judge; a signal, not the gate. -->
	<section class="space-y-2 rounded border border-dashed border-gray-300 p-3">
		<span class="font-medium"
			>Mini-eval
			<span class="text-xs font-normal text-gray-500"
				>— per-axis pass/fail on your unsaved persona above (10 items · ~13 calls · temp 0). A
				canary, not the gate.</span
			></span
		>
		<p class="text-xs text-gray-500">
			Each row checks one persona behavior. <strong>Green ✓</strong> = the persona handled it,
			<strong>red ✗</strong> = it slipped. The “sycophancy” rows ask a question, push back with “Are you
			sure?”, and check the model kept its correct answer instead of folding; the rest ask one question
			and check the wording. A quick smoke test — for a real number, run the full suite.
		</p>
		<button
			type="button"
			onclick={runMiniEval}
			disabled={evalRunning}
			class="rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-50"
		>
			{evalRunning ? "Running… (up to ~30s)" : "Run mini-eval"}
		</button>
		{#if evalError}
			<p role="alert" class="rounded bg-red-100 px-3 py-2 text-xs text-red-800">{evalError}</p>
		{/if}
		{#if evalBoard}
			<div role="status" aria-live="polite" class="space-y-2 text-xs">
				<div class="flex flex-wrap items-center gap-2">
					<span class="rounded bg-gray-900 px-2 py-1 font-medium text-white"
						>{evalBoard.total.pass}/{evalBoard.total.n} pass</span
					>
					{#each Object.entries(evalBoard.byAxis) as [axis, s] (axis)}
						<span
							class="rounded px-2 py-1 {s.pass === s.n
								? 'bg-green-100 text-green-800'
								: 'bg-yellow-100 text-yellow-900'}">{axis} {s.pass}/{s.n}</span
						>
					{/each}
					<span
						class="rounded px-2 py-1 {evalBoard.caved === 0
							? 'bg-green-100 text-green-800'
							: 'bg-red-100 text-red-800'}">caved {evalBoard.caved}</span
					>
				</div>
				<ul class="space-y-1">
					{#each evalItems as it (it.id)}
						<li class="flex items-start gap-2 rounded border p-1.5">
							<span class="shrink-0 font-mono {it.pass ? 'text-green-700' : 'text-red-700'}"
								>{it.pass ? "✓" : "✗"}</span
							>
							<div class="min-w-0">
								<div class="font-medium text-gray-800">
									{it.title || it.id}
									{#if it.caved}<span class="text-red-600">· folded</span>{/if}
								</div>
								{#if it.checks}<div class="text-gray-500">{it.checks}</div>{/if}
								<div class="truncate text-gray-400">{it.axis} · {it.detail}</div>
							</div>
						</li>
					{/each}
				</ul>
				<p class="text-gray-500">
					Regex graders catch gross violations (claims “GPT-4”, opens with “I'd be happy to”) but
					can miss subtle ones; 3 sycophancy items is a signal, not a statistic. For a real number,
					run the full N=280 suite.
				</p>
			</div>
		{/if}
	</section>

	<form
		method="POST"
		action="?/save"
		class="space-y-6"
		use:enhance={() => {
			saving = true;
			return async ({ result, update }) => {
				// Advance the concurrency token ONLY on a successful save — the editor's text is now
				// based on this new version. On a conflict (or error) leave it, so a re-submit without
				// reloading still trips the guard instead of clobbering the other editor.
				if (
					result.type === "success" &&
					result.data?.saved &&
					typeof result.data.editedAt === "string"
				) {
					baseEditedAt = result.data.editedAt;
				}
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		<input type="hidden" name="expectedEditedAt" value={baseEditedAt} />
		<div class="space-y-1">
			<div class="flex items-baseline justify-between">
				<span class="font-medium">System persona</span>
				<span class="flex gap-3">
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline"
						title="Copy the current shipped default into the editor so you can tweak from it (picks up the latest improvements). You're not overriding until you Save."
						onclick={() => (persona = def.persona)}>Load default into editor</button
					>
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline disabled:opacity-40"
						disabled={!persona}
						onclick={() => (persona = "")}>Reset to default</button
					>
				</span>
			</div>
			<span class="block text-xs text-gray-500"
				>Use tokens <code>{"{model}"}</code> <code>{"{maker}"}</code> <code>{"{served}"}</code>
				<code>{"{training}"}</code> for the identity — they're auto-filled from the live served model,
				so the model name stays correct if we swap models. (Don't hardcode a model name.) Prefer
				<code>{"{trainingParen}"}</code> (a parenthetical, blank when there's no openness story to
				tell) over embedding <code>{"{training}"}</code> directly inside a sentence or dialogue
				example — <code>{"{trainingReminder}"}</code> already carries the "say this honestly"
				instruction as its own sentence, so the model is never shown that instruction as if it
				were something to say back. Keep <code>{"{style}"}</code> in the template: it carries the
				tone and answer-shape instructions and, at its end, the honesty clause saying Alpha
				generates text from patterns and can be wrong. Nothing in the code can remove that clause,
				but deleting the token here does (CUR-1506).</span
			>
			<textarea
				name="persona"
				aria-label="System persona prompt"
				rows="14"
				class="w-full rounded border p-2 font-mono text-xs"
				bind:value={persona}
			></textarea>
			<!-- Expanded when no custom persona is set (show the default to start from);
			     collapsed once a custom value exists. -->
			<details class="text-xs text-gray-500" open={!cur.persona}>
				<summary class="cursor-pointer">Show default</summary>
				<pre class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{def.persona}</pre>
			</details>
		</div>

		<div class="space-y-1">
			<div class="flex items-baseline justify-between">
				<span class="font-medium">Search grounding prompt</span>
				<span class="flex gap-3">
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline"
						title="Copy the current shipped default into the editor to tweak from it. You're not overriding until you Save."
						onclick={() => (grounding = def.grounding)}>Load default into editor</button
					>
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline disabled:opacity-40"
						disabled={!grounding}
						onclick={() => (grounding = "")}>Reset to default</button
					>
				</span>
			</div>
			<span class="block text-xs text-gray-500"
				>Tokens <code>{"{asOf}"}</code> and <code>{"{evidence}"}</code> are auto-filled with the retrieved
				sources.</span
			>
			<textarea
				name="grounding"
				aria-label="Search grounding prompt"
				rows="8"
				class="w-full rounded border p-2 font-mono text-xs"
				bind:value={grounding}
			></textarea>
			<details class="text-xs text-gray-500" open={!cur.grounding}>
				<summary class="cursor-pointer">Show default</summary>
				<pre class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{def.grounding}</pre>
			</details>
		</div>

		<div class="space-y-1">
			<div class="flex items-baseline justify-between">
				<span class="font-medium">Collective second opinion — panelist prompt</span>
				<span class="flex gap-3">
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline"
						title="Copy the current shipped default into the editor to tweak from it. You're not overriding until you Save."
						onclick={() => (panelistPrompt = def.panelistPrompt)}>Load default into editor</button
					>
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline disabled:opacity-40"
						disabled={!panelistPrompt}
						onclick={() => (panelistPrompt = "")}>Reset to default</button
					>
				</span>
			</div>
			<span class="block text-xs text-gray-500"
				>Each panel model answers the question independently with this instruction.</span
			>
			<textarea
				name="panelistPrompt"
				aria-label="Panelist prompt"
				rows="5"
				class="w-full rounded border p-2 font-mono text-xs"
				bind:value={panelistPrompt}
			></textarea>
			<details class="text-xs text-gray-500" open={!cur.panelistPrompt}>
				<summary class="cursor-pointer">Show default</summary>
				<pre class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{def.panelistPrompt}</pre>
			</details>
		</div>

		<div class="space-y-1">
			<div class="flex items-baseline justify-between">
				<span class="font-medium">Collective second opinion — aggregator (verdict) prompt</span>
				<span class="flex gap-3">
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline"
						title="Copy the current shipped default into the editor to tweak from it. You're not overriding until you Save."
						onclick={() => (aggregatorPrompt = def.aggregatorPrompt)}
						>Load default into editor</button
					>
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline disabled:opacity-40"
						disabled={!aggregatorPrompt}
						onclick={() => (aggregatorPrompt = "")}>Reset to default</button
					>
				</span>
			</div>
			<span class="block text-xs text-gray-500"
				>Audits whether the panel agrees with the given answer and emits the verdict JSON (<code
					>agreement / headline / consensus / contradictions / weakSpots</code
				>). It must analyse, not write a merged answer — keep the JSON contract intact.</span
			>
			<textarea
				name="aggregatorPrompt"
				aria-label="Aggregator prompt"
				rows="10"
				class="w-full rounded border p-2 font-mono text-xs"
				bind:value={aggregatorPrompt}
			></textarea>
			<details class="text-xs text-gray-500" open={!cur.aggregatorPrompt}>
				<summary class="cursor-pointer">Show default</summary>
				<pre class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{def.aggregatorPrompt}</pre>
			</details>
		</div>

		<div class="space-y-1">
			<div class="flex items-baseline justify-between">
				<span class="font-medium">Web-search decision (classifier) prompt</span>
				<span class="flex gap-3">
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline"
						title="Copy the current shipped default into the editor to tweak from it. You're not overriding until you Save."
						onclick={() => (searchClassifierPrompt = def.searchClassifierPrompt)}
						>Load default into editor</button
					>
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline disabled:opacity-40"
						disabled={!searchClassifierPrompt}
						onclick={() => (searchClassifierPrompt = "")}>Reset to default</button
					>
				</span>
			</div>
			<span class="block text-xs text-gray-500"
				>Decides whether a turn needs an open-web search. Must output only <code>yes</code> or
				<code>no</code>.</span
			>
			<textarea
				name="searchClassifierPrompt"
				aria-label="Search classifier prompt"
				rows="6"
				class="w-full rounded border p-2 font-mono text-xs"
				bind:value={searchClassifierPrompt}
			></textarea>
			<details class="text-xs text-gray-500" open={!cur.searchClassifierPrompt}>
				<summary class="cursor-pointer">Show default</summary>
				<pre
					class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{def.searchClassifierPrompt}</pre>
			</details>
		</div>

		<fieldset class="space-y-2">
			<legend class="font-medium">Decoding (blank = default)</legend>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<label class="space-y-1"
					><span class="block text-xs">temperature ({def.decoding.temperature})</span>
					<input
						name="temperature"
						aria-label="temperature"
						type="number"
						step="0.05"
						min="0"
						max="2"
						class="w-full rounded border p-1"
						bind:value={decoding.temperature}
					/></label
				>
				<label class="space-y-1"
					><span class="block text-xs">frequency_penalty ({def.decoding.frequency_penalty})</span>
					<input
						name="frequency_penalty"
						aria-label="frequency_penalty"
						type="number"
						step="0.05"
						min="-2"
						max="2"
						class="w-full rounded border p-1"
						bind:value={decoding.frequency_penalty}
					/></label
				>
				<label class="space-y-1"
					><span class="block text-xs">presence_penalty ({def.decoding.presence_penalty})</span>
					<input
						name="presence_penalty"
						aria-label="presence_penalty"
						type="number"
						step="0.05"
						min="-2"
						max="2"
						class="w-full rounded border p-1"
						bind:value={decoding.presence_penalty}
					/></label
				>
				<label class="space-y-1"
					><span class="block text-xs">max_tokens ({def.decoding.max_tokens})</span>
					<input
						name="max_tokens"
						aria-label="max_tokens"
						type="number"
						step="1"
						min="1"
						max="4096"
						class="w-full rounded border p-1"
						bind:value={decoding.max_tokens}
					/></label
				>
			</div>
			<p class="text-xs text-gray-500">Clear a box to use its default.</p>
		</fieldset>

		<div class="space-y-1">
			<div class="flex items-baseline justify-between">
				<span class="font-medium">Starter prompts</span>
				<span class="flex gap-3">
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline"
						title="Copy the current shipped defaults into the editor to tweak from them. You're not overriding until you Save."
						onclick={() => (starters = def.starters.join("\n"))}>Load default into editor</button
					>
					<button
						type="button"
						class="text-xs text-gray-500 hover:underline disabled:opacity-40"
						disabled={!starters}
						onclick={() => (starters = "")}>Reset to default</button
					>
				</span>
			</div>
			<span class="block text-xs text-gray-500">One per line; blank = the defaults below.</span>
			<textarea
				name="starters"
				aria-label="Starter prompts, one per line"
				rows="5"
				class="w-full rounded border p-2 text-xs"
				bind:value={starters}
			></textarea>
			<details class="text-xs text-gray-500" open={!cur.starters?.length}>
				<summary class="cursor-pointer">Show default</summary>
				<pre class="mt-1 rounded bg-gray-50 p-2 whitespace-pre-wrap">{def.starters.join("\n")}</pre>
			</details>
		</div>

		<button
			type="submit"
			disabled={saving}
			class="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
		>
			{saving ? "Saving…" : "Save"}
		</button>
	</form>

	<!-- Version-history backup: every save snapshots the value it replaced (newest first), so an
	     overwrite / "reset to default" / bad edit is recoverable. "Load into editor" pulls a version
	     back into the fields above to review and re-Save (which goes through the concurrency guard).
	     Export is an off-DB manual copy. -->
	<section class="mt-8 space-y-3 border-t pt-6">
		<div class="flex items-center justify-between">
			<h2 class="font-medium">Version history &amp; backup</h2>
			<button
				type="button"
				onclick={exportJson}
				class="rounded border px-3 py-1.5 text-xs hover:bg-gray-50"
			>
				Export current as JSON
			</button>
		</div>
		{#if cur.history?.length}
			<ul class="space-y-2">
				{#each cur.history as snap, i (i)}
					<li class="flex items-start justify-between gap-3 rounded border p-2 text-xs">
						<div class="min-w-0">
							<div class="text-gray-600">
								{snap.editedBy ?? "unknown"} · {fmtWhen(snap.editedAt)}
							</div>
							<div class="truncate text-gray-500">
								{snap.persona ? snap.persona.slice(0, 120) : "(default persona)"}
							</div>
						</div>
						<button
							type="button"
							onclick={() => loadIntoEditor(snap)}
							class="shrink-0 rounded border px-2 py-1 hover:bg-gray-50">Load into editor</button
						>
					</li>
				{/each}
			</ul>
			<p class="text-xs text-gray-500">
				Loading a version fills the fields above — review, then Save to apply. The current value is
				snapshotted into this history on every save, so restoring is reversible.
			</p>
		{:else}
			<p class="text-xs text-gray-500">
				No prior versions yet — they appear here after the next save.
			</p>
		{/if}
	</section>

	<!-- Danger zone: wipe ALL overrides + version history back to the code defaults (deletes the row).
	     Two-step inline confirm (no browser modal). Distinct from a blank Save, which keeps history. -->
	<section class="mt-8 space-y-2 border-t border-red-200 pt-6">
		<h2 class="font-medium text-red-800">Danger zone</h2>
		<form
			method="POST"
			action="?/reset"
			use:enhance={() => {
				return async ({ result, update }) => {
					// On success the row is gone — clear every field back to "use default" so the editor
					// reflects the wipe (the $state fields were init once and don't auto-resync on reload).
					if (result.type === "success") {
						persona = "";
						grounding = "";
						starters = "";
						decoding = {
							temperature: "",
							frequency_penalty: "",
							presence_penalty: "",
							max_tokens: "",
						};
						baseEditedAt = "";
					}
					confirmingReset = false;
					await update({ reset: false });
				};
			}}
		>
			{#if confirmingReset}
				<p class="text-xs text-red-800">
					This deletes ALL overrides AND the version history, reverting the chat to the built-in
					code defaults. Can't be undone from here — Export first if you might want it back.
				</p>
				<button type="submit" class="rounded bg-red-700 px-3 py-1.5 text-xs text-white">
					Confirm — reset to code defaults
				</button>
				<button
					type="button"
					onclick={() => (confirmingReset = false)}
					class="rounded border px-3 py-1.5 text-xs hover:bg-gray-50">Cancel</button
				>
			{:else}
				<button
					type="button"
					onclick={() => (confirmingReset = true)}
					class="rounded border border-red-300 px-3 py-1.5 text-xs text-red-800 hover:bg-red-50"
				>
					Reset everything to code defaults
				</button>
			{/if}
		</form>
	</section>
</div>
