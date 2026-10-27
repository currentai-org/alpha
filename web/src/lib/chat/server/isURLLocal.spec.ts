import { describe, expect, it, vi } from "vitest";

// Hermetic DNS: isURLLocal resolves hostnames via node:dns lookup, so the SSRF-guard logic (is the
// resolved IP loopback?) must not depend on live third-party wildcard-DNS services (nip.io, sslip.io)
// being reachable, which fails in DNS-restricted CI and sandboxes.
// Mock the lookup with a deterministic table so the guard's subnet logic — including the DNS-rebinding
// case (a public-looking host that resolves to loopback) — is tested without any network.
vi.mock("node:dns", () => {
	const table: Record<string, { address: string; family: number }> = {
		localhost: { address: "127.0.0.1", family: 4 },
		"127.0.0.1": { address: "127.0.0.1", family: 4 },
		"127.254.254.254": { address: "127.254.254.254", family: 4 },
		// DNS-rebinding shape: a normal-looking hostname that actually resolves to loopback.
		"127.0.0.1.nip.io": { address: "127.0.0.1", family: 4 },
		// A genuinely external host resolves to a public IP → not local.
		"huggingface.co": { address: "76.76.21.21", family: 4 },
	};
	const lookup = (
		hostname: string,
		cb: (err: Error | null, address?: string, family?: number) => void
	) => {
		const hit = table[hostname];
		if (hit) cb(null, hit.address, hit.family);
		else cb(new Error(`ENOTFOUND ${hostname}`)); // unknown host → reject, like a real NXDOMAIN
	};
	return { default: { lookup }, lookup };
});

const { isURLLocal } = await import("./isURLLocal");

describe("isURLLocal", () => {
	it("should return true for localhost", async () => {
		expect(await isURLLocal(new URL("http://localhost"))).toBe(true);
	});
	it("should return true for 127.0.0.1", async () => {
		expect(await isURLLocal(new URL("http://127.0.0.1"))).toBe(true);
	});
	it("should return true for 127.254.254.254", async () => {
		expect(await isURLLocal(new URL("http://127.254.254.254"))).toBe(true);
	});
	it("should return false for huggingface.co", async () => {
		expect(await isURLLocal(new URL("https://huggingface.co/"))).toBe(false);
	});
	it("should return true for 127.0.0.1.nip.io (DNS-rebinding → loopback)", async () => {
		expect(await isURLLocal(new URL("http://127.0.0.1.nip.io"))).toBe(true);
	});
	it("should fail on ipv6", async () => {
		await expect(isURLLocal(new URL("http://[::1]"))).rejects.toThrow();
	});
	it("should fail on ipv6 --1.sslip.io", async () => {
		await expect(isURLLocal(new URL("http://--1.sslip.io"))).rejects.toThrow();
	});
	it("should fail on invalid domain names", async () => {
		await expect(
			isURLLocal(new URL("http://34329487239847329874923948732984.com/"))
		).rejects.toThrow();
	});
});
