import type { Tree, TreeId, TreeNode } from "./tree";

export function buildSubtree<T>(conv: Tree<T>, id: TreeId): TreeNode<T>[] {
	if (!conv.rootMessageId) {
		if (conv.messages.length === 0) return [];
		// legacy conversation slice up to id
		const index = conv.messages.findIndex((m) => m.id === id);
		if (index === -1) throw new Error("Message not found");
		return conv.messages.slice(0, index + 1);
	} else {
		// find the message with the right id then create the ancestor tree
		const message = conv.messages.find((m) => m.id === id);
		if (!message) throw new Error("Message not found");

		// Degrade gracefully on a missing ancestor instead of throwing. A stale/desynced tree — e.g. a
		// resend after an interrupted generation left a dangling parent reference — used to throw
		// "Ancestor not found" here, surfacing to the user as a 500 "an error occurred" toast. Dropping
		// an unresolvable ancestor yields a slightly shorter prompt subtree, which is strictly better
		// than failing the turn. The append path (appendTurnMessages) also guards the stale parent so
		// this stays a backstop, not the primary defense.
		const ancestors = (message.ancestors ?? [])
			.map((ancestorId) => conv.messages.find((m) => m.id === ancestorId))
			.filter((a): a is TreeNode<T> => a !== undefined);
		return [...ancestors, message];
	}
}
