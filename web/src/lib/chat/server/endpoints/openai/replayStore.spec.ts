// The replay store against a real Postgres (the server-stateful project's DATABASE_URL), so
// the SQL itself is what passes, not a mock of it. (SOL-148)
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "";
let storeUrl = url;

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/config", () => ({
	config: new Proxy({}, { get: (_t, key) => (key === "REPLAY_DATABASE_URL" ? storeUrl : "") }),
}));

const store = await import("./replayStore");
const sql = postgres(url, { max: 1 });
const HASH = "0123456789abcdef0123456789abcdef";
const HOST = "router.example.org";
const cassette = (body: string) => ({
	requestHash: HASH,
	path: "/v1/chat/completions",
	host: HOST,
	status: 200,
	headers: {},
	body,
	recordedAt: "2026-10-11T00:00:00Z",
});

beforeEach(async () => {
	storeUrl = url;
	await store.lookup("0".repeat(32), "warmup"); // creates the table on first use
	await sql`delete from model_replay`;
});
afterAll(async () => {
	await sql`drop table if exists model_replay`;
	await sql.end();
});

describe("replay store scopes (SOL-148)", () => {
	it("reads a branch's own scope and then develop's; develop reads only its own", () => {
		expect(store.readScopes("someone/sol-1-x")).toEqual(["someone/sol-1-x", "develop"]);
		expect(store.readScopes("develop")).toEqual(["develop"]);
		expect(store.replayScope({ VERCEL_GIT_COMMIT_REF: "develop" })).toBe("develop");
		expect(store.replayScope({})).toBe("local");
	});

	it("a branch hits develop's recording, and its own recording wins once it has one", async () => {
		await store.record(cassette("develop's"), "develop");
		expect((await store.lookup(HASH, "mine"))?.cassette.body).toBe("develop's");
		await store.record(cassette("mine"), "mine");
		const found = await store.lookup(HASH, "mine");
		expect(found?.scope).toBe("mine");
		expect(found?.cassette.body).toBe("mine");
	});

	it("a branch with no recording of its own or develop's hits another branch's, newest first (SOL-180)", async () => {
		await store.record(cassette("older"), "someone-else");
		await sql`update model_replay set recorded_at = now() - interval '1 hour'`;
		await store.record(cassette("newer"), "a-third");
		const found = await store.lookup(HASH, "mine", HOST);
		expect(found?.scope).toBe("a-third");
		expect(found?.cassette.body).toBe("newer");
	});

	it("a branch's own recording, then develop's, still win over another branch's (SOL-180)", async () => {
		await store.record(cassette("theirs"), "someone-else");
		await store.record(cassette("develop's"), "develop");
		expect((await store.lookup(HASH, "mine", HOST))?.cassette.body).toBe("develop's");
		await store.record(cassette("mine"), "mine");
		expect((await store.lookup(HASH, "mine", HOST))?.cassette.body).toBe("mine");
	});

	it("develop hits the recording a merged branch made for the same request and upstream, since develop's run mocks a miss instead of recording (SOL-208)", async () => {
		await store.record(cassette("the PR's"), "someone/sol-1-x");
		const found = await store.lookup(HASH, "develop", HOST);
		expect(found?.scope).toBe("someone/sol-1-x");
		expect(found?.cassette.body).toBe("the PR's");
		await store.record(cassette("develop's own"), "develop");
		expect((await store.lookup(HASH, "develop", HOST))?.cassette.body).toBe("develop's own");
	});

	it("another branch's recording made against a different upstream host, or none named, is never read (SOL-180)", async () => {
		await store.record({ ...cassette("other upstream"), host: "elsewhere.example.org" }, "someone-else");
		const { host: _h, ...hostless } = cassette("no host");
		await store.record(hostless, "a-third");
		expect(await store.lookup(HASH, "mine", HOST)).toBeNull();
		expect(await store.lookup(HASH, "mine")).toBeNull();
	});

	it("another branch's recording that is not a 2xx is never read", async () => {
		await store.record({ ...cassette("refused"), status: 429 }, "someone-else");
		expect(await store.lookup(HASH, "mine", HOST)).toBeNull();
	});

	it("a recorded 429 is read until its refusedUntil and missed after, in its own scope and another branch's (CUR-3982)", async () => {
		const now = Date.parse("2026-10-14T16:00:00Z");
		const refused = { ...cassette("busy"), status: 429, refusedUntil: "2026-10-14T16:10:00Z" };
		await store.record(refused, "someone-else");
		expect((await store.lookup(HASH, "mine", HOST, now))?.cassette.body).toBe("busy");
		expect(await store.lookup(HASH, "mine", HOST, now + 10 * 60 * 1000)).toBeNull();
		await store.record(refused, "mine");
		expect((await store.lookup(HASH, "mine", HOST, now))?.scope).toBe("mine");
		expect(await store.lookup(HASH, "mine", HOST, now + 10 * 60 * 1000)).toBeNull();
	});

	it("another branch's good recording wins over an unexpired 429, and an expired 429 of its own falls through to develop's (CUR-3982)", async () => {
		const now = Date.parse("2026-10-14T16:00:00Z");
		await store.record({ ...cassette("busy"), status: 429, refusedUntil: "2026-10-14T16:10:00Z" }, "a-third");
		await store.record(cassette("answer"), "someone-else");
		expect((await store.lookup(HASH, "mine", HOST, now))?.cassette.body).toBe("answer");
		await store.record({ ...cassette("old busy"), status: 429, refusedUntil: "2026-10-14T15:00:00Z" }, "mine");
		await store.record(cassette("develop's"), "develop");
		expect((await store.lookup(HASH, "mine", HOST, now))?.cassette.body).toBe("develop's");
	});

	it("a good recording in develop wins over an unexpired 429 in the run's own scope (CUR-3996)", async () => {
		const now = Date.parse("2026-10-14T16:00:00Z");
		await store.record({ ...cassette("busy"), status: 429, refusedUntil: "2026-10-14T16:10:00Z" }, "mine");
		expect((await store.lookup(HASH, "mine", HOST, now))?.cassette.body).toBe("busy");
		await store.record(cassette("develop's"), "develop");
		expect((await store.lookup(HASH, "mine", HOST, now))?.cassette.body).toBe("develop's");
	});

	it("re-recording a key replaces it rather than adding a second row", async () => {
		await store.record(cassette("first"), "mine");
		await store.record(cassette("second"), "mine");
		const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from model_replay`;
		expect(n).toBe(1);
		expect((await store.lookup(HASH, "mine"))?.cassette.body).toBe("second");
	});

	it("prunes an entry unread for 14 days, keeps one read since, and a hit refreshes last_hit_at", async () => {
		await store.record(cassette("stale"), "old");
		await store.record(cassette("fresh"), "new");
		await sql`update model_replay set last_hit_at = now() - interval '15 days'`;
		await store.lookup(HASH, "new"); // a hit restamps "new"
		await new Promise((r) => setTimeout(r, 200)); // the stamp is fire-and-forget
		await store.record({ ...cassette("x"), requestHash: "f".repeat(32) }, "other", Date.now() + 2 * 60 * 60 * 1000);
		const scopes = (await sql<{ scope: string }[]>`select scope from model_replay order by scope`).map((r) => r.scope);
		expect(scopes).toEqual(["new", "other"]);
	});
});

describe("an unconfigured store fails loud (SOL-148)", () => {
	it("throws when REPLAY_DATABASE_URL is unset, so modelReplay reads it as a miss and never an empty hit", async () => {
		vi.resetModules();
		storeUrl = "";
		const fresh = await import("./replayStore");
		await expect(fresh.lookup(HASH, "mine")).rejects.toThrow(/REPLAY_DATABASE_URL/);
		await expect(fresh.record(cassette("x"), "mine")).rejects.toThrow(/REPLAY_DATABASE_URL/);
	});
});

describe("a store that never answers costs a turn at most the deadline (SOL-209)", () => {
	it("a lookup on a connection that never answers gives up within its deadline and the next call reconnects", async () => {
		// A socket that accepts and then says nothing: what a stalled pooled connection looks like.
		const { createServer } = await import("node:net");
		const silent = createServer(() => {});
		await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
		const { port } = silent.address() as { port: number };
		try {
			vi.resetModules();
			storeUrl = `postgres://u:p@127.0.0.1:${port}/db`;
			const fresh = await import("./replayStore");
			const startedAt = Date.now();
			await expect(fresh.lookup(HASH, "mine", HOST, Date.now(), 300)).rejects.toThrow(/deadline/);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			await expect(fresh.record(cassette("x"), "mine", Date.now(), 300)).rejects.toThrow(/deadline/);

			// The stalled client was dropped, so the next call opens a fresh one against a healthy store.
			storeUrl = url;
			await fresh.record(cassette("after"), "mine");
			expect((await fresh.lookup(HASH, "mine"))?.cassette.body).toBe("after");
		} finally {
			silent.close();
		}
	});
});
