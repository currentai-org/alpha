import { afterEach, describe, expect, it } from 'vitest';
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import {
	generateDeviceKey,
	generateRecoveryKey,
	loadDeviceKey,
	forgetDeviceKey,
	storeDeviceKey,
	unlockHistoryIdentity
} from './historyIdentity';
import {
	addWayIn,
	enrollHistoryKey,
	enrollOrJoinHistoryKey,
	ensureGuestHistoryKey,
	forgetThisBrowser,
	historyKeyOwner,
	readHistoryKeyState,
	recoveryKeyMatches,
	removeWayIn,
	unlockAndAddThisBrowser,
	type HistoryKeyApi,
	type StoredHistoryKey
} from './historyKeyClient';

// Enrollment and unlock in a real Chromium, so WebCrypto X25519 and IndexedDB are the
// browser's own. The server is the one stand-in: an in-memory key route with the same contract as
// api/v2/keys/history, including compare-and-set on `replaces` and a fixed recipient, so a test can see
// a lost update refused the way the real route refuses it.

/** What historyKeyApi throws for a 409. */
const conflict = (message: string) => Object.assign(new Error(message), { code: 'conflict', status: 409 });

function fakeKeyRoute() {
	let current: { wrapped: Uint8Array; recipient: string } | null = null;
	// Every wrap ever stored, oldest first, as the real route keeps them.
	const kept: { id: string; wrapped: Uint8Array; hash: string }[] = [];
	const hashOf = async (b: Uint8Array) =>
		Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) =>
			x.toString(16).padStart(2, '0')
		).join('');
	let puts = 0;
	const generationReads: string[] = [];
	const api: HistoryKeyApi = {
		async get() {
			if (!current) return null;
			const hash = await hashOf(current.wrapped);
			const generations = kept
				.filter((g) => g.hash !== hash)
				.reverse()
				.map(({ id, hash }, i) => ({ id, hash, at: i }));
			return { ...current, hash, generations };
		},
		async generation(id) {
			generationReads.push(id);
			const g = kept.find((k) => k.id === id);
			return g && current ? { wrapped: g.wrapped, recipient: current.recipient, hash: g.hash } : null;
		},
		async put({ wrapped, recipient, replaces }) {
			puts++;
			if (current) {
				if (current.recipient !== recipient) throw conflict('recipient changed');
				if (replaces !== (await hashOf(current.wrapped))) throw conflict('stale wrap');
			}
			current = { wrapped, recipient };
			kept.push({ id: `g${kept.length}`, wrapped, hash: await hashOf(wrapped) });
		}
	};
	return { api, puts: () => puts, generationReads };
}

/** An age file to a key nobody holds: what a stolen session can upload, passing every server check. */
async function junkWrap(): Promise<Uint8Array> {
	const e = new Encrypter();
	e.addRecipient(await identityToRecipient(await generateX25519Identity()));
	return e.encrypt('junk');
}

const OWNER = historyKeyOwner('aaaaaaaaaaaaaaaaaaaaaaaa');

afterEach(async () => {
	await forgetDeviceKey(OWNER);
	await forgetDeviceKey(`${OWNER}#pending`);
	await forgetDeviceKey(historyKeyOwner(null));
});

describe('the recovery step and the unlock prompt', () => {
	it('reads none before enrollment, and unlocked in the browser that enrolled', async () => {
		const { api } = fakeKeyRoute();
		expect((await readHistoryKeyState(api, OWNER)).kind).toBe('none');
		const { recipient } = await generateRecoveryKey();
		await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient, label: 'Recovery key' }, 'Chrome');
		const state = await readHistoryKeyState(api, OWNER);
		expect(state.kind).toBe('unlocked');
		if (state.kind !== 'unlocked') return;
		expect(state.unlocked.recipients.map((r) => r.kind).sort()).toEqual(['device', 'recovery']);
	});

	it('a second tab that loses the enrollment race leaves the first tab\'s device key in place (review of 2c57e846d)', async () => {
		const { api } = fakeKeyRoute();
		// Both tabs read "none"; tab A enrolls device-only first.
		await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Tab A');
		// Tab B's PUT is a 409, since the account now has a different recipient.
		await expect(enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Tab B')).rejects.toMatchObject({
			code: 'conflict'
		});
		const state = await readHistoryKeyState(api, OWNER);
		expect(state.kind, "the losing tab overwrote the device key that opens the server's wrap").toBe(
			'unlocked'
		);
		expect(await loadDeviceKey(`${OWNER}#pending`)).toBeNull();
	});

	it('a recovery key saved in a second tab that lost the race is added to the key the first tab stored, and opens it (review of 913477832)', async () => {
		const { api } = fakeKeyRoute();
		// Both tabs showed the step; tab A accepts loss first.
		await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Tab A');
		// Tab B saves a recovery key: its PUT is a 409, and the key it saved must still be kept.
		const { recoveryKey, recipient } = await generateRecoveryKey();
		const joined = await enrollOrJoinHistoryKey(
			api,
			OWNER,
			{ kind: 'recovery', recipient, label: 'Recovery key' },
			'Tab B'
		);
		expect(joined.unlocked.recipients.map((r) => r.kind).sort()).toEqual(['device', 'recovery']);
		// A fresh browser opens the account's key with tab B's recovery key.
		await forgetDeviceKey(OWNER);
		const locked = await readHistoryKeyState(api, OWNER);
		expect(locked.kind).toBe('locked');
		if (locked.kind !== 'locked') return;
		const after = await unlockAndAddThisBrowser(api, OWNER, locked.stored, { kind: 'recovery', recoveryKey }, 'New');
		expect(after.unlocked.recipients.map((r) => r.label)).toContain('Recovery key');
	});

	it('a second tab whose browser cannot open the key that won says not_kept, never a quiet success', async () => {
		const { api } = fakeKeyRoute();
		await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Other browser');
		// This browser has no device key for what the other browser stored.
		await forgetDeviceKey(OWNER);
		const { recipient } = await generateRecoveryKey();
		await expect(
			enrollOrJoinHistoryKey(api, OWNER, { kind: 'recovery', recipient, label: 'Recovery key' }, 'Here')
		).rejects.toMatchObject({ code: 'not_kept' });
	});

	it('a pending device key whose PUT landed is promoted on the next read', async () => {
		const { api } = fakeKeyRoute();
		await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'D');
		// As if the page closed between the PUT and the promotion: the key sits only in the pending slot.
		const key = (await loadDeviceKey(OWNER))!;
		await storeDeviceKey(`${OWNER}#pending`, key);
		await forgetDeviceKey(OWNER);
		expect((await readHistoryKeyState(api, OWNER)).kind).toBe('unlocked');
		expect(await loadDeviceKey(OWNER)).not.toBeNull();
		expect(await loadDeviceKey(`${OWNER}#pending`)).toBeNull();
	});

	it('accepting loss wraps to this browser alone', async () => {
		const { api } = fakeKeyRoute();
		const state = await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Chrome');
		expect(state.unlocked.recipients.map((r) => r.kind)).toEqual(['device']);
	});

	it('a browser without the device key reads locked, unlocks with the recovery key, and opens on its own after', async () => {
		const { api } = fakeKeyRoute();
		const { recoveryKey, recipient } = await generateRecoveryKey();
		await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient, label: 'Recovery key' }, 'First');
		// A fresh browser: this one's device key gone.
		await forgetDeviceKey(OWNER);
		const locked = await readHistoryKeyState(api, OWNER);
		expect(locked.kind).toBe('locked');
		if (locked.kind !== 'locked') return;

		const after = await unlockAndAddThisBrowser(
			api,
			OWNER,
			locked.stored,
			{ kind: 'recovery', recoveryKey },
			'Second'
		);
		expect(after.unlocked.recipients.map((r) => r.label).sort()).toEqual(['First', 'Recovery key', 'Second']);
		const reread = await readHistoryKeyState(api, OWNER);
		expect(reread.kind, 'the new device key does not open the rewrapped key').toBe('unlocked');
	});

	it('refuses a recovery key that is not on the wrap, and stores nothing', async () => {
		const { api, puts } = fakeKeyRoute();
		const { recipient } = await generateRecoveryKey();
		await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient, label: 'R' }, 'First');
		await forgetDeviceKey(OWNER);
		const locked = await readHistoryKeyState(api, OWNER);
		if (locked.kind !== 'locked') throw new Error('expected locked');
		const wrong = await generateRecoveryKey();
		await expect(
			unlockAndAddThisBrowser(api, OWNER, locked.stored, { kind: 'recovery', recoveryKey: wrong.recoveryKey }, 'X')
		).rejects.toMatchObject({ code: 'not_for_this_unlocker' });
		expect(puts()).toBe(1);
	});

	it('a rewrap that lost the race to another browser is applied again to what that browser wrote', async () => {
		const { api } = fakeKeyRoute();
		const first = await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'First');
		// Another browser adds a recovery key from the same read, after ours was read.
		const other = await generateRecoveryKey();
		await addWayIn(api, OWNER, first, { kind: 'recovery', recipient: other.recipient, label: 'Other' });
		// Ours still holds the older `stored`, so its PUT is a 409 and is retried on the fresh copy.
		const mine = await generateRecoveryKey();
		const result = await addWayIn(api, OWNER, first, { kind: 'recovery', recipient: mine.recipient, label: 'Mine' });
		expect(result.unlocked.recipients.map((r) => r.label).sort()).toEqual(['First', 'Mine', 'Other']);
		const stored = (await api.get()) as StoredHistoryKey;
		const opened = await unlockHistoryIdentity(stored.wrapped, { kind: 'recovery', recoveryKey: other.recoveryKey }, stored.recipient);
		expect(opened.recipients).toHaveLength(3);
	});

	it('removing a way in stops it opening the key, and the last way in is refused', async () => {
		const { api } = fakeKeyRoute();
		const rec = await generateRecoveryKey();
		const state = await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient: rec.recipient, label: 'R' }, 'D');
		const recovery = state.unlocked.recipients.find((r) => r.kind === 'recovery')!;
		const fewer = await removeWayIn(api, OWNER, state, recovery);
		expect(fewer.unlocked.recipients.map((r) => r.kind)).toEqual(['device']);
		const stored = (await api.get()) as StoredHistoryKey;
		await expect(
			unlockHistoryIdentity(stored.wrapped, { kind: 'recovery', recoveryKey: rec.recoveryKey }, stored.recipient)
		).rejects.toMatchObject({ code: 'not_for_this_unlocker' });
		await expect(removeWayIn(api, OWNER, fewer, fewer.unlocked.recipients[0])).rejects.toMatchObject({
			code: 'last_recipient'
		});
	});

	it('forgetting this browser takes its device key off the wrap and out of IndexedDB', async () => {
		const { api } = fakeKeyRoute();
		const rec = await generateRecoveryKey();
		const state = await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient: rec.recipient, label: 'R' }, 'D');
		await forgetThisBrowser(api, OWNER, state);
		expect(await loadDeviceKey(OWNER)).toBeNull();
		const stored = (await api.get()) as StoredHistoryKey;
		const opened = await unlockHistoryIdentity(stored.wrapped, { kind: 'recovery', recoveryKey: rec.recoveryKey }, stored.recipient);
		expect(opened.recipients.map((r) => r.kind)).toEqual(['recovery']);
	});

	it('a guest gets a device key once, and a second call stores nothing', async () => {
		const { api, puts } = fakeKeyRoute();
		await ensureGuestHistoryKey(api, 'Chrome');
		await ensureGuestHistoryKey(api, 'Chrome');
		expect(puts()).toBe(1);
		expect((await readHistoryKeyState(api, historyKeyOwner(null))).kind).toBe('unlocked');
	});
});

describe('recoveryKeyMatches', () => {
	it('matches the key typed back with spaces or in lower case, and never an empty answer', () => {
		expect(recoveryKeyMatches('AGE-SECRET-KEY-PQ-1ABC', ' age-secret-key-pq-1abc ')).toBe(true);
		expect(recoveryKeyMatches('AGE-SECRET-KEY-PQ-1ABC', 'AGE-SECRET-KEY-PQ-1ABD')).toBe(false);
		expect(recoveryKeyMatches('', '')).toBe(false);
	});
});

describe('unlock falls back through older wrap generations', () => {
	/** Two junk rewraps by a session that holds no key: each names the current hash, as GET returns it. */
	async function twoJunkRewraps(api: HistoryKeyApi) {
		for (let i = 0; i < 2; i++) {
			const now = await api.get();
			await api.put({ wrapped: await junkWrap(), recipient: now!.recipient, replaces: now!.hash });
		}
	}

	it('opens with the device key when the newest generation is junk, and reports the older generation it used', async () => {
		const { api, generationReads } = fakeKeyRoute();
		const enrolled = await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Chrome');
		await twoJunkRewraps(api);
		const state = await readHistoryKeyState(api, OWNER);
		expect(state.kind, 'two junk wraps locked the owner out of a key their device key opens').toBe('unlocked');
		if (state.kind !== 'unlocked') return;
		expect(state.unlocked.identity).toBe(enrolled.unlocked.identity);
		expect(state.opened).toEqual({ hash: enrolled.stored.hash, id: 'g0', newest: false });
		// The newest junk generation is the current wrap; the next junk one is tried, then the real one.
		expect(generationReads).toEqual(['g1', 'g0']);
		expect(state.stored.hash, 'a rewrap must still replace the newest wrap').not.toBe(enrolled.stored.hash);
	});

	it('reports the newest generation when it opens, reading no older one', async () => {
		const { api, generationReads } = fakeKeyRoute();
		await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Chrome');
		const state = await readHistoryKeyState(api, OWNER);
		expect(state.kind === 'unlocked' && state.opened.newest).toBe(true);
		expect(generationReads).toEqual([]);
	});

	it('reads locked, not unlocked, when no generation opens with this browser', async () => {
		const { api } = fakeKeyRoute();
		await enrollHistoryKey(api, OWNER, { kind: 'device-only' }, 'Other browser');
		// This browser holds a device key, but one no generation was ever wrapped to.
		await storeDeviceKey(OWNER, (await generateDeviceKey()).key);
		await twoJunkRewraps(api);
		expect((await readHistoryKeyState(api, OWNER)).kind).toBe('locked');
	});

	it('a device key removed from the wrap on purpose reads locked, even with junk uploaded after the removal', async () => {
		const { api } = fakeKeyRoute();
		const { recipient } = await generateRecoveryKey();
		const enrolled = await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient, label: 'Recovery key' }, 'Lost laptop');
		const laptop = enrolled.unlocked.recipients.find((r) => r.kind === 'device')!;
		// The person, from another browser, takes the lost laptop out; this browser still holds its key.
		await removeWayIn(api, OWNER, enrolled, laptop);
		expect((await readHistoryKeyState(api, OWNER)).kind, 'a removed device key opened an older generation').toBe('locked');
		await twoJunkRewraps(api);
		expect((await readHistoryKeyState(api, OWNER)).kind, 'junk after a removal brought the removed key back').toBe('locked');
	});

	it('a recovery key opens past junk newest wraps, and adding this browser replaces the junk with a wrap that opens', async () => {
		const { api } = fakeKeyRoute();
		const { recoveryKey, recipient } = await generateRecoveryKey();
		const enrolled = await enrollHistoryKey(api, OWNER, { kind: 'recovery', recipient, label: 'Recovery key' }, 'Old');
		await forgetDeviceKey(OWNER);
		await twoJunkRewraps(api);
		const locked = await readHistoryKeyState(api, OWNER);
		expect(locked.kind).toBe('locked');
		if (locked.kind !== 'locked') return;
		const after = await unlockAndAddThisBrowser(api, OWNER, locked.stored, { kind: 'recovery', recoveryKey }, 'New');
		expect(after.opened).toMatchObject({ hash: enrolled.stored.hash, newest: false });
		const newest = await api.get();
		const reopened = await unlockHistoryIdentity(newest!.wrapped, { kind: 'recovery', recoveryKey }, newest!.recipient);
		expect(reopened.identity).toBe(enrolled.unlocked.identity);
	});
});
