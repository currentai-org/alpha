import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import { collections } from "$lib/chat/server/database";

/**
 * Saving a conversation's messages without erasing anyone else's (CUR-2806).
 *
 * @remarks
 * A conversation is one JSONB document. Setting the whole `messages` array from the copy a request
 * loaded would let two requests on one conversation (two tabs, Retry while a stopped turn saves, a
 * second opinion during a turn) erase each other's messages.
 * Here a request states what it loaded (`snapshotConversation`) and what it wants
 * (`next`), and the save merges that change into the row as it stands now, under the row's lock, so a
 * message only this request touched is written and every other message is left as stored.
 */

type BaseMessage = { fingerprint: string; children: string[] };

/** What a request loaded: each message's content fingerprint, and the title. */
export interface ConversationBase {
	messages: ReadonlyMap<string, BaseMessage>;
	title: string | undefined;
}

/** JSON with object keys sorted, so two reads of one stored message compare equal however built. */
function fingerprint(message: Message): string {
	return JSON.stringify(message, (_key, value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((k) => [k, (value as Record<string, unknown>)[k]])
				)
			: value
	);
}

/** Take this before the request changes anything, so the save can tell its own changes apart. */
export function snapshotConversation(conv: Pick<Conversation, "messages" | "title">): ConversationBase {
	return {
		messages: new Map(
			conv.messages.map((m) => [m.id, { fingerprint: fingerprint(m), children: [...(m.children ?? [])] }])
		),
		title: conv.title,
	};
}

/** An answer that ended with its final answer, not cut off: words in it and nothing marks it interrupted. */
function finishedAnswer(message: Message): boolean {
	if (message.from !== "assistant" || message.interrupted === true || !message.content.trim()) return false;
	const ending = (message.updates ?? []).findLast((u) => u.type === MessageUpdateType.FinalAnswer);
	return ending !== undefined && ending.interrupted !== true;
}

/** `current`'s ids, less the ones this request removed, plus the ones it added, in a stable order. */
function mergeIds(base: string[], mine: string[], current: string[]): string[] {
	const removed = new Set(base.filter((id) => !mine.includes(id)));
	const out = current.filter((id) => !removed.has(id));
	for (const id of mine) if (!base.includes(id) && !out.includes(id)) out.push(id);
	return out;
}

/**
 * Three-way merge of a message list by id: `base` is what this request loaded, `mine` what it wants
 * stored, `current` what is stored now.
 *
 * - A message this request did not change keeps its stored version, whoever wrote that.
 * - A message only this request changed (or created) is written as this request has it.
 * - A message both changed (a parent that gained a child in each) takes this request's fields, with
 *   `children` merged so each side's new child stays reachable.
 * - A finished agent-run answer is never replaced by an unfinished copy, whoever changed what. Every
 *   re-attach empties the answer and saves it emptied before replaying the run, even one begun after
 *   the run finished, and two overlapping re-attaches can save in either order (CUR-3875).
 * - A message this request removed goes only if nobody changed it since, and nothing added since
 *   hangs below it; otherwise it stays, so a removal never takes someone else's newer work with it.
 * - Messages stored since this request loaded, and not removed, are kept in their stored place; this
 *   request's new messages follow them.
 * - Every kept message is listed in its parent's `children`.
 */
export function mergeMessages(base: ReadonlyMap<string, BaseMessage>, mine: Message[], current: Message[]): Message[] {
	const mineById = new Map(mine.map((m) => [m.id, m]));
	const changed = new Set(
		mine.filter((m) => base.get(m.id)?.fingerprint !== fingerprint(m)).map((m) => m.id)
	);
	const removed = new Set([...base.keys()].filter((id) => !mineById.has(id)));
	const addedSince = current.filter((m) => !base.has(m.id) && !mineById.has(m.id));
	const hasNewDescendant = (id: string) => addedSince.some((m) => m.ancestors?.includes(id));

	const merged: Message[] = [];
	const stored = new Set<string>();
	for (const cur of current) {
		stored.add(cur.id);
		const was = base.get(cur.id);
		if (removed.has(cur.id)) {
			if (was && fingerprint(cur) === was.fingerprint && !hasNewDescendant(cur.id)) continue;
			merged.push(cur);
			continue;
		}
		const m = mineById.get(cur.id);
		if (!m || !changed.has(cur.id)) {
			merged.push(cur);
			continue;
		}
		if (cur.agentRun && finishedAnswer(cur) && !finishedAnswer(m)) {
			merged.push(cur);
			continue;
		}
		if (!was || fingerprint(cur) === was.fingerprint) {
			merged.push(m);
			continue;
		}
		merged.push({ ...m, children: mergeIds(was.children, m.children ?? [], cur.children ?? []) });
	}
	for (const m of mine) if (changed.has(m.id) && !stored.has(m.id)) merged.push(m);
	// A kept message stays reachable: its parent lists it, even where this request had unlinked it.
	const at = new Map(merged.map((m, i) => [m.id, i]));
	for (const m of merged) {
		const i = at.get(m.ancestors?.at(-1) ?? "");
		if (i === undefined || merged[i].children?.includes(m.id)) continue;
		merged[i] = { ...merged[i], children: [...(merged[i].children ?? []), m.id] };
	}
	return merged;
}

/**
 * Save `next` into the conversation `filter` matches, merged with whatever was stored since `base` was taken.
 * The title is written only when this request changed it, so a rename made elsewhere survives, and
 * `updatedAt` only when given: a turn moves the conversation up the list, a deleted message does not.
 * Returns how many conversations matched (0 when it was deleted meanwhile).
 */
export async function saveConversationMessages(
	filter: Record<string, unknown>,
	base: ConversationBase,
	next: { messages: Message[]; title?: string; updatedAt?: Date }
): Promise<{ matchedCount: number; modifiedCount: number }> {
	return collections.conversations.modifyOne(filter, (current) => {
		const $set: Record<string, unknown> = {
			messages: mergeMessages(base.messages, next.messages, current.messages ?? []),
		};
		if (next.updatedAt) $set.updatedAt = next.updatedAt;
		if (next.title !== undefined && next.title !== base.title) $set.title = next.title;
		return { $set };
	});
}
