/**
 * Dev-only replay of the welcome (account menu → Replay welcome). The server never clears
 * `welcomeModalSeenAt` once set, so this is a client-side override for the current tab: ChatWindow
 * shows the welcome while it's true, and closing the welcome sets it back to false.
 */
class WelcomeReplayStore {
	open = $state(false);
}

export const welcomeReplay = new WelcomeReplayStore();
