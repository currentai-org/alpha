// The unlocked history identity for this page, shared between the key flows that unlock it
// (HistoryKeyFlows) and the readers that open sealed conversations with it.
// Memory only, as historyIdentity.ts asks: nothing here is written to storage, and a reload starts
// locked until the device key opens the wrap again. Letting go of an identity also drops every body and
// preprompt this tab opened or sent (`forgetOpened`), so none of it outlives the account.

import { forgetOpened } from './openedHistory';

let held = $state<{ owner: string; identity: string } | null>(null);
/** The session's owner `keepOnlyFor` last saw, so a change drops what a locked tab sent, too. */
let sessionOwner: string | null = null;
let epoch = $state(0);
let unlockAsks = $state(0);

export const historyKeyring = {
	/** The unlocked identity, or null while this browser has not unlocked. */
	get identity(): string | null {
		return held?.identity ?? null;
	},
	/** Whose identity is held (`historyKeyOwner`), or null. */
	get owner(): string | null {
		return held?.owner ?? null;
	},
	/** Bumps whenever the held identity changes, so a cache of what it opened can key on it without
	 *  keeping a copy of the identity. */
	get epoch(): number {
		return epoch;
	},
	/** Bumps each time a locked placeholder asks for the unlock prompt; HistoryKeyFlows watches it. */
	get unlockAsks(): number {
		return unlockAsks;
	},
	/** Hold the identity a device key, recovery key or passkey just opened. Returns whether it changed. */
	hold(owner: string, identity: string): boolean {
		if (held?.owner === owner && held.identity === identity) return false;
		if (held && held.owner !== owner) forgetOpened();
		held = { owner, identity };
		epoch += 1;
		return true;
	},
	/** Forget it, as on sign-out or when the browser is forgotten. */
	clear(): void {
		if (!held) return;
		forgetOpened();
		held = null;
		epoch += 1;
	},
	/** Forget an identity held for anyone but `owner`: the session's user changed without a reload. */
	keepOnlyFor(owner: string): void {
		if (held && held.owner !== owner) this.clear();
		else if (sessionOwner !== null && sessionOwner !== owner) forgetOpened();
		sessionOwner = owner;
	},
	/** Ask for the unlock prompt again, after "Not now" closed it. */
	askToUnlock(): void {
		unlockAsks += 1;
	}
};
