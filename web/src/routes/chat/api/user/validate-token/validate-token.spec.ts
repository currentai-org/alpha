import { describe, it, expect, vi, beforeEach } from "vitest";

// this route had no brute-force protection at all. These tests prove the new
// adminTokenRate.ts-backed lockout gates the check, and that a valid/invalid token still clears or
// records a failure respectively.

const checkTokenMock = vi.fn();
vi.mock("$lib/chat/server/adminToken", () => ({
	adminTokenManager: { checkToken: checkTokenMock },
}));

const allowedMock = vi.fn(async () => true);
const recordFailureMock = vi.fn(async () => {});
const clearFailuresMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/db/adminTokenRate", () => ({
	adminTokenAllowed: allowedMock,
	recordAdminTokenFailure: recordFailureMock,
	clearAdminTokenFailures: clearFailuresMock,
}));

const clientAddress = "203.0.113.7";
const call = async (token = "guess") => {
	const { POST } = await import("./+server");
	return POST({
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ token }),
		}),
		locals: { sessionId: "sess-1" } as App.Locals,
		getClientAddress: () => clientAddress,
	} as Parameters<typeof POST>[0]);
};

beforeEach(() => {
	vi.resetModules();
	checkTokenMock.mockReset();
	allowedMock.mockReset().mockResolvedValue(true);
	recordFailureMock.mockClear();
	clearFailuresMock.mockClear();
});

describe("POST /chat/api/user/validate-token — brute-force lockout", () => {
	it("429s and never reaches checkToken when the IP is locked out", async () => {
		allowedMock.mockResolvedValue(false);
		const res = await call();
		expect(res.status).toBe(429);
		expect(checkTokenMock).not.toHaveBeenCalled();
	});

	it("records a failure and returns valid:false on a wrong token", async () => {
		checkTokenMock.mockResolvedValue(false);
		const res = await call("wrong");
		await expect(res.json()).resolves.toEqual({ valid: false });
		expect(recordFailureMock).toHaveBeenCalledWith(clientAddress);
		expect(clearFailuresMock).not.toHaveBeenCalled();
	});

	it("clears failures and returns valid:true on a correct token", async () => {
		checkTokenMock.mockResolvedValue(true);
		const res = await call("correct");
		await expect(res.json()).resolves.toEqual({ valid: true });
		expect(clearFailuresMock).toHaveBeenCalledWith(clientAddress);
		expect(recordFailureMock).not.toHaveBeenCalled();
	});
});
