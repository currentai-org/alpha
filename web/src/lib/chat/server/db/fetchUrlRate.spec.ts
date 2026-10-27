import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertOne, countDocuments, hashIp } = vi.hoisted(() => ({
	insertOne: vi.fn(),
	countDocuments: vi.fn(),
	hashIp: vi.fn((): string | null => "iphash"),
}));
vi.mock("$lib/chat/server/database", () => ({
	collections: { messageEvents: { insertOne, countDocuments } },
}));
vi.mock("$lib/chat/server/db/ipHash", () => ({ hashIp }));
vi.mock("$lib/chat/server/logger.js", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { fetchUrlAllowed } from "./fetchUrlRate";

// The limits the route promises: ten a minute per session, 300 a minute per IP.
const FETCH_URL_PER_SESSION = 10;
const FETCH_URL_PER_IP = 300;

const OPTS = { userId: "sess-1", clientAddress: "203.0.113.7" };
/** Answer the count for whichever key the filter names. */
const counts = (session: number, ip: number) =>
	countDocuments.mockImplementation(async (filter: { userId?: string; ipHash?: string }) =>
		filter.userId ? session : ip
	);

beforeEach(() => {
	insertOne.mockReset().mockResolvedValue(undefined);
	countDocuments.mockReset();
	hashIp.mockReset().mockReturnValue("iphash");
});

describe("fetchUrlAllowed (CUR-3191)", () => {
	it("allows and records a fetch under both limits", async () => {
		counts(FETCH_URL_PER_SESSION - 1, FETCH_URL_PER_IP - 1);
		await expect(fetchUrlAllowed(OPTS)).resolves.toBe("ok");
		expect(insertOne).toHaveBeenCalledWith(
			expect.objectContaining({ type: "fetchUrl", userId: "sess-1", ipHash: "iphash" })
		);
	});

	it("refuses the session at its limit and records nothing", async () => {
		counts(FETCH_URL_PER_SESSION, 0);
		await expect(fetchUrlAllowed(OPTS)).resolves.toBe("session");
		expect(insertOne).not.toHaveBeenCalled();
	});

	it("refuses at the per-IP backstop even for a fresh session, which is what bounds session rotation", async () => {
		counts(0, FETCH_URL_PER_IP);
		await expect(fetchUrlAllowed(OPTS)).resolves.toBe("ip");
	});

	it("fails open when the counts cannot be read", async () => {
		countDocuments.mockRejectedValue(new Error("db down"));
		await expect(fetchUrlAllowed(OPTS)).resolves.toBe("ok");
	});

	it("skips the IP count when no pepper is configured, rather than pooling every unhashed caller", async () => {
		hashIp.mockReturnValue(null);
		counts(0, 10_000);
		await expect(fetchUrlAllowed(OPTS)).resolves.toBe("ok");
		expect(countDocuments).toHaveBeenCalledTimes(1);
	});
});
