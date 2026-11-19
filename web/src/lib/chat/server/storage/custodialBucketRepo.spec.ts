// HF_BUCKETS_REPO unset means production's bucket on production and no custodial storage anywhere else:
// the surface stays off whatever its flag says, and the deployment logs why, once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted((): Record<string, string> => ({}));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({ logger }));

const flags = vi.hoisted(() => ({ flagEnabledForUser: vi.fn(), flagEnabledOr: vi.fn() }));
vi.mock("$lib/chat/server/flags", () => flags);

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	logger.error.mockReset();
	flags.flagEnabledForUser.mockReset().mockResolvedValue(true);
	flags.flagEnabledOr.mockReset().mockReturnValue(true);
	vi.stubEnv("VERCEL_ENV", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("resolvedCustodialBucketRepo — production's bucket only on production", () => {
	it("resolves production's bucket on a production deployment with HF_BUCKETS_REPO unset", async () => {
		vi.stubEnv("DEPLOY_ENV", "production");
		const { resolvedCustodialBucketRepo } = await import("./custodialBucketRepo");
		expect(resolvedCustodialBucketRepo()).toBe("buckets/current-ai-official/custodial-storage-eu");
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("resolves production's bucket on Vercel production, which sets VERCEL_ENV and no DEPLOY_ENV", async () => {
		vi.stubEnv("DEPLOY_ENV", "");
		vi.stubEnv("VERCEL_ENV", "production");
		const { resolvedCustodialBucketRepo } = await import("./custodialBucketRepo");
		expect(resolvedCustodialBucketRepo()).toBe("buckets/current-ai-official/custodial-storage-eu");
	});

	it.each(["preview", "development", ""])(
		"resolves no bucket (null, logged once by name) with HF_BUCKETS_REPO unset on DEPLOY_ENV=%j",
		async (env) => {
			vi.stubEnv("DEPLOY_ENV", env);
			const { resolvedCustodialBucketRepo } = await import("./custodialBucketRepo");
			expect(resolvedCustodialBucketRepo()).toBeNull();
			expect(resolvedCustodialBucketRepo()).toBeNull();
			expect(logger.error).toHaveBeenCalledOnce();
			expect(logger.error.mock.calls[0][1]).toMatch(/HF_BUCKETS_REPO is not set/);
		}
	);

	it("resolves the configured bucket on every deployment, production included, when HF_BUCKETS_REPO is set", async () => {
		cfg.HF_BUCKETS_REPO = " buckets/current-ai-official/custodial-storage-preview ";
		const { resolvedCustodialBucketRepo } = await import("./custodialBucketRepo");
		for (const env of ["production", "preview", ""]) {
			vi.stubEnv("DEPLOY_ENV", env);
			expect(resolvedCustodialBucketRepo()).toBe("buckets/current-ai-official/custodial-storage-preview");
		}
		expect(logger.error).not.toHaveBeenCalled();
	});
});

describe("the custodial storage surface is off without a bucket, whatever the flag says", () => {
	it("is off for a person, without asking PostHog, when HF_BUCKETS_REPO is unset off production", async () => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
		vi.stubEnv("DEPLOY_ENV", "preview");
		const { custodialStorageViewEnabledForUser } = await import("./custodialStorageGate");
		expect(await custodialStorageViewEnabledForUser("a".repeat(24))).toBe(false);
		expect(flags.flagEnabledForUser).not.toHaveBeenCalled();
	});

	it("is off for guests when HF_BUCKETS_REPO is unset off production", async () => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
		vi.stubEnv("DEPLOY_ENV", "");
		const { custodialStorageForGuestsEnabled } = await import("./custodialStorageGate");
		expect(custodialStorageForGuestsEnabled()).toBe(false);
		expect(flags.flagEnabledOr).not.toHaveBeenCalled();
	});

	it("still follows the flag on production with HF_BUCKETS_REPO unset, as it always has", async () => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
		vi.stubEnv("DEPLOY_ENV", "production");
		const { custodialStorageViewEnabledForUser, custodialStorageForGuestsEnabled } = await import("./custodialStorageGate");
		expect(await custodialStorageViewEnabledForUser("a".repeat(24))).toBe(true);
		expect(custodialStorageForGuestsEnabled()).toBe(true);
		flags.flagEnabledForUser.mockResolvedValue(false);
		flags.flagEnabledOr.mockReturnValue(false);
		expect(await custodialStorageViewEnabledForUser("a".repeat(24))).toBe(false);
		expect(custodialStorageForGuestsEnabled()).toBe(false);
	});

	it("follows the flag off production when HF_BUCKETS_REPO names a bucket", async () => {
		vi.stubEnv("DEPLOY_ENV", "preview");
		cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
		cfg.HF_BUCKETS_REPO = "buckets/current-ai-official/custodial-storage-preview";
		const { custodialStorageViewEnabledForUser } = await import("./custodialStorageGate");
		expect(await custodialStorageViewEnabledForUser("a".repeat(24))).toBe(true);
		expect(flags.flagEnabledForUser).toHaveBeenCalledOnce();
	});
});
