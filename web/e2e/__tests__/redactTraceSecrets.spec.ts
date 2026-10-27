import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
	REDACTED,
	redactTrace,
	redactZip,
	traceCredentials,
	traceSecrets
} from '../reporters/redactTraceSecrets';

const SECRET = 'fake-bypass-value-0123456789';
const OTHER = 'fake-fault-value-abcdefghij';

function traceZip(): Uint8Array {
	return zipSync({
		'1-trace.network': strToU8(
			`{"request":{"headers":[{"name":"x-e2e-otp-bypass","value":"${SECRET}"}]}}\n` +
				`{"request":{"headers":[{"name":"x-e2e-fault-inject","value":"${OTHER}"}]}}\n`
		),
		'1-trace.trace': strToU8(`{"type":"before","params":{"headers":{"x":"${SECRET}${SECRET}"}}}`),
		'resources/abc.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
	});
}

describe('redactTraceSecrets (CUR-2918)', () => {
	it('removes every occurrence of each secret from every trace entry and keeps the rest byte-for-byte', () => {
		const out = redactZip(traceZip(), [SECRET, OTHER]);
		expect(out).not.toBeNull();
		const entries = unzipSync(out!);
		const all = Object.values(entries)
			.map((d) => strFromU8(d, true))
			.join('\n');
		expect(all).not.toContain(SECRET);
		expect(all).not.toContain(OTHER);
		expect(strFromU8(entries['1-trace.trace'])).toContain(`${REDACTED}${REDACTED}`);
		expect(strFromU8(entries['1-trace.network'])).toContain('"name":"x-e2e-otp-bypass"');
		expect([...entries['resources/abc.png']]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
	});

	it('returns null (leaves the file alone) when no secret occurs in the trace', () => {
		expect(redactZip(traceZip(), ['not-in-this-trace-at-all'])).toBeNull();
	});

	it('ignores a secret under 8 characters rather than rewriting unrelated bytes', () => {
		expect(redactZip(traceZip(), ['trace'])).toBeNull();
	});

	// A credential minted at runtime has no env var to name it: the session cookie signInAsFreshUser
	// hands the browser, and whatever the app sets or sends back. Those are found by where they sit.
	it('removes credentials found by shape: addCookies values and Cookie, Set-Cookie and Authorization headers', () => {
		const session = 'sessiontokenvalue0123.signaturepart=';
		const setCookie = 'anon-chat-id-0123456789';
		const bearer = 'bearer-token-abcdef0123456789';
		const zip = zipSync({
			'1-trace.trace': strToU8(
				`{"type":"before","method":"addCookies","params":{"cookies":[{"name":"__Secure-aip-preview.session_token","value":"${session}","domain":"example.org","path":"/"}]}}\n` +
					`{"type":"frame-snapshot","snapshot":{"html":"<p>${session}</p>"}}\n`
			),
			'1-trace.network': strToU8(
				`{"type":"resource-snapshot","snapshot":{"request":{"headers":[{"name":"Cookie","value":"a=short; __Secure-aip-preview.session_token=${encodeURIComponent(session)}"},{"name":"authorization","value":"Bearer ${bearer}"}]},"response":{"headers":[{"name":"set-cookie","value":"hf-chat=${setCookie}; Path=/; HttpOnly"}]}}}\n`
			)
		});
		const out = redactTrace(zip, []);
		expect(out).not.toBeNull();
		const all = Object.values(unzipSync(out!))
			.map((d) => strFromU8(d, true))
			.join('\n');
		for (const v of [session, encodeURIComponent(session), setCookie, bearer]) {
			expect(all, v).not.toContain(v);
		}
		expect(all).toContain('"name":"__Secure-aip-preview.session_token"');
		expect(all).toContain('a=short');
	});

	it('finds no credential in a trace with none, so the file is left alone', () => {
		const zip = zipSync({
			'1-trace.network': strToU8(
				'{"type":"resource-snapshot","snapshot":{"request":{"headers":[{"name":"accept","value":"text/html,application/json"}]}}}\n'
			)
		});
		expect(traceCredentials(unzipSync(zip))).toEqual([]);
		expect(redactTrace(zip, [])).toBeNull();
	});

	it('reads the secret values from the env vars the browser sends as headers, skipping unset ones', () => {
		expect(traceSecrets({ E2E_OTP_BYPASS_TOKEN: SECRET } as NodeJS.ProcessEnv)).toEqual([SECRET]);
		expect(
			traceSecrets({
				E2E_OTP_BYPASS_TOKEN: SECRET,
				E2E_FAULT_INJECT_TOKEN: OTHER
			} as NodeJS.ProcessEnv)
		).toEqual([SECRET, OTHER]);
	});

	it('scrubs a bucket token the spec types into a page, from the fill step and the request body', () => {
		const bucket = 'hf_fake_linked_bucket_value_0123';
		const secrets = traceSecrets({ E2E_LINKED_BUCKET_TOKEN: bucket } as NodeJS.ProcessEnv);
		expect(secrets).toEqual([bucket]);
		const zip = zipSync({
			'1-trace.trace': strToU8(`{"type":"before","method":"fill","params":{"value":"${bucket}"}}`),
			'1-trace.network': strToU8(`{"request":{"postData":"{\\"token\\":\\"${bucket}\\"}"}}`)
		});
		const out = unzipSync(redactZip(zip, secrets)!);
		for (const data of Object.values(out)) {
			expect(strFromU8(data)).not.toContain(bucket);
			expect(strFromU8(data)).toContain(REDACTED);
		}
	});
});
