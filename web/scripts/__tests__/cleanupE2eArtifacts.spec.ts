import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";

import { cleanupE2eArtifacts, isE2eEmail, runPatterns } from "../cleanup-e2e-artifacts.mjs";

// An e2e sign-in leaves two identities, Better Auth's `user` row and the legacy shadow
// `users` row the auth bridge mints, with its settings and conversations. These run the real cleanup
// against the stateful project's Postgres. (CUR-2529)
const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
afterAll(() => sql.end({ timeout: 5 }));

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000);

async function seedAccount(email: string, createdAt: Date = HOURS_AGO(4)) {
	const baId = `ba-${randomUUID()}`;
	const shadowId = `shadow-${randomUUID()}`;
	const conversationId = `conv-${randomUUID()}`;
	const reportId = `report-${randomUUID()}`;
	await sql`insert into "user" (id, name, email, created_at) values (${baId}, 'E2E', ${email}, ${createdAt})`;
	await sql`insert into users (id, doc) values (${shadowId}, ${sql.json({ email, betterAuthUserId: baId })})`;
	await sql`insert into settings (id, user_id, doc) values (${`settings-${randomUUID()}`}, ${shadowId}, ${sql.json({})})`;
	await sql`insert into sessions (id, session_id, user_id, doc) values (${`sess-${randomUUID()}`}, ${`sid-${randomUUID()}`}, ${shadowId}, ${sql.json({})})`;
	await sql`insert into conversations (id, user_id, doc) values (${conversationId}, ${shadowId}, ${sql.json({ messages: [] })})`;
	await sql`insert into reports (id, conversation_id, category) values (${reportId}, ${conversationId}, 'other')`;
	return { baId, shadowId, conversationId, reportId };
}

async function remaining(a: Awaited<ReturnType<typeof seedAccount>>) {
	const [row] = await sql`select
		(select count(*) from "user" where id = ${a.baId})::int as ba,
		(select count(*) from users where id = ${a.shadowId})::int as shadow,
		(select count(*) from settings where user_id = ${a.shadowId})::int as settings,
		(select count(*) from sessions where user_id = ${a.shadowId})::int as sessions,
		(select count(*) from conversations where user_id = ${a.shadowId})::int as conversations,
		(select count(*) from reports where id = ${a.reportId})::int as reports`;
	return row;
}

describe("cleanup-e2e-artifacts (CUR-2529)", () => {
	it("removes an e2e account's shadow user, settings, sessions and conversations, keeps its report detached, and leaves a real account alone", async () => {
		const e2e = await seedAccount(`e2e-${randomUUID()}@example.org`);
		const real = await seedAccount(`person-${randomUUID()}@realmail.test`);

		await cleanupE2eArtifacts(sql);

		expect(await remaining(e2e)).toEqual({
			ba: 0,
			shadow: 0,
			settings: 0,
			sessions: 0,
			conversations: 0,
			reports: 1,
		});
		const [report] = await sql`select conversation_id from reports where id = ${e2e.reportId}`;
		expect(report.conversation_id).toBeNull();
		expect(await remaining(real)).toEqual({
			ba: 1,
			shadow: 1,
			settings: 1,
			sessions: 1,
			conversations: 1,
			reports: 1,
		});
	});

	it("refuses and deletes nothing when its query selects an account without an e2e email", async () => {
		const e2e = await seedAccount(`e2e-${randomUUID()}@example.org`);
		const real = await seedAccount(`person-${randomUUID()}@realmail.test`);

		// An over-broad pattern that matches every account, the mistake the guard exists for.
		await expect(cleanupE2eArtifacts(sql, { patterns: ["%"] })).rejects.toThrow(/refusing to delete/);

		expect((await remaining(e2e)).shadow).toBe(1);
		expect((await remaining(real)).shadow).toBe(1);
	});

	// Several workflows sign in against the same database, so a cleanup that took every e2e account
	// would sign out a run still using its own.
	it("deletes this run's own fresh accounts and keeps another run's fresh account until it is past the age floor", async () => {
		const mine = await seedAccount(`e2e-r111-${randomUUID()}@example.org`, new Date());
		const theirs = await seedAccount(`e2e-r222-${randomUUID()}@example.org`, new Date());
		const untagged = await seedAccount(`e2e-${randomUUID()}@example.org`, new Date());
		const stale = await seedAccount(`e2e-r333-${randomUUID()}@example.org`, HOURS_AGO(4));
		const mineStaff = await seedAccount(`e2e-r111-${randomUUID()}@currentai.org`, new Date());
		const staleStaff = await seedAccount(`e2e-${randomUUID()}@currentai.org`, HOURS_AGO(4));

		await cleanupE2eArtifacts(sql, { runId: "111" });

		expect((await remaining(mine)).ba).toBe(0);
		expect((await remaining(mine)).shadow).toBe(0);
		expect((await remaining(mineStaff)).ba).toBe(0);
		expect((await remaining(mineStaff)).shadow).toBe(0);
		expect((await remaining(staleStaff)).ba).toBe(0);
		expect(await remaining(theirs)).toMatchObject({ ba: 1, shadow: 1, sessions: 1 });
		expect(await remaining(untagged)).toMatchObject({ ba: 1, shadow: 1, sessions: 1 });
		expect((await remaining(stale)).ba).toBe(0);
	});

	// A run cancelled by a newer push never reaches its verdict job's cleanup, so the next
	// run sweeps each cancelled predecessor's accounts before its own shards start. (CUR-2918)
	it("sweeps several cancelled runs' fresh accounts and keeps a fresh account from a run it was not named", async () => {
		const cancelledA = await seedAccount(`e2e-r444-${randomUUID()}@example.org`, new Date());
		const cancelledB = await seedAccount(`e2e-r555-${randomUUID()}@currentai.org`, new Date());
		const live = await seedAccount(`e2e-r666-${randomUUID()}@example.org`, new Date());

		await cleanupE2eArtifacts(sql, { runIds: ["444", "555"] });

		expect((await remaining(cancelledA)).ba).toBe(0);
		expect((await remaining(cancelledB)).ba).toBe(0);
		expect(await remaining(live)).toMatchObject({ ba: 1, shadow: 1, sessions: 1 });
	});

	it("removes a shadow user whose Better Auth user an earlier run already deleted", async () => {
		const orphan = await seedAccount(`e2e-${randomUUID()}@example.org`, new Date());
		await sql`delete from "user" where id = ${orphan.baId}`;

		await cleanupE2eArtifacts(sql);

		expect((await remaining(orphan)).shadow).toBe(0);
	});

	it("accepts only a numeric run id, so a run id cannot widen the like pattern", () => {
		expect(runPatterns(37376523621)).toEqual(["e2e-r37376523621-%@example.org", "e2e-r37376523621-%@currentai.org"]);
		expect(() => runPatterns("%")).toThrow(/digits/);
	});

	it("recognises only the email shapes the suite mints", () => {
		expect(isE2eEmail("e2e-1234@example.org")).toBe(true);
		expect(isE2eEmail("e2e-1234@currentai.org")).toBe(true);
		expect(isE2eEmail("someone@currentai.org")).toBe(false);
		expect(isE2eEmail("mock-oidc-e2e@example.org")).toBe(true);
		expect(isE2eEmail("e2e-1234@example.org.evil.test")).toBe(false);
		expect(isE2eEmail("someone@example.org")).toBe(false);
		expect(isE2eEmail(null)).toBe(false);
	});
});
