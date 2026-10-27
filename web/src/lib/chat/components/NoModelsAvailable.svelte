<!--
	CUR-1141: the shared fallback for every ChatWindow mount site (ChatLanding.svelte,
	routes/chat/conversation/[id]/+page.svelte, routes/chat/models/[...model]/+page.svelte) —
	each guards on {#if currentModel} before mounting ChatWindow, since findCurrentModel's
	models[0] fallback is undefined the instant the model catalog is empty. One component serves all three, so the copy is not duplicated (audit:dup:check).

	CUR-1154: the permanent misconfiguration copy must not show unconditionally, so "genuinely never
	configured" is told apart from "registry not yet built on a cold instance" (as on a fresh
	cold-started preview). The three mount sites are all server-loaded
	(no client-side undefined phase to key off, unlike ChatLanding's own client fetch), so the
	loading distinction has to come from actually retrying the load, not from a different label
	on the same one-shot result. A few bounded retries via safeInvalidate('app:models') give a
	cold-booting registry a real chance to resolve; if the parent's `models` populates in the
	meantime, `currentModel` upstream turns truthy and this component unmounts before it matters.
	Only the exhausted-retries case still shows the original, genuinely-permanent copy.
-->
<script lang="ts">
	import { safeInvalidate } from "$lib/chat/utils/safeInvalidate";

	const MAX_ATTEMPTS = 3;
	const RETRY_DELAY_MS = 2500;

	let attempt = $state(0);

	$effect(() => {
		if (attempt >= MAX_ATTEMPTS) return;
		const timer = setTimeout(async () => {
			await safeInvalidate("app:models");
			attempt += 1;
		}, RETRY_DELAY_MS);
		return () => clearTimeout(timer);
	});
</script>

{#if attempt < MAX_ATTEMPTS}
	<div class="mx-auto my-20 max-w-xl rounded-xl border p-6 text-center dark:border-gray-700">
		<h2 class="mb-2 text-xl font-semibold">Starting up…</h2>
		<p class="text-gray-600 dark:text-gray-300">
			The model catalog is still loading. This should resolve on its own within a few seconds.
		</p>
	</div>
{:else}
	<div class="mx-auto my-20 max-w-xl rounded-xl border p-6 text-center dark:border-gray-700">
		<h2 class="mb-2 text-xl font-semibold">No models available</h2>
		<p class="text-gray-600 dark:text-gray-300">
			No chat models are configured. Set `OPENAI_BASE_URL` and ensure the server can reach the
			endpoint, then reload. If unset, the app defaults to the Hugging Face router.
		</p>
	</div>
{/if}
