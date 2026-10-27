import { describe, it, expect } from "vitest";
import { isValidUrl, isValidUrlStrict, ssrfSafeFetch, ssrfStrictFetch } from "./urlSafety";

describe("isValidUrl", () => {
	it("allows normal HTTPS URLs", () => {
		expect(isValidUrl("https://example.com")).toBe(true);
		expect(isValidUrl("https://huggingface.co/docs")).toBe(true);
	});

	it("rejects HTTP URLs", () => {
		expect(isValidUrl("http://example.com")).toBe(false);
		expect(isValidUrl("http://169.254.170.23/v1/credentials")).toBe(false);
	});

	it("rejects localhost", () => {
		expect(isValidUrl("https://localhost")).toBe(false);
		expect(isValidUrl("https://localhost:3000")).toBe(false);
	});

	it("rejects private/internal IPs", () => {
		expect(isValidUrl("https://127.0.0.1")).toBe(false);
		expect(isValidUrl("https://192.168.1.1")).toBe(false);
		expect(isValidUrl("https://172.16.0.1")).toBe(false);
		expect(isValidUrl("https://169.254.170.23")).toBe(false);
	});

	it("rejects IPv4-mapped IPv6 forms of loopback/private (URL normalizes them to hex)", () => {
		// new URL("https://[::ffff:127.0.0.1]").hostname === "::ffff:7f00:1" — must not bypass the guard.
		expect(isValidUrl("https://[::ffff:127.0.0.1]")).toBe(false);
		expect(isValidUrl("https://[::ffff:192.168.1.1]")).toBe(false);
		expect(isValidUrl("https://[::ffff:169.254.170.23]")).toBe(false);
	});

	it("allows 10.0.0.0/8 (used by internal LBs in cluster), incl. its mapped form", () => {
		expect(isValidUrl("https://10.0.0.1")).toBe(true);
		expect(isValidUrl("https://10.0.240.151")).toBe(true);
		expect(isValidUrl("https://[::ffff:10.0.0.1]")).toBe(true); // mapped 10.x stays allowed by default
	});

	it("rejects non-URL strings", () => {
		expect(isValidUrl("not-a-url")).toBe(false);
		expect(isValidUrl("")).toBe(false);
		expect(isValidUrl("ftp://example.com")).toBe(false);
	});

	// Ported from upstream chat-ui 837daec (CUR-2117).
	it("rejects IPv4-mapped IPv6 addresses in either textual form", () => {
		expect(isValidUrl("https://[::ffff:127.0.0.1]")).toBe(false);
		expect(isValidUrl("https://[::ffff:7f00:1]")).toBe(false);
		expect(isValidUrl("https://[::ffff:169.254.169.254]")).toBe(false);
		expect(isValidUrl("https://[::ffff:a9fe:a9fe]")).toBe(false);
	});

	it("rejects IPv6 loopback, link-local and the unspecified address", () => {
		expect(isValidUrl("https://[::1]")).toBe(false);
		expect(isValidUrl("https://[fe80::1]")).toBe(false);
		expect(isValidUrl("https://[::]")).toBe(false);
	});

	it("rejects IPv6 unique local addresses (fc00::/7) in the default mode, not only in strict", () => {
		expect(isValidUrl("https://[fc00::1]")).toBe(false);
		expect(isValidUrl("https://[fd12:3456::1]")).toBe(false);
	});

	it("rejects obfuscated IPv4 notations", () => {
		// The URL parser normalises all of these to 127.0.0.1.
		expect(isValidUrl("https://2130706433")).toBe(false);
		expect(isValidUrl("https://0177.0.0.1")).toBe(false);
		expect(isValidUrl("https://127.1")).toBe(false);
	});

	it("still allows IPv4-mapped public addresses", () => {
		expect(isValidUrl("https://[::ffff:8.8.8.8]")).toBe(true);
	});
});

describe("ssrfSafeFetch / ssrfStrictFetch reject unsafe IP literals before connecting (CUR-2117)", () => {
	// undici only calls the agent's `lookup` hook for hosts needing DNS, so an IP literal would reach
	// the network with no check unless the host is validated up front. Port 9 (discard) is never
	// contacted: each of these must throw before a socket opens.
	it.each([
		["IPv4 loopback", "http://127.0.0.1:9/"],
		["IPv6 loopback", "http://[::1]:9/"],
		["IPv4-mapped loopback", "http://[::ffff:7f00:1]:9/"],
		["link-local metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
		["unspecified IPv4", "http://0.0.0.0:9/"],
		["unspecified IPv6", "http://[::]:9/"],
		["IPv6 unique local address", "http://[fd12:3456::1]:9/"],
		["obfuscated decimal loopback", "http://2130706433:9/"],
	])("blocks %s", async (_label, url) => {
		await expect(ssrfSafeFetch(url)).rejects.toThrow(/unsafe IP \(SSRF\)/);
		await expect(ssrfStrictFetch(url)).rejects.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("blocks unsafe literals whatever the caller's redirect mode", async () => {
		for (const redirect of ["manual", "error"] as const) {
			await expect(ssrfSafeFetch("http://127.0.0.1:9/", { redirect })).rejects.toThrow(
				/unsafe IP \(SSRF\)/
			);
		}
	});

	it("strict mode also blocks the 10/8 literal the default allows", async () => {
		await expect(ssrfStrictFetch("http://10.0.0.1:9/")).rejects.toThrow(/unsafe IP \(SSRF\)/);
	});

	it("does not reject hostnames at the literal check", async () => {
		// `.invalid` never resolves (RFC 2606): this fails at DNS, and must not fail at the literal guard.
		await expect(ssrfSafeFetch("https://nonexistent.invalid/")).rejects.not.toThrow(
			/unsafe IP \(SSRF\)/
		);
	});
});

describe("isValidUrlStrict (admin URL ingest — stricter than isValidUrl)", () => {
	it("allows normal public https URLs", () => {
		expect(isValidUrlStrict("https://example.com")).toBe(true);
		expect(isValidUrlStrict("https://huggingface.co/docs")).toBe(true);
	});

	it("ALSO blocks RFC1918 10/8 that the default isValidUrl intentionally permits", () => {
		expect(isValidUrl("https://10.0.0.1")).toBe(true); // default allows (internal LBs)
		expect(isValidUrlStrict("https://10.0.0.1")).toBe(false); // strict blocks
		expect(isValidUrlStrict("https://10.0.240.151")).toBe(false);
	});

	it("still blocks everything the default blocks", () => {
		expect(isValidUrlStrict("http://example.com")).toBe(false);
		expect(isValidUrlStrict("https://localhost")).toBe(false);
		expect(isValidUrlStrict("https://127.0.0.1")).toBe(false);
		expect(isValidUrlStrict("https://192.168.1.1")).toBe(false);
		expect(isValidUrlStrict("https://172.16.0.1")).toBe(false);
		expect(isValidUrlStrict("https://169.254.170.23")).toBe(false);
	});

	it("blocks IPv6 ULA (fc00::/7)", () => {
		expect(isValidUrlStrict("https://[fc00::1]")).toBe(false);
		expect(isValidUrlStrict("https://[fd12:3456:789a::1]")).toBe(false);
	});

	it("blocks IPv4-mapped IPv6 forms, including the otherwise-allowed 10.x", () => {
		expect(isValidUrlStrict("https://[::ffff:10.0.0.1]")).toBe(false); // mapped 10.x blocked in strict
		expect(isValidUrlStrict("https://[::ffff:127.0.0.1]")).toBe(false);
		expect(isValidUrlStrict("https://[::ffff:192.168.1.1]")).toBe(false);
	});
});

describe("special-use IPv4 and IPv4 carried inside IPv6 are refused (CUR-3526)", () => {
	it("refuses IPv4 special-use, multicast and reserved ranges", () => {
		for (const ip of ["192.0.0.1", "198.18.0.1", "198.19.255.254", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"]) {
			expect(isValidUrl(`https://${ip}`), ip).toBe(false);
		}
	});
	it("refuses loopback and private IPv4 written as NAT64 or 6to4, and IPv6 multicast", () => {
		for (const host of ["[64:ff9b::7f00:1]", "[64:ff9b::127.0.0.1]", "[64:ff9b::a9fe:a9fe]", "[2002:7f00:1::]", "[2002:c0a8:101::1]", "[ff02::1]"]) {
			expect(isValidUrl(`https://${host}`), host).toBe(false);
		}
	});
	it("still accepts a public IPv4 in each embedded form", () => {
		for (const host of ["8.8.8.8", "[64:ff9b::808:808]", "[2002:808:808::1]"]) {
			expect(isValidUrl(`https://${host}`), host).toBe(true);
		}
	});
	it("refuses the same in the strict variant", () => {
		expect(isValidUrlStrict("https://[64:ff9b::a00:1]")).toBe(false); // NAT64 10.0.0.1
		expect(isValidUrlStrict("https://198.18.0.1")).toBe(false);
	});
});
