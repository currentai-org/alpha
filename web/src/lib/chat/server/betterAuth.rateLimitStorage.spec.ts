/**
 * Better Auth's per-IP limit on sign-in code requests counts in the database, not in each
 * serverless instance's memory. With memory storage, a script spread over instances
 * met a fresh count on each one. Real Postgres and the real auth handler: the counter row is
 * what two instances would share, so it is read back from the table.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

// Better Auth turns its rate limiter on only when NODE_ENV is "production", read once at import.
vi.hoisted(() => {
	process.env.NODE_ENV = "production";
});
import { like } from "drizzle-orm";
import { getAuth, SIGN_IN_SHARED_IP_MULTIPLIER } from "$lib/chat/server/betterAuth";
import { AUTH_BASE_PATH } from "$lib/chat/paths";
import { getDb } from "$lib/chat/server/db/client";
import { rateLimit } from "$lib/chat/server/db/schema";

const PATH = `${AUTH_BASE_PATH}/email-otp/send-verification-otp`;
const BUILT_IN_MAX = 3;
const IP = "203.0.113.77";

async function requestCode(auth: ReturnType<typeof getAuth>, n: number) {
	return auth.handler(
		new Request(`http://localhost:5173${PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://localhost:5173", "x-forwarded-for": IP },
			// @example.org is the reserved test domain: no mail is ever sent, so nothing here costs quota.
			body: JSON.stringify({ email: `rate-limit-storage-${n}@example.org`, type: "sign-in" }),
		})
	);
}

afterEach(async () => {
	await getDb().delete(rateLimit).where(like(rateLimit.key, `${IP}%`));
});

describe("sign-in code requests share one per-IP count through the database", () => {
	it("refuses a request past the per-IP limit, and the count it used is a row in rate_limit", async () => {
		const auth = getAuth();
		const limit = BUILT_IN_MAX * SIGN_IN_SHARED_IP_MULTIPLIER;
		const statuses: number[] = [];
		for (let i = 0; i <= limit; i++) statuses.push((await requestCode(auth, i)).status);

		expect(statuses.slice(0, limit).every((s) => s !== 429), "a request under the limit was refused").toBe(true);
		expect(statuses[limit], "the request past the per-IP limit was not refused").toBe(429);

		const rows = await getDb().select().from(rateLimit).where(like(rateLimit.key, `${IP}%`));
		expect(rows.length, "the count lives in memory, not the rate_limit table").toBeGreaterThan(0);
		expect(Math.max(...rows.map((r) => r.count))).toBe(limit);
	});
});
