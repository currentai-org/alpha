// A safety judge is configured only with both its key and an endpoint. A self-host sets HF_TOKEN for its
// own reasons; before the endpoints had env vars that alone made S1 and Mila SP look configured,
// so they called Current AI's own Hugging Face endpoints, and S1 then failed every turn closed.
import { afterEach, describe, expect, it, vi } from "vitest";
import S1_RULES_JSON from "../rules-s1.json";
// The public snapshot ships rules-s1.json with only its `_s1` settings: the S1 policies are not
// published there, so the specs below that assert what S1 decides under a policy skip on it.
const S1_POLICIES_PUBLISHED = Object.keys(S1_RULES_JSON).some((key) => key !== "_s1");
import { makeS1Judge, s1Configured } from "./s1";
import { milaSpConfigured, milaSpScore } from "./milaSp";

const CHECKS = [
	["S1", s1Configured, "ZENTROPI_S1_ENDPOINT_URL"],
	["Mila SP", milaSpConfigured, "MILA_SP_ENDPOINT_URL"],
] as const;

/** A deployment that declares no environment and has no judge endpoint set: local dev, CI, a self-host. */
function selfHost(extra: Record<string, string> = {}) {
	vi.stubEnv("DEPLOY_ENV", "");
	vi.stubEnv("VERCEL_ENV", "");
	vi.stubEnv("ZENTROPI_S1_ENDPOINT_URL", "");
	vi.stubEnv("MILA_SP_ENDPOINT_URL", "");
	vi.stubEnv("HF_TOKEN", "hf_selfhost");
	for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

afterEach(() => vi.unstubAllEnvs());

describe("a safety judge is not configured without its endpoint", () => {
	it.each(CHECKS)("%s is not configured with HF_TOKEN set and no endpoint off production/preview", (_n, configured) => {
		selfHost();
		expect(configured()).toBe(false);
	});

	it.each(CHECKS)("%s is configured with HF_TOKEN and its endpoint env var set", (_n, configured, envVar) => {
		selfHost({ [envVar]: "https://judge.selfhost.example" });
		expect(configured()).toBe(true);
	});

	it.each(CHECKS)("%s is still not configured with its endpoint set and HF_TOKEN unset", (_n, configured, envVar) => {
		selfHost({ [envVar]: "https://judge.selfhost.example", HF_TOKEN: "" });
		expect(configured()).toBe(false);
	});

	it.each(["production", "preview"])(
		"every judge stays configured on %s with HF_TOKEN alone, as it was before the env vars existed",
		(deploy) => {
			selfHost({ DEPLOY_ENV: deploy });
			for (const [, configured] of CHECKS) expect(configured()).toBe(true);
		}
	);
});

describe("an unconfigured endpoint sends no request anywhere", () => {
	// Skipped on the public snapshot, whose rules-s1.json has no S1 policies.
	it.skipIf(!S1_POLICIES_PUBLISHED)("S1 leaves every policy unknown (fail closed, as with no key) and calls nothing", async () => {
		selfHost();
		const fetchSpy = vi.fn();
		const log = quiet();
		const r = await makeS1Judge({ fetchImpl: fetchSpy as unknown as typeof fetch })("hello there", "input", {
			opSignal: new AbortController().signal,
			log,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(r.calls).toBe(0);
		expect(r.servedModel).toBeUndefined();
		expect(r.rules.size).toBeGreaterThan(0);
		expect([...r.rules.values()].every((s) => s === "U")).toBe(true);
		expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ judge: "s1", reason: "config" }), expect.any(String));
	});

	it("Mila SP is unknown (fail open) and calls nothing", async () => {
		selfHost();
		const fetchSpy = vi.fn();
		expect(await milaSpScore("an answer", undefined, { fetchImpl: fetchSpy as unknown as typeof fetch })).toEqual({
			verdict: "unknown",
			reason: "config",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
