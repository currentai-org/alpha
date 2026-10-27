import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same shape as the sibling spec: stub the functions, keep the real error classes, because guard.ts
// decides every status with `instanceof`.
const { downloadCustodialFile, deleteCustodialFile } = vi.hoisted(() => ({
	downloadCustodialFile: vi.fn(),
	deleteCustodialFile: vi.fn()
}));
const { custodialStorageViewEnabledForUser } = vi.hoisted(() => ({
	custodialStorageViewEnabledForUser: vi.fn()
}));

vi.mock('$lib/chat/server/storage/custodialStorage', async (importOriginal) => ({
	...(await importOriginal<object>()),
	downloadCustodialFile,
	deleteCustodialFile
}));
vi.mock('$lib/chat/server/storage/custodialStorageGate', () => ({
	CUSTODIAL_STORAGE_VIEW_FLAG: 'custodial-storage-view',
	custodialStorageViewEnabledForUser
}));

import { OwnershipMismatchError } from '$lib/chat/server/storage/custodialBucket';

import { DELETE, GET } from './+server';

const ACCOUNT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_ID = 'cccccccccccccccccccccccc';

function locals(signedIn = true) {
	return signedIn ? { user: { _id: { toString: () => ACCOUNT_ID } } } : {};
}
function url(path: string): URL {
	return new URL(`http://localhost/chat/api/storage/file?path=${encodeURIComponent(path)}`);
}
const MINE = `users/${ACCOUNT_ID}/documents/notes.txt`;

beforeEach(() => {
	vi.clearAllMocks();
	custodialStorageViewEnabledForUser.mockResolvedValue(true);
	deleteCustodialFile.mockResolvedValue(undefined);
	// The blob carries a RENDERABLE type on purpose. An untyped fixture makes the content-type assertion below
	// vacuous: `blob.type || "application/octet-stream"` still yields octet-stream when `blob.type` is "", so
	// the test would pass against broken code.
	downloadCustodialFile.mockResolvedValue(
		new Blob([new Uint8Array([1, 2, 3])], { type: 'text/html' })
	);
});

describe('download refuses to describe the bytes it serves', () => {
	it('forces attachment so an uploaded .html can never render on our own origin', async () => {
		// The hazard is stored XSS: a rendered page from this origin runs with our cookies and our
		// session. Nothing here has been scanned either (CUR-1130's open half), so the disposition is
		// what keeps "we stored something malicious" from becoming "we executed it".
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res = await GET({ locals: locals(), url: url(`users/${ACCOUNT_ID}/documents/evil.html`) });
		expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
	});

	it('sends ONE fixed content type, never the file\'s own — a sniffed type echoed back undoes the point', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res = await GET({ locals: locals(), url: url(`users/${ACCOUNT_ID}/documents/evil.svg`) });
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('leaves an uploader-controlled filename unable to terminate the header or escape the quotes', async () => {
		// The filename is the one field on this response an uploader fully controls, so the contract is
		// about STRUCTURE, not about which words survive: no raw CR/LF anywhere, and nothing inside the
		// quoted `filename` that could close it early. `Set-Cookie` appearing as inert text in a value
		// that cannot be broken out of is not a finding — asserting its absence would test spelling.
		// CR/LF can no longer reach this header (the next test), so the quote and semicolon carry it.
		const nasty = 'a";Set-Cookie: x=1;.txt';
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res = await GET({ locals: locals(), url: url(`users/${ACCOUNT_ID}/documents/${nasty}`) });
		const cd = res.headers.get('content-disposition') ?? '';

		expect(cd).not.toMatch(/[\r\n]/);

		const quoted = /filename="([^"]*)"/.exec(cd)?.[1];
		expect(quoted).toBeDefined();
		// Nothing left in the quoted form that ends it early or escapes the next character.
		expect(quoted).not.toMatch(/["\\;]/);

		// The real name survives, percent-encoded, where a client that understands RFC 5987 can read it.
		expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(nasty)}`);
	});

	it('refuses a filename carrying CR or LF with 400, so it never reaches the header or storage (CUR-3180)', async () => {
		await expect(
			// @ts-expect-error - RequestEvent is heavier than this test needs
			GET({ locals: locals(), url: url(`users/${ACCOUNT_ID}/documents/a";\r\nSet-Cookie: x=1;.txt`) })
		).rejects.toMatchObject({ status: 400 });
		expect(downloadCustodialFile).not.toHaveBeenCalled();
	});

	it('keeps someone else\'s bytes out of a shared cache', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res = await GET({ locals: locals(), url: url(MINE) });
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});
});

describe('one shared bucket credential means the path check is the whole boundary', () => {
	it('answers 403 for a path naming another person, rather than the file', async () => {
		// There is no per-user credential underneath this path check, so it is the whole boundary
		// (CUR-1276).
		downloadCustodialFile.mockRejectedValue(new OwnershipMismatchError(ACCOUNT_ID, OTHER_ID));
		await expect(
			// @ts-expect-error - RequestEvent is heavier than this test needs
			GET({ locals: locals(), url: url(`users/${OTHER_ID}/documents/theirs.txt`) })
		).rejects.toMatchObject({ status: 403 });
	});

	it('answers 403 on DELETE too, so the read path is not the only guarded one', async () => {
		deleteCustodialFile.mockRejectedValue(new OwnershipMismatchError(ACCOUNT_ID, OTHER_ID));
		await expect(
			// @ts-expect-error - RequestEvent is heavier than this test needs
			DELETE({ locals: locals(), url: url(`users/${OTHER_ID}/documents/theirs.txt`) })
		).rejects.toMatchObject({ status: 403 });
	});

	it('refuses an anonymous caller before any bucket call', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(false), url: url(MINE) })).rejects.toMatchObject({ status: 401 });
		expect(downloadCustodialFile).not.toHaveBeenCalled();
	});

	it('answers 404 when the flag is off, matching the rest of the surface', async () => {
		custodialStorageViewEnabledForUser.mockResolvedValue(false);
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(), url: url(MINE) })).rejects.toMatchObject({ status: 404 });
	});
});

describe('missing input and missing files', () => {
	it('answers 400 with no path parameter', async () => {
		await expect(
			// @ts-expect-error - RequestEvent is heavier than this test needs
			GET({ locals: locals(), url: new URL('http://localhost/chat/api/storage/file') })
		).rejects.toMatchObject({ status: 400 });
	});

	it('answers 404 when the bucket has no such file — ownership already passed', async () => {
		downloadCustodialFile.mockResolvedValue(null);
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(), url: url(MINE) })).rejects.toMatchObject({ status: 404 });
	});
});

describe('a path with a dot segment is refused, never resolved (CUR-3180)', () => {
	const WALKED = `users/${ACCOUNT_ID}/documents/../quarantine/1700000000000-bad.png`;

	it('rejects a download path with a .. segment with 400 instead of resolving it, and never reaches storage', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(), url: url(WALKED) })).rejects.toMatchObject({ status: 400 });
		expect(downloadCustodialFile).not.toHaveBeenCalled();
	});

	it('rejects a delete path with a .. segment with 400 instead of resolving it, and never reaches storage', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(DELETE({ locals: locals(), url: url(WALKED) })).rejects.toMatchObject({ status: 400 });
		expect(deleteCustodialFile).not.toHaveBeenCalled();
	});

	it('rejects a lone . segment and a backslash-separated .. the same way', async () => {
		for (const p of [`users/${ACCOUNT_ID}/./notes.txt`, `users/${ACCOUNT_ID}/documents\\..\\quarantine\\x.png`]) {
			// @ts-expect-error - RequestEvent is heavier than this test needs
			await expect(GET({ locals: locals(), url: url(p) })).rejects.toMatchObject({ status: 400 });
		}
		expect(downloadCustodialFile).not.toHaveBeenCalled();
	});

	// `%252e%252e` on the wire decodes once to `%2e%2e`, which posix.normalize reads
	// as a name and a URL parser collapses to `..` on the way to the bucket.
	it.each(['%2e', '%2e%2e', '.%2e', '%2e.', '%2E%2E'])(
		'rejects the percent-encoded dot segment %s with 400, and never reaches storage',
		async (seg) => {
			const p = `users/${ACCOUNT_ID}/x/${seg}/quarantine/1700000000000-bad.png`;
			// @ts-expect-error - RequestEvent is heavier than this test needs
			await expect(GET({ locals: locals(), url: url(p) })).rejects.toMatchObject({ status: 400 });
			// @ts-expect-error - RequestEvent is heavier than this test needs
			await expect(DELETE({ locals: locals(), url: url(p) })).rejects.toMatchObject({ status: 400 });
			expect(downloadCustodialFile).not.toHaveBeenCalled();
			expect(deleteCustodialFile).not.toHaveBeenCalled();
		}
	);

	it('rejects a backslash anywhere, since a URL parser reads it as a separator', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(), url: url(`users/${ACCOUNT_ID}/quarantine\\1-bad.png`) })).rejects.toMatchObject({
			status: 400,
		});
		expect(downloadCustodialFile).not.toHaveBeenCalled();
	});

	it('passes an ordinary path through to storage unchanged', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await GET({ locals: locals(), url: url(MINE) });
		expect(downloadCustodialFile).toHaveBeenCalledWith(ACCOUNT_ID, MINE);
	});
});
