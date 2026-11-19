import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger";
import {
	conversationSealer,
	conversationSealWritesOn,
	type MacRestamps,
	rowHasSealedParts,
	sealPreprompt,
} from "$lib/chat/server/chat/sealedTurn";

/**
 * Saving a conversation's messages without erasing anyone else's.
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
 *   the run finished, and two overlapping re-attaches can save in either order.
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
 * `crisisEndedAt` likewise only when given, so a save that does not pass it (a message delete, a sync push)
 * leaves a stored stamp alone.
 * Returns how many conversations matched (0 when it was deleted meanwhile).
 */
export async function saveConversationMessages(
	filter: Record<string, unknown>,
	base: ConversationBase,
	next: { messages: Message[]; title?: string; updatedAt?: Date; crisisEndedAt?: Date }
): Promise<{ matchedCount: number; modifiedCount: number }> {
	const titleChanged = next.title !== undefined && next.title !== base.title;
	const sealed = await sealForSave(filter, base, next.messages, titleChanged ? next.title : undefined);
	return collections.conversations.modifyOne(filter, (current) => {
		const $set: Record<string, unknown> = {
			messages: mergeMessages(base.messages, sealed.messages, current.messages ?? []),
		};
		if (next.updatedAt) $set.updatedAt = next.updatedAt;
		if (next.crisisEndedAt) $set.crisisEndedAt = next.crisisEndedAt;
		if (sealed.title) Object.assign($set, sealed.title);
		else if (titleChanged) $set.title = next.title;
		// Another save may have sealed it meanwhile; that seal stands.
		if (sealed.preprompt && !current.sealedPreprompt) Object.assign($set, sealed.preprompt);
		return { $set };
	});
}

/**
 * Store MACs a turn's check re-took under the active key (`hydrateSealedHistory`'s return), each
 * only where the stored slot is still at the revision it was checked at, so a reseal made meanwhile is
 * never given an old body's MAC. Afterwards the old key can be retired without losing the chat.
 */
export async function restampSealedMacs(filter: Record<string, unknown>, restamps: MacRestamps): Promise<void> {
	const byId = new Map(restamps.messages.map((r) => [r.id, r]));
	await collections.conversations.modifyOne(filter, (current) => {
		const $set: Record<string, unknown> = {};
		let changed = false;
		const messages = (current.messages ?? []).map((m) => {
			const r = byId.get(m.id);
			if (!r || !m.sealed || m.sealedRev !== r.rev) return m;
			changed = true;
			return { ...m, sealedMac: r.sealedMac };
		});
		if (changed) $set.messages = messages;
		const p = restamps.preprompt;
		if (p && current.sealedPreprompt && current.sealedPrepromptRev === p.rev) $set.sealedPrepromptMac = p.sealedPrepromptMac;
		return Object.keys($set).length ? { $set } : null;
	});
}

/**
 * The messages and title as this save stores them. While sealing is on and the owner has a
 * history key, each message this request wrote in plaintext (not `sealed`, and changed since `base`) is
 * sealed, and so is a changed title. A message still `sealed` is one this request could not read and
 * did not rewrite: its skeleton may have changed (a new child), its seal stays. The in-memory message's
 * `sealedRev` moves to the new seal's, so a second save in the same turn seals at the next revision. A
 * plaintext preprompt is sealed along with them (`sealPreprompt`).
 *
 * With sealing off, a conversation that already holds sealed parts is still sealed: the turn
 * hydrated its bodies to plaintext, and saving them as such would put the chat back in the clear one turn
 * at a time. When it cannot be sealed (the owner has no history key), the save is refused.
 */
async function sealForSave(
	filter: Record<string, unknown>,
	base: ConversationBase,
	messages: Message[],
	title: string | undefined
): Promise<{ messages: Message[]; title?: Record<string, unknown>; preprompt?: Record<string, unknown> }> {
	const on = conversationSealWritesOn();
	const pending = messages.filter((m) => !m.sealed && base.messages.get(m.id)?.fingerprint !== fingerprint(m));
	if (pending.length === 0 && title === undefined) return { messages };
	// With sealing off, only a sealed chat needs the stored row read. A hydrated message keeps its
	// `sealedRev`, so a save on a sealed chat always carries one, and an unsealed chat's save costs no read.
	if (!on && !messages.some((m) => m.sealedRev !== undefined)) return { messages };
	const stored = await collections.conversations.findOne(filter);
	// Deleted meanwhile: the write below matches nothing, so there is nothing to seal.
	if (!stored) return { messages };
	const sealedRow = rowHasSealedParts(stored);
	if (!on && !sealedRow) return { messages };
	const sealer = await conversationSealer(stored._id.toString(), stored, { sealedRow });
	if (!sealer) {
		if (!on) {
			logger.error({ event: "history-seal-refused-plaintext", conversationId: stored._id.toString() }, "[sealed-turn] a sealed chat cannot be sealed again here, so its save is refused");
			throw new Error("this chat is sealed and cannot be sealed again here, so it is not saved in plaintext");
		}
		return { messages };
	}
	const sealedById = new Map<string, Message>();
	const storedRevs = new Map((stored.messages ?? []).map((m) => [m.id, m.sealedRev]));
	await Promise.all(
		pending.map(async (m) => {
			// The next revision is past the stored one as well as the in-memory one: a caller that saves a
			// copy of its messages (the turn's persist compresses each answer's updates into a new object)
			// never sees `sealedRev` move, and two seals at one revision carry different MACs, so a browser
			// that opened the first is refused against the second.
			const rev = Math.max(m.sealedRev ?? -1, storedRevs.get(m.id) ?? -1);
			const s = await sealer.message(rev < 0 ? m : { ...m, sealedRev: rev });
			m.sealedRev = s.sealedRev;
			sealedById.set(m.id, s);
		})
	);
	// A preprompt still plaintext (made by a locked tab, or before sealing) is sealed with the first save
	// that seals anything else, with the stored root system message that repeats it. The
	// in-memory root is left alone, so a later save in this turn sees it unchanged and keeps the seal.
	const preprompt = await sealPreprompt(sealer, stored);
	if (preprompt?.root) sealedById.set(preprompt.root.id, preprompt.root);
	const out: { messages: Message[]; title?: Record<string, unknown>; preprompt?: Record<string, unknown> } = {
		messages: messages.map((m) => sealedById.get(m.id) ?? m),
		...(preprompt ? { preprompt: preprompt.fields } : {}),
	};
	if (title !== undefined) {
		out.title = { title: "", ...(await sealer.title(title, (stored.sealedTitleRev ?? -1) + 1)) };
	}
	return out;
}
