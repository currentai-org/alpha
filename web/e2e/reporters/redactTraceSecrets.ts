// A Playwright trace records every request's final headers, including the ones a page.route()
// handler adds, so the secret headers signIn.ts and faultInjection.ts install travel into
// trace.zip in plaintext (CUR-2918). Every workflow that uploads test output then publishes them as an
// Actions artifact; `::add-mask::` only scrubs logs.
//
// This reporter rewrites each trace attachment as its test ends, replacing every secret value with
// a fixed marker, before any upload step runs. Scrubbing the file rather than keeping the header out
// of the trace covers every spec and every workflow at once, and the tour's cursor still has the
// whole trace to travel between.

import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** The env vars whose values reach the browser: as a request header, or typed into a page, which
 *  the trace records in the fill step and the request body (storage-locations.spec.ts links a
 *  bucket by filling E2E_LINKED_BUCKET_TOKEN). A secret used only from Node never enters a trace. */
export const TRACE_SECRET_ENV = [
	'E2E_OTP_BYPASS_TOKEN',
	'E2E_FAULT_INJECT_TOKEN',
	'E2E_LINKED_BUCKET_TOKEN'
] as const;

export const REDACTED = '[redacted:CUR-2918]';

function replaceAll(
	haystack: Uint8Array,
	needle: Uint8Array,
	marker: Uint8Array
): Uint8Array | null {
	const buf = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
	let at = buf.indexOf(needle);
	if (at === -1) return null;
	const parts: Buffer[] = [];
	let from = 0;
	while (at !== -1) {
		parts.push(buf.subarray(from, at), Buffer.from(marker));
		from = at + needle.byteLength;
		at = buf.indexOf(needle, from);
	}
	parts.push(buf.subarray(from));
	return new Uint8Array(Buffer.concat(parts));
}

/** Returns the zip with every occurrence of each secret replaced, or null when none occurs. Secrets
 *  shorter than 8 characters are ignored: a value that short would rewrite unrelated bytes. */
export function redactZip(zip: Uint8Array, secrets: string[]): Uint8Array | null {
	const needles = secrets.filter((s) => s.length >= 8).map((s) => new TextEncoder().encode(s));
	if (needles.length === 0) return null;
	const marker = new TextEncoder().encode(REDACTED);
	const entries = unzipSync(zip);
	let changed = false;
	for (const [name, data] of Object.entries(entries)) {
		let current = data;
		for (const needle of needles) {
			const next = replaceAll(current, needle, marker);
			if (next) {
				current = next;
				changed = true;
			}
		}
		entries[name] = current;
	}
	return changed ? zipSync(entries) : null;
}

export function traceSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	return TRACE_SECRET_ENV.map((k) => env[k]).filter((v): v is string => !!v);
}

// A credential minted at runtime has no env var: the session cookie signInAsFreshUser hands the
// browser, a cookie the app sets, an Authorization header. These are found by where Playwright records
// them: a cookie object ({name, value, domain|path}, as addCookies takes) and a header entry
// ({name, value}) named below. Every copy of each value is then replaced, including in snapshots.
const CREDENTIAL_HEADERS = new Set([
	'cookie',
	'set-cookie',
	'authorization',
	'proxy-authorization'
]);

function headerCredentials(name: string, value: string): string[] {
	if (name === 'authorization' || name === 'proxy-authorization') {
		return [value, value.replace(/^\S+\s+/, '')];
	}
	// `Cookie: a=1; b=2` lists pairs; each `Set-Cookie` line is one pair and then its attributes.
	const pairs =
		name === 'cookie' ? value.split(';') : value.split('\n').map((l) => l.split(';')[0]);
	return pairs.map((p) => p.slice(p.indexOf('=') + 1).trim());
}

function collect(node: unknown, out: Set<string>): void {
	if (Array.isArray(node)) {
		for (const n of node) collect(n, out);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const o = node as Record<string, unknown>;
	if (typeof o.name === 'string' && typeof o.value === 'string') {
		const name = o.name.toLowerCase();
		if ('domain' in o || 'path' in o || 'url' in o) out.add(o.value);
		else if (CREDENTIAL_HEADERS.has(name))
			for (const v of headerCredentials(name, o.value)) out.add(v);
	}
	for (const v of Object.values(o)) collect(v, out);
}

/** Credential values in a trace's event and network logs, with their URL-encoded and decoded forms. */
export function traceCredentials(entries: Record<string, Uint8Array>): string[] {
	const found = new Set<string>();
	for (const [name, data] of Object.entries(entries)) {
		if (!/\.(trace|network)$/.test(name)) continue;
		for (const line of new TextDecoder().decode(data).split('\n')) {
			if (!line) continue;
			try {
				collect(JSON.parse(line), found);
			} catch {
				// A truncated last line (a test killed mid-write) holds nothing this can parse.
			}
		}
	}
	const variants = new Set<string>();
	for (const v of found) {
		variants.add(v);
		variants.add(encodeURIComponent(v));
		try {
			variants.add(decodeURIComponent(v));
		} catch {
			// not URL-encoded
		}
	}
	return [...variants].filter((v) => v.length >= 8);
}

/** The trace with every env secret and every credential found in it replaced, or null when none occurs. */
export function redactTrace(zip: Uint8Array, secrets: string[]): Uint8Array | null {
	return redactZip(zip, [...secrets, ...traceCredentials(unzipSync(zip))]);
}

export default class RedactTraceSecretsReporter implements Reporter {
	private readonly secrets = traceSecrets();

	onTestEnd(_test: TestCase, result: TestResult): void {
		for (const a of result.attachments) {
			if (a.name !== 'trace' || !a.path) continue;
			const redacted = redactTrace(readFileSync(a.path), this.secrets);
			if (redacted) writeFileSync(a.path, redacted);
		}
	}
}
