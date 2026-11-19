// past-chat search. The `past-chat-search` flag decides whether the feature exists on a
// deployment or for an account; the person's own Settings → Personalization switch, off by default,
// decides whether their turns use it. Both must be on, and the person must be signed in: a guest has no
// account whose chats could be searched.
import { flagEnabledOr } from "./flags";

export const PAST_CHAT_SEARCH_FLAG = "past-chat-search";

/** Whether the feature is offered at all: the switch shows in Settings and a turn may use it. */
export function pastChatSearchEnabled(): boolean {
	return flagEnabledOr(PAST_CHAT_SEARCH_FLAG, () => false);
}

/** Whether this turn searches the person's earlier chats. Off unless the flag, an account and the
 *  person's own switch all say yes. */
function pastChatSearchOn(locals: App.Locals | undefined, settingOn: boolean | undefined): boolean {
	return Boolean(locals?.user?._id) && settingOn === true && pastChatSearchEnabled();
}

/** What this turn's past-chat search is: off, on for this owner, or switched on but unavailable because
 *  the account's chats are sealed and the server cannot read them. */
export type PastChatsForTurn =
	| { state: "off" }
	| { state: "on"; owner: { userId: string; currentConversationId: string } }
	| { state: "sealed" };

/**
 * Past-chat search for one turn. An account whose chats are sealed gets no tool, and the turn tells the
 * model past-chat search is unavailable, rather than offering a search that reads empty sealed rows and
 * answers "nothing found".
 */
export async function pastChatsForTurn(
	locals: App.Locals | undefined,
	settingOn: boolean | undefined,
	currentConversationId: string,
	historySealed?: (owner: { userId: { toString(): string } }) => Promise<boolean>
): Promise<PastChatsForTurn> {
	const user = locals?.user?._id;
	if (!user || !pastChatSearchOn(locals, settingOn)) return { state: "off" };
	const sealed = historySealed ?? (await import("./chat/sealedTurn")).ownerHoldsOwnHistoryKey;
	if (await sealed({ userId: user })) return { state: "sealed" };
	return { state: "on", owner: { userId: user.toString(), currentConversationId } };
}
