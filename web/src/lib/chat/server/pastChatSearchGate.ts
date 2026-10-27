// past-chat search. The `past-chat-search` flag decides whether the feature exists on a
// deployment or for an account; the person's own Settings → Personalization switch, off by default,
// decides whether their turns use it. Both must be on, and the person must be signed in: a guest has no
// account whose chats could be searched. (CUR-4576)
import { flagEnabledOr } from "./flags";

export const PAST_CHAT_SEARCH_FLAG = "past-chat-search";

/** Whether the feature is offered at all: the switch shows in Settings and a turn may use it. */
export function pastChatSearchEnabled(): boolean {
	return flagEnabledOr(PAST_CHAT_SEARCH_FLAG, () => false);
}

/** Whether this turn searches the person's earlier chats. Off unless the flag, an account and the
 *  person's own switch all say yes. */
export function pastChatSearchOn(locals: App.Locals | undefined, settingOn: boolean | undefined): boolean {
	return Boolean(locals?.user?._id) && settingOn === true && pastChatSearchEnabled();
}
