import type { Message } from "$lib/chat/types/Message";

/**
 * An assistant answer still in the shape a turn first saves it in: no text and no updates. A turn's
 * final save replaces that shape, so one still present means its turn has not saved yet, or never will.
 */
export function isUnsavedAnswer(m: Message): boolean {
	return m.from === "assistant" && m.content === "" && !m.updates?.length;
}

function unsavedAnswerIds(messages: Message[]): string[] {
	return messages.filter(isUnsavedAnswer).map((m) => m.id);
}

/**
 * Let an earlier turn on this conversation finish saving before a new turn builds on it (CUR-2667).
 *
 * @remarks
 * Every turn writes the whole `messages` array, so the last writer wins: Retry pressed right after
 * Stop can load the conversation before the stopped turn's final save lands, then save its own copy
 * over it, leaving the stopped reply as an empty placeholder with no way back to its text.
 * When the loaded conversation holds an unsaved answer whose generation is still in flight, this
 * waits for that generation to settle (it is marked terminal only after its save) and returns a
 * fresh load. It returns null when nothing was in flight, so the common turn pays one in-memory
 * scan and no query. The wait is capped at `timeoutMs`, which is all a generation stuck in flight can
 * cost; the 5 s default matches the stop endpoint's own settle wait (`stop-generating/+server.ts`).
 */
export async function settlePendingAnswers<T>(opts: {
	messages: Message[];
	inFlight: (messageIds: string[]) => Promise<boolean>;
	reload: () => Promise<T>;
	timeoutMs?: number;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<T | null> {
	const ids = unsavedAnswerIds(opts.messages);
	if (ids.length === 0) return null;
	if (!(await opts.inFlight(ids))) return null;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const intervalMs = opts.intervalMs ?? 250;
	const deadline = Date.now() + (opts.timeoutMs ?? 5000);
	do {
		await sleep(intervalMs);
	} while (Date.now() < deadline && (await opts.inFlight(ids)));
	return opts.reload();
}
