import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';
import { demoConversationList } from './demo-conversation';

export { DEMO_ACTIVE_CONVERSATION_ID } from './demo-conversation';

/** Sidebar rows shown in the marketing embed — same shape as layout conversations. */
export function createDemoConversations(): ConvSidebar[] {
	return demoConversationList();
}
