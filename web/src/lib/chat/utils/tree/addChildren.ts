import { v4 } from "uuid";
import type { Tree, TreeId, NewNode, TreeNode } from "./tree";

export function assertFreeId<T>(conv: Tree<T>, id: TreeId | undefined): void {
	if (id !== undefined && conv.messages.some((m) => m.id === id)) {
		throw new Error("A message with this id already exists");
	}
}

/**
 * `id` lets the caller choose the new node's id. The chat page and the server each build the same
 * tree for a turn, and when both use one id the server's copy replaces the page's without remounting
 * the message (CUR-2098). Omitted, a fresh one is minted.
 */
export function addChildren<T>(
	conv: Tree<T>,
	message: NewNode<T>,
	parentId?: TreeId,
	id?: TreeId
): TreeId {
	assertFreeId(conv, id);
	// if this is the first message we just push it
	if (conv.messages.length === 0) {
		const messageId = id ?? v4();
		conv.rootMessageId = messageId;
		conv.messages.push({
			...message,
			ancestors: [],
			id: messageId,
		} as TreeNode<T>);
		return messageId;
	}

	if (!parentId) {
		throw new Error("You need to specify a parentId if this is not the first message");
	}

	const messageId = id ?? v4();
	if (!conv.rootMessageId) {
		// if there is no parentId we just push the message
		if (!!parentId && parentId !== conv.messages[conv.messages.length - 1].id) {
			throw new Error("This is a legacy conversation, you can only append to the last message");
		}
		conv.messages.push({ ...message, id: messageId } as TreeNode<T>);
		return messageId;
	}

	const ancestors = [...(conv.messages.find((m) => m.id === parentId)?.ancestors ?? []), parentId];
	conv.messages.push({
		...message,
		ancestors,
		id: messageId,
		children: [],
	} as TreeNode<T>);

	const parent = conv.messages.find((m) => m.id === parentId);

	if (parent) {
		if (parent.children) {
			parent.children.push(messageId);
		} else parent.children = [messageId];
	}

	return messageId;
}
