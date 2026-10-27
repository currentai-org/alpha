import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ enforced: true, left: vi.fn() }));
vi.mock("$lib/chat/server/db/attachmentAllowance", () => ({
	attachmentAllowanceEnforced: () => gate.enforced,
	attachmentAllowanceLeft: gate.left,
}));

vi.mock("$lib/chat/server/db/ipHash", () => ({ hashIp: (ip: string) => `hash:${ip}` }));

const info = vi.hoisted(() => vi.fn());
vi.mock("$lib/chat/server/logger", () => ({ logger: { info } }));

const { GET } = await import("./+server");

const call = (locals: Partial<App.Locals>) =>
	GET({ locals, getClientAddress: () => "203.0.113.5" } as unknown as Parameters<typeof GET>[0]) as Promise<Response>;

describe("GET /chat/api/attachment-allowance (CUR-3235, CUR-3600)", () => {
	beforeEach(() => {
		gate.enforced = true;
		gate.left.mockReset().mockResolvedValue({ files: 3, bytes: 1_000 });
		info.mockReset();
	});

	it("answers what a guest has left when the attachment-allowance flag is on", async () => {
		const res = await call({ sessionId: "s" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ files: 3, bytes: 1_000, guest: true });
		expect(gate.left).toHaveBeenCalledWith({ guestSessionId: "s", ipHash: "hash:203.0.113.5" });
	});

	it("says when the guest's network, not the session, ran out (CUR-3600)", async () => {
		gate.left.mockResolvedValue({ files: 0, bytes: 0, network: true });
		expect(await (await call({ sessionId: "s" })).json()).toEqual({ files: 0, bytes: 0, guest: true, network: true });
	});

	it("logs a spent allowance with guest and network, so the network ceiling is set from real refusals (CUR-3600)", async () => {
		gate.left.mockResolvedValue({ files: 0, bytes: 0, network: true });
		await call({ sessionId: "s" });
		expect(info).toHaveBeenCalledWith({ guest: true, network: true, at: "attach" }, "[attachment-allowance] refused");
	});

	it("logs nothing while files are left", async () => {
		await call({ sessionId: "s" });
		expect(info).not.toHaveBeenCalled();
	});

	it("answers 204 without counting when the flag is off, so the composer refuses nothing", async () => {
		gate.enforced = false;
		const res = await call({ sessionId: "s" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(gate.left).not.toHaveBeenCalled();
	});
});
