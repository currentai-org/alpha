import { afterEach, describe, expect, it, vi } from 'vitest';
import { Encrypter } from 'age-encryption';
import {
	addWrapRecipient,
	createPasskeyCredential,
	forgetDeviceKey,
	generateDeviceKey,
	generateHistoryIdentity,
	generateRecoveryKey,
	loadDeviceKey,
	removeWrapRecipient,
	storeDeviceKey,
	unlockHistoryIdentity,
	wrapHistoryIdentity,
	type WrapRecipient
} from './historyIdentity';

// Round trips for every way into the history key, in a real Chromium: WebCrypto X25519 and
// IndexedDB are the browser's own. Named `.svelte.spec.ts` only because that is what the `client`
// (browser) vitest project includes; there is no component here.
//
// The passkey is the one fake. No authenticator exists in a headless test, so `navigator.credentials`
// is replaced by one that answers PRF as an authenticator does: HMAC-SHA-256 under a per-credential
// secret over each salt it is given. typage's own WebAuthn recipient and identity run unchanged on top,
// so its stanza format, salts and key derivation are exercised; the browser's WebAuthn ceremony and a
// real authenticator's PRF are not.

function fakeAuthenticator() {
	const secrets = new Map<string, Uint8Array>();
	const hex = (b: ArrayBuffer | Uint8Array) =>
		Array.from(new Uint8Array(b as ArrayBuffer), (x) => x.toString(16).padStart(2, '0')).join('');
	const prf = async (secret: Uint8Array, input: BufferSource) => {
		const key = await crypto.subtle.importKey(
			'raw',
			secret as BufferSource,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		return crypto.subtle.sign('HMAC', key, input);
	};
	vi.spyOn(navigator.credentials, 'create').mockImplementation(async () => {
		const rawId = crypto.getRandomValues(new Uint8Array(16));
		secrets.set(hex(rawId), crypto.getRandomValues(new Uint8Array(32)));
		return {
			rawId: rawId.buffer,
			response: { getTransports: () => ['internal'] },
			getClientExtensionResults: () => ({ prf: { enabled: true } })
		} as unknown as Credential;
	});
	vi.spyOn(navigator.credentials, 'get').mockImplementation(async (options) => {
		const pk = options!.publicKey!;
		const id = pk.allowCredentials?.[0]?.id;
		const secret = id && secrets.get(hex(id as ArrayBuffer));
		if (!secret) throw new DOMException('no such credential', 'NotAllowedError');
		const salts = pk.extensions!.prf!.eval!;
		const results = { first: await prf(secret, salts.first), second: await prf(secret, salts.second!) };
		return { getClientExtensionResults: () => ({ prf: { results } }) } as unknown as Credential;
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await forgetDeviceKey('user:test');
});

describe('history key: each way in opens it', () => {
	it('opens with a device key that was stored in IndexedDB and read back, and the key stays non-extractable', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const device = await generateDeviceKey();
		await storeDeviceKey('user:test', device.key);
		const wrapped = await wrapHistoryIdentity(identity, [
			{ kind: 'device', label: 'This browser', recipient: device.recipient }
		]);

		const loaded = await loadDeviceKey('user:test');
		expect(loaded).not.toBeNull();
		expect(loaded!.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('pkcs8', loaded!)).rejects.toThrow();

		const unlocked = await unlockHistoryIdentity(
			wrapped,
			{ kind: 'device', key: loaded! },
			recipient
		);
		expect(unlocked.identity).toBe(identity);
		expect(unlocked.recipient).toBe(recipient);
	});

	it('opens with the recovery key the person kept, typed back with stray whitespace', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const recovery = await generateRecoveryKey();
		const wrapped = await wrapHistoryIdentity(identity, [
			{ kind: 'recovery', label: 'Recovery key', recipient: recovery.recipient }
		]);
		const unlocked = await unlockHistoryIdentity(wrapped, {
			kind: 'recovery',
			recoveryKey: `  ${recovery.recoveryKey}\n`
		}, recipient);
		expect(unlocked.identity).toBe(identity);
	});

	it("opens with a passkey's PRF output through typage's WebAuthn recipient (authenticator stubbed)", async () => {
		fakeAuthenticator();
		const credential = await createPasskeyCredential('Alpha history', 'localhost');
		const { identity, recipient } = await generateHistoryIdentity();
		const wrapped = await wrapHistoryIdentity(identity, [
			{ kind: 'passkey', label: 'Passkey', credential }
		]);
		const unlocked = await unlockHistoryIdentity(wrapped, { kind: 'passkey', credential }, recipient);
		expect(unlocked.identity).toBe(identity);
	});

	it('opens a file wrapped to all three with any one of them alone', async () => {
		fakeAuthenticator();
		const { identity, recipient } = await generateHistoryIdentity();
		const device = await generateDeviceKey();
		const recovery = await generateRecoveryKey();
		const credential = await createPasskeyCredential('Alpha history', 'localhost');
		const wrapped = await wrapHistoryIdentity(identity, [
			{ kind: 'device', label: 'd', recipient: device.recipient },
			{ kind: 'recovery', label: 'r', recipient: recovery.recipient },
			{ kind: 'passkey', label: 'p', credential }
		]);
		for (const u of [
			{ kind: 'device' as const, key: device.key },
			{ kind: 'recovery' as const, recoveryKey: recovery.recoveryKey },
			{ kind: 'passkey' as const, credential }
		]) {
			expect((await unlockHistoryIdentity(wrapped, u, recipient)).identity).toBe(identity);
		}
	});
});

describe('history key: refusals', () => {
	it('refuses a device key the file was not wrapped to, as not_for_this_unlocker', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const mine = await generateDeviceKey();
		const other = await generateDeviceKey();
		const wrapped = await wrapHistoryIdentity(identity, [
			{ kind: 'device', label: 'mine', recipient: mine.recipient }
		]);
		await expect(
			unlockHistoryIdentity(wrapped, { kind: 'device', key: other.key }, recipient)
		).rejects.toMatchObject({ code: 'not_for_this_unlocker' });
	});

	it('refuses a wrap that opens to an identity other than the recipient the server seals to', async () => {
		const recovery = await generateRecoveryKey();
		const theirs = await generateHistoryIdentity();
		const sealedTo = await generateHistoryIdentity();
		const wrapped = await wrapHistoryIdentity(theirs.identity, [
			{ kind: 'recovery', label: 'r', recipient: recovery.recipient }
		]);
		await expect(
			unlockHistoryIdentity(
				wrapped,
				{ kind: 'recovery', recoveryKey: recovery.recoveryKey },
				sealedTo.recipient
			)
		).rejects.toMatchObject({ code: 'recipient_mismatch' });
	});

	it('refuses an age file that opens but holds no history key, as malformed', async () => {
		const recovery = await generateRecoveryKey();
		const e = new Encrypter();
		e.addRecipient(recovery.recipient);
		const wrapped = await e.encrypt('a file someone else put here');
		await expect(
			unlockHistoryIdentity(
				wrapped,
				{ kind: 'recovery', recoveryKey: recovery.recoveryKey },
				recovery.recipient
			)
		).rejects.toMatchObject({ code: 'malformed' });
	});
});

describe('history key: adding and removing a way in', () => {
	it('adds a recovery key: the new file opens with it and still with the device, same identity', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const device = await generateDeviceKey();
		const deviceWay: WrapRecipient = { kind: 'device', label: 'd', recipient: device.recipient };
		const first = await wrapHistoryIdentity(identity, [deviceWay]);
		const unlocked = await unlockHistoryIdentity(first, { kind: 'device', key: device.key }, recipient);

		const recovery = await generateRecoveryKey();
		const added = await addWrapRecipient(unlocked, {
			kind: 'recovery',
			label: 'r',
			recipient: recovery.recipient
		});
		expect(added.recipients).toHaveLength(2);
		const viaRecovery = await unlockHistoryIdentity(
			added.wrapped,
			{ kind: 'recovery', recoveryKey: recovery.recoveryKey },
			recipient
		);
		expect(viaRecovery.identity).toBe(identity);
		expect(viaRecovery.recipient).toBe(recipient);
		expect(viaRecovery.recipients).toEqual(added.recipients);
		expect(
			(await unlockHistoryIdentity(added.wrapped, { kind: 'device', key: device.key }, recipient))
				.identity
		).toBe(identity);
	});

	it('removes a device: the new file no longer opens with it, and still opens with what remains', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const lost = await generateDeviceKey();
		const recovery = await generateRecoveryKey();
		const lostWay: WrapRecipient = { kind: 'device', label: 'lost phone', recipient: lost.recipient };
		const wrapped = await wrapHistoryIdentity(identity, [
			lostWay,
			{ kind: 'recovery', label: 'r', recipient: recovery.recipient }
		]);
		const unlocked = await unlockHistoryIdentity(
			wrapped,
			{ kind: 'recovery', recoveryKey: recovery.recoveryKey },
			recipient
		);
		const after = await removeWrapRecipient(unlocked, lostWay);
		expect(after.recipients).toHaveLength(1);
		await expect(
			unlockHistoryIdentity(after.wrapped, { kind: 'device', key: lost.key }, recipient)
		).rejects.toMatchObject({ code: 'not_for_this_unlocker' });
		expect(
			(
				await unlockHistoryIdentity(
					after.wrapped,
					{ kind: 'recovery', recoveryKey: recovery.recoveryKey },
					recipient
				)
			).identity
		).toBe(identity);
	});

	it('refuses to remove the last way in, as last_recipient, rather than lock the history for good', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const recovery = await generateRecoveryKey();
		const only: WrapRecipient = { kind: 'recovery', label: 'r', recipient: recovery.recipient };
		const unlocked = await unlockHistoryIdentity(
			await wrapHistoryIdentity(identity, [only]),
			{ kind: 'recovery', recoveryKey: recovery.recoveryKey },
			recipient
		);
		await expect(removeWrapRecipient(unlocked, only)).rejects.toMatchObject({
			code: 'last_recipient'
		});
	});
});

describe('history key: a recovery key as a person types it', () => {
	async function wrappedToRecovery() {
		const { identity, recipient } = await generateHistoryIdentity();
		const recovery = await generateRecoveryKey();
		const wrapped = await wrapHistoryIdentity(identity, [
			{ kind: 'recovery', label: 'Recovery key', recipient: recovery.recipient }
		]);
		return { identity, recipient, wrapped, recoveryKey: recovery.recoveryKey };
	}

	it('opens with the key typed back in lower case and broken into groups, as the confirmation step accepts it', async () => {
		const { identity, recipient, wrapped, recoveryKey } = await wrappedToRecovery();
		const typed = recoveryKey.toLowerCase().replace(/(.{8})/g, '$1 ');
		const unlocked = await unlockHistoryIdentity(wrapped, { kind: 'recovery', recoveryKey: typed }, recipient);
		expect(unlocked.identity).toBe(identity);
	});

	it('refuses a key with a one-character typo as not_for_this_unlocker, and no part of the error carries the typed key', async () => {
		const { recipient, wrapped, recoveryKey } = await wrappedToRecovery();
		const at = recoveryKey.length - 10;
		const typo = recoveryKey.slice(0, at) + (recoveryKey[at] === 'Q' ? 'P' : 'Q') + recoveryKey.slice(at + 1);
		const err = await unlockHistoryIdentity(wrapped, { kind: 'recovery', recoveryKey: typo }, recipient).then(
			() => null,
			(e: unknown) => e as Error & { code?: string; cause?: unknown }
		);
		expect(err?.code).toBe('not_for_this_unlocker');
		const seen = [err?.message, err?.stack, String(err?.cause ?? ''), JSON.stringify(err)].join('\n');
		// 20 characters of the key's secret part is far more than any error should repeat.
		const secretPart = typo.slice('AGE-SECRET-KEY-PQ-1'.length);
		for (let i = 0; i + 20 <= secretPart.length; i += 10) {
			expect(seen.toUpperCase()).not.toContain(secretPart.slice(i, i + 20));
		}
	});
});
