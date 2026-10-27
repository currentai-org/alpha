<script lang="ts">
	import { processBlocks, processBlocksSync, type BlockToken } from "$lib/chat/utils/marked";
	import MarkdownWorker from "$lib/chat/workers/markdownWorker?worker";
	import MarkdownBlock from "./MarkdownBlock.svelte";
	import { browser } from "$app/environment";

	import { onMount, onDestroy } from "svelte";
	import { updateDebouncer } from "$lib/chat/utils/updates";

	interface Props {
		content: string;
		sources?: { title?: string; link: string }[];
		loading?: boolean;
	}

	let { content, sources = [], loading = false }: Props = $props();

	// Sync-computed blocks used as fallback and for SSR (where effects don't run)
	let syncBlocks = $derived(processBlocksSync(content, sources, loading));
	let workerBlocks: BlockToken[] | null = $state(null);
	let workerContent: string | null = $state(null);
	// While streaming, a worker result one chunk behind is fine and keeps parsing off the main thread.
	// Once streaming stops, a stale worker result would keep painting the earlier text for a round
	// trip, and anything gated on the turn ending (the read-aloud player) painted over a half-written
	// answer (CUR-2048). The final content renders synchronously in that same flush instead.
	let blocks = $derived(
		workerBlocks && (loading || workerContent === content) ? workerBlocks : syncBlocks
	);

	let worker: Worker | null = null;
	let latestRequestId = 0;

	let latestContent = '';

	function handleBlocks(result: BlockToken[], requestId: number) {
		if (requestId !== latestRequestId) return;
		workerBlocks = result;
		workerContent = latestContent;
		updateDebouncer.endRender();
	}

	$effect(() => {
		if (!browser) return;

		const requestId = ++latestRequestId;
		latestContent = content;

		if (worker) {
			updateDebouncer.startRender();
			worker.postMessage({ type: "process", content, sources, requestId, streaming: loading });
			return;
		}

		(async () => {
			updateDebouncer.startRender();
			const processed = await processBlocks(content, sources, loading);
			handleBlocks(processed, requestId);
		})();
	});

	onMount(() => {
		if (typeof Worker !== "undefined") {
			worker = new MarkdownWorker();
			worker.onmessage = (event: MessageEvent) => {
				const data = event.data as { type?: string; blocks?: BlockToken[]; requestId?: number };
				if (data?.type !== "processed" || !data.blocks || data.requestId === undefined) return;
				handleBlocks(data.blocks, data.requestId);
			};
		}
	});

	onDestroy(() => {
		worker?.terminate();
		worker = null;
	});
</script>

{#each blocks as block, index (loading && index === blocks.length - 1 ? `stream-${index}` : block.id)}
	<MarkdownBlock tokens={block.tokens} {loading} />
{/each}
