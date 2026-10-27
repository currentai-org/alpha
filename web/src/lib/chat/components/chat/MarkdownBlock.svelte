<script lang="ts">
	import type { Token } from "$lib/chat/utils/marked";
	import CodeBlock from "../CodeBlock.svelte";
	import { browser } from "$app/environment";
	import { trackEvent } from "$lib/analytics";
	import { loadPurify, reportSanitizerDiff, sanitizerDiff } from "$lib/chat/utils/answerHtmlShadow";

	interface Props {
		tokens: Token[];
		loading?: boolean;
	}

	let { tokens, loading = false }: Props = $props();

	// Derive rendered tokens for memoization
	const renderedTokens = $derived(tokens);

	// Shadow pass (CUR-4130): DOMPurify checks what marked.ts already sanitized and reports what it
	// would remove. The output is untouched. Skipped while streaming, when blocks change every chunk.
	$effect(() => {
		if (!browser || loading) return;
		const html = renderedTokens.flatMap((t) => (t.type === "text" && typeof t.html === "string" ? [t.html] : []));
		if (html.length === 0) return;
		void loadPurify()
			.then((purify) => reportSanitizerDiff(sanitizerDiff(html.join(""), purify), trackEvent))
			.catch(() => {});
	});
</script>

{#each renderedTokens as token, i (i)}
	{#if token.type === "text"}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html token.html}
	{:else if token.type === "code"}
		<CodeBlock code={token.code} rawCode={token.rawCode} loading={loading && !token.isClosed} />
	{/if}
{/each}
