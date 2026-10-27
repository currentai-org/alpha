import { unzipSync } from 'fflate';
import postgres from 'postgres';

/** One entry of the export archive, decoded to text. */
export type Archive = Record<string, string>;

/**
 * Open an export ZIP in memory.
 *
 * `fflate` rather than `yauzl` (the read counterpart to the `yazl` the export route writes with):
 * this needs one synchronous call returning every entry, not a stream of entry events that has to
 * be drained and reassembled before a single assertion can run.
 */
export function openArchive(body: Buffer): Archive {
	const entries = unzipSync(new Uint8Array(body));
	const out: Archive = {};
	for (const [name, bytes] of Object.entries(entries)) {
		out[name] = new TextDecoder().decode(bytes);
	}
	return out;
}

/**
 * The conversation row as the database actually holds it — the thing the archive is supposed to be
 * a faithful copy of.
 *
 * Raw `postgres`, matching otp.ts's own note on why this suite reads Neon directly rather than
 * pulling in the app's typed schema for a single query. The table keys on a text `id` column; the
 * document's own `_id` lives inside the jsonb and is NOT what this looks up (a `doc->>'_id'`
 * predicate returns zero rows here, which reads as "the export lost the conversation" rather than
 * as a wrong query).
 */
export async function readConversationDoc(
	databaseUrl: string,
	conversationId: string
): Promise<Record<string, unknown>> {
	const sql = postgres(databaseUrl, { ssl: 'require', max: 1 });
	try {
		for (let attempt = 0; attempt < 10; attempt++) {
			const rows = await sql<{ doc: Record<string, unknown> }[]>`
				select doc from conversations where id = ${conversationId} limit 1
			`;
			if (rows[0]) return rows[0].doc;
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error(`no conversations row for id ${conversationId} after 5s`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

/**
 * Collapse the extended-JSON markers the jsonb column holds into the values a JSON serializer
 * produces, so a raw row can be compared against the archive built from it.
 *
 * `docStore.ts` stores every Date as `{$dt: iso}` and every ObjectId as `{$oid: hex}`, recursively,
 * because a plain JSONB cast would lose both (`docStore.ts:14`). The export route reads through that
 * same adapter, so by the time `JSON.stringify` writes `conversations.json` the markers have been
 * revived and re-serialized: `{$dt: iso}` arrives in the archive as the bare ISO string, `{$oid: hex}`
 * as the bare hex string. Comparing raw jsonb against the archive without this step reports every
 * timestamp as a mismatch while both sides name the same instant.
 *
 * Deliberately NOT `fromStorage` imported from the app. The archive is already the output of that
 * function; decoding the expected side with it too would make a bug in it cancel out on both sides
 * and the comparison green. This reimplements the marker contract instead, so a change to how
 * storage encodes dates has to be made here as well before this test passes again.
 */
export function decodeStorageMarkers<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(decodeStorageMarkers) as T;
	const keys = Object.keys(value);
	if (keys.length === 1 && (keys[0] === '$dt' || keys[0] === '$oid')) {
		return (value as Record<string, unknown>)[keys[0]] as T;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = decodeStorageMarkers(v);
	return out as T;
}
