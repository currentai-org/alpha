import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: {} }));
vi.mock("$env/dynamic/public", () => ({ env: {} }));
const captureServerException = vi.fn();
vi.mock("$lib/chat/server/errorTracking", () => ({ captureServerException }));
const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const { validateEnvFor } = await import("./validate");
const { bootRequiredKeys, requiredKeys } = await import("../../../../../config/env-manifest.mjs");

// Every hard-required var set, so each case below differs from a booting server by exactly the one
// var it removes.
const complete = (): Record<string, string> =>
	Object.fromEntries((requiredKeys() as string[]).map((k) => [k, `value-of-${k}`]));
const withoutCms = () => ({ ...complete(), PUBLIC_CMS_PAYLOAD_URL: "" });

beforeEach(() => {
	warn.mockReset();
	captureServerException.mockReset();
});

describe("boot validation — PUBLIC_CMS_PAYLOAD_URL is fatal only where the site's CMS pages are served", () => {
	it("refuses to boot production's site build (www) without it — fails loud, never degrades", () => {
		expect(() => validateEnvFor(withoutCms(), { surface: "site", deployEnv: "production" })).toThrow(
			/PUBLIC_CMS_PAYLOAD_URL/
		);
		expect(captureServerException).toHaveBeenCalled();
	});

	it("refuses to boot a preview of the site build (develop, PR previews) without it", () => {
		expect(() => validateEnvFor(withoutCms(), { surface: "site", deployEnv: "preview" })).toThrow(
			/PUBLIC_CMS_PAYLOAD_URL/
		);
	});

	it("treats a whitespace-only value as missing on the site build, not as configured", () => {
		const all = { ...complete(), PUBLIC_CMS_PAYLOAD_URL: "   " };
		expect(() => validateEnvFor(all, { surface: "site", deployEnv: "production" })).toThrow(/PUBLIC_CMS_PAYLOAD_URL/);
	});

	it("boots the chat surface (alpha) in production without it, and logs the waiver", () => {
		expect(() => validateEnvFor(withoutCms(), { surface: "chat", deployEnv: "production" })).not.toThrow();
		const waiver = warn.mock.calls.find((c) => String(c[1]).includes("not fatal on this surface"));
		expect(waiver?.[0].keys, "a waived var that is missing must still be named in the boot log").toEqual([
			"PUBLIC_CMS_PAYLOAD_URL",
		]);
	});

	it("boots a build with no declared environment (the public snapshot, self-hosted) without it", () => {
		expect(() => validateEnvFor(withoutCms(), { surface: "site", deployEnv: null })).not.toThrow();
	});

	it("boots local development without it", () => {
		expect(() => validateEnvFor(withoutCms(), { surface: "site", deployEnv: "development" })).not.toThrow();
	});

	it("waives ONLY the CMS origin: the chat surface still refuses to boot without any other required var", () => {
		for (const k of (requiredKeys() as string[]).filter(
			(key) => key !== "PUBLIC_CMS_PAYLOAD_URL" && key !== "ALPHA_EDITION" // ALPHA_EDITION: production-only, below
		)) {
			const all = { ...withoutCms(), [k]: "" };
			expect(() => validateEnvFor(all, { surface: "chat", deployEnv: null }), k).toThrow(new RegExp(k));
		}
	});
});

describe("bootRequiredKeys — the deploy gate's list is unchanged, only the boot list narrows", () => {
	it("keeps PUBLIC_CMS_PAYLOAD_URL in requiredKeys(), so check-prod-env.mjs still blocks a www deploy without it", () => {
		expect(requiredKeys()).toContain("PUBLIC_CMS_PAYLOAD_URL");
	});

	it("is requiredKeys() exactly on production's site build", () => {
		expect(bootRequiredKeys({ surface: "site", deployEnv: "production" })).toEqual(requiredKeys());
	});

	it("drops nothing but PUBLIC_CMS_PAYLOAD_URL and ALPHA_EDITION anywhere else", () => {
		const waivable = ["PUBLIC_CMS_PAYLOAD_URL", "ALPHA_EDITION"];
		const others = (requiredKeys() as string[]).filter((k) => !waivable.includes(k));
		for (const surface of ["site", "chat"] as const) {
			for (const deployEnv of ["production", "preview", "development", null] as const) {
				const keys = bootRequiredKeys({ surface, deployEnv }) as string[];
				expect(keys.filter((k) => !waivable.includes(k)), `${surface}/${deployEnv}`).toEqual(others);
			}
		}
	});
});

describe("boot validation — ALPHA_EDITION is fatal only on a production deployment", () => {
	const withoutEdition = () => ({ ...complete(), ALPHA_EDITION: "" });

	it("refuses to boot a production deployment with ALPHA_EDITION unset, naming the key", () => {
		for (const surface of ["site", "chat"] as const) {
			expect(() => validateEnvFor(withoutEdition(), { surface, deployEnv: "production" }), surface).toThrow(
				/FATAL.*ALPHA_EDITION/
			);
		}
		expect(captureServerException).toHaveBeenCalled();
	});

	it("treats a whitespace-only ALPHA_EDITION as unset on production", () => {
		const all = { ...complete(), ALPHA_EDITION: "  " };
		expect(() => validateEnvFor(all, { surface: "chat", deployEnv: "production" })).toThrow(/ALPHA_EDITION/);
	});

	it("boots production with ALPHA_EDITION=hosted", () => {
		expect(() =>
			validateEnvFor({ ...complete(), ALPHA_EDITION: "hosted" }, { surface: "chat", deployEnv: "production" })
		).not.toThrow();
	});

	it("still boots a self-host (development or undeclared), a preview and local dev without it", () => {
		for (const deployEnv of ["development", "preview", null] as const) {
			expect(() => validateEnvFor(withoutEdition(), { surface: "chat", deployEnv }), String(deployEnv)).not.toThrow();
		}
	});

	it("keeps ALPHA_EDITION in requiredKeys(), so check-prod-env.mjs blocks a production deploy without it", () => {
		expect(requiredKeys()).toContain("ALPHA_EDITION");
	});
});

// A deployment that serves only the website, with chat on a deployment of its own: a site-only build
// boots on the site's own keys, so chat's database URL, model keys and auth secret can stay out of its env.
describe("boot validation — a site-only build needs none of chat's env", () => {
	const siteOnlyEnv = () => ({ PUBLIC_CMS_PAYLOAD_URL: "https://cms.example", PUBLIC_ORIGIN: "https://www.example" });

	it("boots production's site-only build with no DATABASE_URL, model key or Better Auth secret", () => {
		expect(() => validateEnvFor(siteOnlyEnv(), { surface: "site-only", deployEnv: "production" })).not.toThrow();
	});

	it("names none of chat's keys as missing or waived on that boot", () => {
		validateEnvFor(siteOnlyEnv(), { surface: "site-only", deployEnv: "production" });
		const named = warn.mock.calls.flatMap((c) => ((c[0] as { keys?: string[] }).keys ?? []) as string[]);
		for (const k of ["DATABASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "BETTER_AUTH_SECRET"]) {
			expect(named, k).not.toContain(k);
		}
	});

	it("still refuses to boot production's site-only build without the CMS origin or its own origin", () => {
		for (const k of ["PUBLIC_CMS_PAYLOAD_URL", "PUBLIC_ORIGIN"]) {
			const all = { ...siteOnlyEnv(), [k]: "" };
			expect(() => validateEnvFor(all, { surface: "site-only", deployEnv: "production" }), k).toThrow(new RegExp(k));
		}
	});

	it("leaves the site surface, which still serves /chat, requiring every chat key", () => {
		expect(() => validateEnvFor(siteOnlyEnv(), { surface: "site", deployEnv: "production" })).toThrow(/DATABASE_URL/);
	});
});


describe("boot validation — Open WebUI's model env names count for OPENAI_BASE_URL", () => {
	const owuiOnly = () => ({ ...complete(), OPENAI_BASE_URL: "", OPENAI_API_BASE_URLS: "http://llama:8080/v1" });
	it("boots with OPENAI_BASE_URL empty when OPENAI_API_BASE_URLS names an endpoint", () => {
		expect(() => validateEnvFor(owuiOnly(), { surface: "chat", deployEnv: null })).not.toThrow();
	});
	it("still refuses to boot (fails loud) when neither OPENAI_BASE_URL nor OPENAI_API_BASE_URLS is set", () => {
		const neither = { ...owuiOnly(), OPENAI_API_BASE_URLS: "" };
		expect(() => validateEnvFor(neither, { surface: "chat", deployEnv: null })).toThrow(/OPENAI_BASE_URL/);
	});
});
