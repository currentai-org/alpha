/**
 * An Alpha conversation with a branch, and the shape a round trip has to keep. Ids differ after
 * an import (they are derived from the chat file's ids), so trees are compared by role and text.
 */
import { ObjectId } from "bson";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";

/** Each message as role, text and children, children in stored order; the system root is left out. */
type TreeNode = { role: string; content: string; children: TreeNode[] };
export type TreeShape = TreeNode[];

export function treeShape(messages: Message[]): TreeShape {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const shape = (ids: string[]): TreeShape =>
		ids.flatMap((id) => {
			const m = byId.get(id);
			if (!m) return [];
			if (m.from === "system") return shape(m.children ?? []);
			return [{ role: m.from, content: m.content, children: shape(m.children ?? []) }];
		});
	const roots = messages.filter((m) => !m.ancestors?.length).map((m) => m.id);
	return shape(roots);
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 12, minute));

/**
 * A question with two answers (a retry), a follow-up on the second, and an answer to that: the branch
 * Alpha opens on is the second answer's. The system root carries no text, as a new chat's does.
 */
export function branchedConversation(over: Partial<Conversation> = {}): Conversation {
	const id = (n: string) => `00000000-0000-4000-8000-00000000000${n}`;
	const msg = (n: string, from: Message["from"], content: string, ancestors: string[], children: string[], minute: number): Message => ({
		id: id(n),
		from,
		content,
		ancestors,
		children: children.map(id),
		createdAt: at(minute),
		updatedAt: at(minute),
	});
	const root = id("0");
	return {
		_id: new ObjectId(),
		title: "Round trip",
		model: "fixture-model",
		createdAt: at(0),
		updatedAt: at(9),
		rootMessageId: root,
		messages: [
			msg("0", "system", "", [], ["1"], 0),
			msg("1", "user", "Name a soup.", [root], ["2", "3"], 1),
			msg("2", "assistant", "Minestrone.", [root, id("1")], [], 2),
			msg("3", "assistant", "Gazpacho.", [root, id("1")], ["4"], 3),
			msg("4", "user", "Is it served cold?", [root, id("1"), id("3")], ["5"], 4),
			msg("5", "assistant", "Yes, chilled.", [root, id("1"), id("3"), id("4")], [], 5),
		],
		...over,
	};
}
