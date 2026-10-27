// What a tool call shows while it is still running. A kit's calls push frames here; the tool loop
// (openai/calculateTool.ts) yields them as they arrive, so the live line can say "Waiting for a free
// sandbox…" during the call rather than after it returns. (CUR-4584)
import type { ToolFrames, ToolRunFrame } from "./types";

export function toolFrames(): ToolFrames {
	const queue: ToolRunFrame[] = [];
	let wake: (() => void) | undefined;
	return {
		push(frame) {
			queue.push(frame);
			wake?.();
			wake = undefined;
		},
		take: () => queue.splice(0),
		next: () => (queue.length > 0 ? Promise.resolve() : new Promise<void>((resolve) => (wake = resolve))),
	};
}

/** Yields every frame `frames` receives until `work` settles, then any left over, and returns. `work`'s
 *  own result or rejection stays with the caller, who awaits it after this. */
export async function* framesWhile(work: Promise<unknown>, frames: ToolFrames): AsyncGenerator<ToolRunFrame, void, void> {
	let settled = false;
	const done = work.then(
		() => (settled = true),
		() => (settled = true)
	);
	while (!settled) {
		await Promise.race([done, frames.next()]);
		yield* frames.take();
	}
	yield* frames.take();
}
