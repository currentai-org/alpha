import { describe, it, expect, beforeEach, vi } from "vitest";

// Mutable pepper behind a mocked config so we can exercise both the configured and
// unset paths. hashIp reads it via Reflect.get(config, "CONTRIBUTION_IP_PEPPER").
const h = vi.hoisted(() => ({ pepper: "test-pepper-0123456789abcdef" }));
vi.mock("$lib/chat/server/config", () => ({
	config: {
		get CONTRIBUTION_IP_PEPPER() {
			return h.pepper;
		},
	},
}));

import { hashIp, hashTargetEmail } from "./ipHash";

describe("hashIp", () => {
	beforeEach(() => {
		h.pepper = "test-pepper-0123456789abcdef";
	});

	it("never returns the raw IP", () => {
		const ip = "203.0.113.7";
		const out = hashIp(ip);
		expect(out).toBeTruthy();
		expect(out).not.toContain(ip);
		expect(out).not.toBe(ip);
	});

	it("is deterministic — same IP maps to the same hash", () => {
		expect(hashIp("203.0.113.7")).toBe(hashIp("203.0.113.7"));
	});

	it("separates distinct IPs", () => {
		expect(hashIp("203.0.113.7")).not.toBe(hashIp("203.0.113.8"));
	});

	it("is keyed — a different pepper yields a different hash for the same IP", () => {
		const a = hashIp("203.0.113.7");
		h.pepper = "a-totally-different-pepper-value";
		const b = hashIp("203.0.113.7");
		expect(a).not.toBe(b);
	});

	it("separates domains — same IP+pepper hashes differently per use-site", () => {
		// Stops a contribution row (identified) being joined to rate-limit rows by equal IP hash.
		const contrib = hashIp("203.0.113.7", "contribution");
		const rateLimit = hashIp("203.0.113.7", "rate-limit");
		expect(contrib).toBeTruthy();
		expect(rateLimit).toBeTruthy();
		expect(contrib).not.toBe(rateLimit);
		// ...but each domain is still internally stable (so COUNT-based caps work).
		expect(hashIp("203.0.113.7", "rate-limit")).toBe(rateLimit);
	});

	it("counts a rotating IPv6 home as one network: two addresses in one /56 hash the same", () => {
		expect(hashIp("2001:db8:1234:5600::1", "rate-limit")).toBe(
			hashIp("2001:db8:1234:56ff::42", "rate-limit")
		);
		expect(hashIp("2001:db8:1234:5600::1", "rate-limit")).not.toBe(
			hashIp("2001:db8:1234:5700::1", "rate-limit")
		);
	});

	it("counts an IPv4-mapped IPv6 address as the IPv4 it carries", () => {
		expect(hashIp("::ffff:203.0.113.7", "rate-limit")).toBe(hashIp("203.0.113.7", "rate-limit"));
	});

	it("fails toward privacy: no pepper → null (cap disabled, nothing stored)", () => {
		h.pepper = "";
		expect(hashIp("203.0.113.7")).toBeNull();
	});

	it("returns null for empty/whitespace/missing IP", () => {
		expect(hashIp("")).toBeNull();
		expect(hashIp("   ")).toBeNull();
		expect(hashIp(null)).toBeNull();
		expect(hashIp(undefined)).toBeNull();
	});
});

describe("hashTargetEmail (CUR-920 review follow-up)", () => {
	beforeEach(() => {
		h.pepper = "test-pepper-0123456789abcdef";
	});

	it("never returns the raw email", () => {
		const email = "victim@example.com";
		const out = hashTargetEmail(email);
		expect(out).toBeTruthy();
		expect(out).not.toContain(email);
		expect(out).not.toBe(email);
	});

	it("is deterministic and case-insensitive — same address maps to the same hash regardless of case", () => {
		expect(hashTargetEmail("Victim@Example.com")).toBe(hashTargetEmail("victim@example.com"));
	});

	it("separates distinct addresses", () => {
		expect(hashTargetEmail("a@example.com")).not.toBe(hashTargetEmail("b@example.com"));
	});

	it("separates from hashIp's domains — the same pepper never lets an email hash collide with an IP hash", () => {
		// Not a literal same-input comparison (email vs IP have different content), just confirming the
		// two functions hash into genuinely different domain namespaces off the same pepper.
		expect(hashTargetEmail("203.0.113.7")).not.toBe(hashIp("203.0.113.7", "rate-limit"));
	});

	it("fails toward privacy: no pepper → null (cap disabled, nothing stored)", () => {
		h.pepper = "";
		expect(hashTargetEmail("victim@example.com")).toBeNull();
	});
});
