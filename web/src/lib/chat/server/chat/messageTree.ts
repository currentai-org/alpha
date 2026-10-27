import { error } from "@sveltejs/kit";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { buildSubtree } from "$lib/chat/utils/tree/buildSubtree.js";
import { addChildren } from "$lib/chat/utils/tree/addChildren.js";
import { addSibling } from "$lib/chat/utils/tree/addSibling.js";
import { logger } from "$lib/chat/server/logger";
import { isUnsavedAnswer } from "./settlePendingAnswers";

/**
 * Append this turn's message(s) to the conversation tree and return the assistant message we'll
 * stream into plus the subtree used to build the prompt. Three cases:
 *
 *   - retry of a USER message with a new prompt → edit: add a user sibling + blank assistant child.
 *   - retry of an ASSISTANT message → regenerate: add a blank assistant sibling, drop the old
 *     answer from the prompt subtree.
 *   - normal turn → append the user message + a blank assistant child back to back, after the newest
 *     turn on the branch the page named (see `newestOnBranch`).
 *   - attach to an ASSISTANT message holding an agent task (CUR-993) → no new node: the same message
 *     is emptied and rewritten from the task's replayed events, so a reload after the tab closed
 *     shows the run's answer where its interrupted one was, rather than a regenerated sibling.
 *
 * `newMessageIds` are the ids the page minted for the same messages. Using them keeps the post-turn
 * snapshot's ids equal to the page's, so the page swaps in the server copy without remounting the
 * answer and resetting whatever the person had opened on it (CUR-2098). An id that is already in the
 * conversation (a re-POST of the same turn after a dropped connection) is not reused; the server
 * mints a fresh one, as it always did, and says so in the log.
 *
 * Mutates `conv.messages` in place (via the tree helpers). `messageToWriteToId` is left undefined
 * for a retry that matches neither case (e.g. retrying a user message with no new prompt); the
 * caller validates the result.
 */
export function appendTurnMessages(
	conv: Conversation,
	opts: {
		isRetry?: boolean;
		attach?: boolean;
		messageId?: Message["id"];
		newPrompt?: string;
		uploadedFiles: NonNullable<Message["files"]>;
		newMessageIds?: { user?: Message["id"]; assistant?: Message["id"] };
	}
): { messageToWriteToId: Message["id"] | undefined; messagesForPrompt: Message[] } {
	const { isRetry, messageId, newPrompt, uploadedFiles } = opts;
	const taken = (id: Message["id"]) => conv.messages.some((m) => m.id === id);
	const clientId = (role: "user" | "assistant"): Message["id"] | undefined => {
		const id = opts.newMessageIds?.[role];
		if (id === undefined) return undefined;
		if (taken(id)) {
			logger.warn({ role }, "appendTurnMessages: the page's message id is taken; minting a new one");
			return undefined;
		}
		return id;
	};
	// Read both before either node is added, so the user id can't collide with the assistant one.
	const userId = clientId("user");
	const assistantCandidate = clientId("assistant");
	const assistantId = assistantCandidate === userId ? undefined : assistantCandidate;

	// we will append tokens to the content of this message
	let messageToWriteToId: Message["id"] | undefined = undefined;
	// used for building the prompt, subtree of the conversation that goes from the latest message to the root
	let messagesForPrompt: Message[] = [];

	if (opts.attach) {
		const target = conv.messages.find((message) => message.id === messageId);
		if (!target) error(404, "Message not found");
		if (target.from !== "assistant" || !target.agentRun || target.agentRun.closed) {
			error(409, "This message has no agent task to re-attach to");
		}
		Object.assign(target, {
			content: "",
			updates: [],
			interrupted: false,
			updatedAt: new Date(),
		});
		messageToWriteToId = target.id;
		messagesForPrompt = buildSubtree(conv, target.id);
		messagesForPrompt.pop(); // the prompt is everything up to the answer being rewritten
	} else if (isRetry && messageId) {
		// two cases, if we're retrying a user message with a newPrompt set,
		// it means we're editing a user message
		// if we're retrying on an assistant message, newPrompt cannot be set
		// it means we're retrying the last assistant message for a new answer

		const messageToRetry = conv.messages.find((message) => message.id === messageId);

		if (!messageToRetry) {
			error(404, "Message not found");
		}

		if (messageToRetry.from === "user" && newPrompt) {
			// add a sibling to this message from the user, with the alternative prompt
			// add a children to that sibling, where we can write to
			const newUserMessageId = addSibling(
				conv,
				{
					from: "user",
					content: newPrompt,
					files: uploadedFiles,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				messageId,
				userId
			);
			messageToWriteToId = addChildren(
				conv,
				{
					from: "assistant",
					content: "",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				newUserMessageId,
				assistantId
			);
			messagesForPrompt = buildSubtree(conv, newUserMessageId);
		} else if (messageToRetry.from === "assistant") {
			// we're retrying an assistant message, to generate a new answer
			// just add a sibling to the assistant answer where we can write to
			messageToWriteToId = addSibling(
				conv,
				{ from: "assistant", content: "", createdAt: new Date(), updatedAt: new Date() },
				messageId,
				assistantId
			);
			messagesForPrompt = buildSubtree(conv, messageId);
			messagesForPrompt.pop(); // don't need the latest assistant message in the prompt since we're retrying it
		}
	} else {
		// Stale-client guard (primary defense for the "Ancestor not found" 500): the client points at
		// the parent it thinks is the conversation leaf, but a resend after an interrupted/aborted
		// generation can leave it referencing a message the server never persisted. addChildren would
		// then build a node whose ancestor doesn't exist, and buildSubtree later 500s. If the parent
		// can't be resolved, re-point to the conversation's actual current leaf so the turn still lands.
		let parentId = messageId;
		if (parentId && conv.messages.length > 0 && !conv.messages.some((m) => m.id === parentId)) {
			const leaf = conv.messages[conv.messages.length - 1]?.id;
			logger.warn(
				{ staleParent: parentId, repointedTo: leaf },
				"appendTurnMessages: stale parent reference, re-pointing to current leaf"
			);
			parentId = leaf;
		}

		// The same conversation open in two tabs: the other tab's turn has landed under the parent
		// this page named, and the page hasn't seen it. Append after it, so both turns read in order,
		// rather than forking a sibling that hides one behind "1 / 2". Forks come only from an edit or
		// a regenerate, which take the retry branch above.
		const requestedParent = parentId;
		if (parentId && conv.rootMessageId) parentId = newestOnBranch(conv, parentId);
		const unseen = requestedParent && parentId !== requestedParent ? parentId : undefined;
		if (unseen) {
			logger.info(
				{ requestedParent, appendedAfter: parentId },
				"appendTurnMessages: newer turns from another tab under the named parent; appending after them"
			);
		}

		// just a normal linear conversation, so we add the user message
		// and the blank assistant message back to back
		const newUserMessageId = addChildren(
			conv,
			{
				from: "user",
				content: newPrompt ?? "",
				files: uploadedFiles,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			parentId,
			userId
		);

		messageToWriteToId = addChildren(
			conv,
			{
				from: "assistant",
				content: "",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			newUserMessageId,
			assistantId
		);
		// build the prompt from the user message
		messagesForPrompt = buildSubtree(conv, newUserMessageId);
		if (unseen && requestedParent) {
			messagesForPrompt = withoutUnansweredTurns(messagesForPrompt, requestedParent);
		}
	}

	return { messageToWriteToId, messagesForPrompt };
}

/** Follow the newest child down from `id` to the end of its branch. */
function newestOnBranch(conv: Conversation, id: Message["id"]): Message["id"] {
	const seen = new Set<Message["id"]>();
	let node = conv.messages.find((m) => m.id === id);
	while (node?.children?.length && !seen.has(node.id)) {
		seen.add(node.id);
		const next = conv.messages.find((m) => m.id === node?.children?.at(-1));
		if (!next) break;
		node = next;
	}
	return node?.id ?? id;
}

/**
 * Drop each turn after `from` whose answer is still being written, question and empty answer
 * together. The other tab's answer may still be streaming when this turn is sent; an empty assistant
 * message in the prompt reads as a turn that said nothing, and dropping only the answer would put two
 * user messages back to back, which some chat templates refuse.
 */
function withoutUnansweredTurns(path: Message[], from: Message["id"]): Message[] {
	const start = path.findIndex((m) => m.id === from);
	if (start === -1) return path;
	const drop = new Set<Message["id"]>();
	for (const m of path.slice(start + 1)) {
		if (!isUnsavedAnswer(m)) continue;
		drop.add(m.id);
		const question = m.ancestors?.at(-1);
		if (question && path.some((p) => p.id === question && p.from === "user")) drop.add(question);
	}
	return drop.size ? path.filter((m) => !drop.has(m.id)) : path;
}
