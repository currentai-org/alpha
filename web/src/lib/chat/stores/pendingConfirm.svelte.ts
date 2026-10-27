import { SvelteSet } from "svelte/reactivity";

/**
 * Which agent confirmations are open and still unanswered, right now.
 *
 * A paused tool call renders a card inside the message body and nowhere else (no title change, no
 * badge, no sound), so a person with the tab in the background has the whole timeout window
 * (AGENT_CONFIRM_TIMEOUT_SECS) to notice something that produces no signal. This store counts the open
 * prompts so the tab can signal one.
 *
 * A SET of ids rather than a counter. A turn can pause more than once, `AgentConfirmPrompt` stays
 * mounted across its own resolution (the `decision` prop changes under it rather than the component
 * being replaced), and a card can re-register on reconnect — all three double-count against a bare
 * `count++`, and an unmount racing a resolve drives it negative. Membership is idempotent under every
 * one of those.
 */
class PendingConfirmStore {
	#ids = new SvelteSet<string>();

	/** How many confirmations are open and unanswered. 0 when the chat is not waiting on anybody. */
	get count(): number {
		return this.#ids.size;
	}

	open(confirmId: string): void {
		this.#ids.add(confirmId);
	}

	resolve(confirmId: string): void {
		this.#ids.delete(confirmId);
	}
}

export const pendingConfirm = new PendingConfirmStore();

/**
 * The document title to show, given the page's own title and how many confirmations are waiting.
 *
 * Pure, and separate from the store, so the thing worth pinning down — that the count reaches the tab
 * and that nothing is appended when there is nothing to answer — is testable without a DOM. The count
 * leads because a tab strip truncates from the right, so anything after the first few characters is
 * the part a person in another window never sees.
 */
export function confirmTitle(baseTitle: string, count: number): string {
	if (count <= 0) return baseTitle;
	// The literal lives here and nowhere else. Exporting it so the spec could import it would have
	// made the spec assert this function against its own definition, which passes no matter what the
	// string becomes — the test has to name the words a person will actually read in their tab.
	const label = count === 1 ? "Approval needed" : `Approval needed (${count})`;
	return `${label} — ${baseTitle}`;
}
