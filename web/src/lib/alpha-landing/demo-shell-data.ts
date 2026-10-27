import { createDemoPageData, type DemoShellData } from './demo-page-data';
import { createDemoConversations } from './demo-sidebar';

export { DEMO_ACTIVE_CONVERSATION_ID } from './demo-sidebar';

/** The payload ChatShell reads: the page payload plus the sample conversations. */
export function createDemoShellData(): DemoShellData {
	return { ...createDemoPageData(), conversations: createDemoConversations() };
}
