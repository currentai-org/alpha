// Simple type to replace removed WebSearchSource
type SimpleSource = {
	title?: string;
	link: string;
	/** Where the answer first cites this source, 0 for its first citation; unset when uncited. */
	citedRank?: number;
};
import { processBlocks, type BlockToken } from '$lib/chat/utils/marked';

export type IncomingMessage = {
	type: 'process';
	content: string;
	sources: SimpleSource[];
	requestId: number;
	streaming?: boolean;
};

export type OutgoingMessage = {
	type: 'processed';
	blocks: BlockToken[];
	requestId: number;
};

// Flag to track if the worker is currently processing a message
let isProcessing = false;

// Buffer to store the latest incoming message
let latestMessage: IncomingMessage | null = null;

// Helper function to safely handle the latest message
async function processMessage() {
	if (latestMessage) {
		const nextMessage = latestMessage;

		latestMessage = null;
		isProcessing = true;

		try {
			const { content, sources, requestId, streaming } = nextMessage;
			const processedBlocks = await processBlocks(content, sources, streaming ?? false);
			postMessage(
				JSON.parse(JSON.stringify({ type: 'processed', blocks: processedBlocks, requestId }))
			);
		} finally {
			isProcessing = false;

			// Drain a message buffered while we were parsing IMMEDIATELY. The buffer already
			// coalesces to the latest content, so at most one parse is queued — an idle delay
			// here only adds render lag per streamed chunk (a long delay caps
			// streaming at a few visible updates/second and reads as stutter on long answers).
			processMessage();
		}
	}
}

onmessage = (event) => {
	if (event.data.type !== 'process') {
		return;
	}

	latestMessage = event.data as IncomingMessage;

	if (!isProcessing && latestMessage) {
		processMessage();
	}
};
