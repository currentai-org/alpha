import { describe, it, expect, vi, beforeEach } from "vitest";

// flags.ts reads env through the `config` proxy. Mock it, and the logger, so the PostHog-unset and
// PostHog-set paths can be driven without a network.
const { cfg, getFeatureFlag } = vi.hoisted(() => ({ cfg: {} as Record<string, string>, getFeatureFlag: vi.fn() }));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
class FakePostHog {
	getFeatureFlag = getFeatureFlag;
	getAllFlags = vi.fn(async () => ({}));
	waitForLocalEvaluationReady = vi.fn(async () => true);
	isLocalEvaluationReady = vi.fn(() => true);
	async shutdown() {}
}
vi.mock("posthog-node", () => ({ PostHog: FakePostHog }));

import { __resetFlagsForTest, flagEnabledForUser, flagEnabledOr } from "./flags";
import { FLAG_KEYS } from "./flagKeys";

// Keys picked by their declared self-host default, so the specs break if a default is edited away
// from the contract they name rather than silently following it.
const onKey = FLAG_KEYS.find((f) => f.selfHost === "on" && f.codeDefault === "off")!.key;
const offKey = FLAG_KEYS.find((f) => f.selfHost === "off" && f.codeDefault === "off")!.key;
const codeOnKey = "crisis-referral-order";
const envKey = FLAG_KEYS.find((f) => typeof f.selfHost === "object" && f.key === "dictation")!;

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	getFeatureFlag.mockReset();
	__resetFlagsForTest();
});

describe("self-host defaults, PostHog not configured", () => {
	it("with PostHog unset, a flag whose self-host default is on reads on although its code fallback is off", () => {
		expect(flagEnabledOr(onKey, () => false)).toBe(true);
	});

	it("with PostHog unset, a flag whose self-host default is off reads off even when its code fallback is on", () => {
		expect(flagEnabledOr(offKey, () => true)).toBe(false);
	});

	it("with PostHog unset, a flag whose self-host default is 'code' keeps its own fallback (crisis-referral-order stays on)", () => {
		expect(FLAG_KEYS.find((f) => f.key === codeOnKey)?.selfHost).toBe("code");
		expect(flagEnabledOr(codeOnKey, () => true)).toBe(true);
	});

	it("with PostHog unset, an on-when-env flag reads off until every named env var is set, then on", () => {
		expect(envKey.selfHost).toEqual({ onWhenEnv: ["TRANSCRIPTION_MODEL"] });
		expect(flagEnabledOr("dictation", () => false)).toBe(false);
		cfg.TRANSCRIPTION_MODEL = "whisper-small";
		expect(flagEnabledOr("dictation", () => false)).toBe(true);
	});

	it("with PostHog unset, multimodal reads on for CSAM_SCAN=off only on a set non-hosted edition, and stays off otherwise", () => {
		cfg.MULTIMODAL_ENABLED = "true";
		cfg.CSAM_SCAN = "off";
		expect(flagEnabledOr("multimodal", () => false)).toBe(false); // edition unset: switch not honoured
		cfg.ALPHA_EDITION = "selfhost";
		expect(flagEnabledOr("multimodal", () => false)).toBe(true);
		delete cfg.CSAM_SCAN;
		expect(flagEnabledOr("multimodal", () => false)).toBe(false);
	});

	it("with PostHog unset, multimodal on a selfhost edition needs only the scan decision; MULTIMODAL_ENABLED=false keeps it off; a non-selfhost edition still needs MULTIMODAL_ENABLED=true", () => {
		cfg.ALPHA_EDITION = "selfhost";
		expect(flagEnabledOr("multimodal", () => false)).toBe(false); // no scan decision yet
		cfg.CSAM_SCAN = "off";
		expect(flagEnabledOr("multimodal", () => false)).toBe(true);
		cfg.MULTIMODAL_ENABLED = "false";
		expect(flagEnabledOr("multimodal", () => false)).toBe(false);
		delete cfg.MULTIMODAL_ENABLED;
		cfg.ALPHA_EDITION = "community"; // set and not hosted: CSAM_SCAN=off honoured, no consent default
		expect(flagEnabledOr("multimodal", () => false)).toBe(false);
		cfg.MULTIMODAL_ENABLED = "true";
		expect(flagEnabledOr("multimodal", () => false)).toBe(true);
	});

	it("with PostHog unset, custodial-storage-view reads on for any chosen backend with no Hugging Face token, and off with none chosen", () => {
		expect(flagEnabledOr("custodial-storage-view", () => false)).toBe(false);
		for (const backend of ["local", "s3", "hf"]) {
			cfg.CUSTODIAL_STORAGE_BACKEND = backend;
			expect(flagEnabledOr("custodial-storage-view", () => false), backend).toBe(true);
		}
		expect(cfg.HF_BUCKETS_TOKEN).toBeUndefined();
	});

	it("ALPHA_EDITION=hosted with PostHog unset gets no self-host default: custodial-storage-view and multimodal read their code fallback, off", () => {
		cfg.ALPHA_EDITION = "hosted";
		cfg.CUSTODIAL_STORAGE_BACKEND = "local";
		cfg.CSAM_SCAN = "off";
		expect(flagEnabledOr("custodial-storage-view", () => false)).toBe(false);
		expect(flagEnabledOr("multimodal", () => false)).toBe(false);
	});

	it("with PostHog unset, read-aloud stays off with HF_TOKEN set (boot copies OPENAI_API_KEY into it) and turns on only by ALPHA_FLAGS", () => {
		cfg.HF_TOKEN = "none";
		expect(flagEnabledOr("read-aloud", () => false)).toBe(false);
		cfg.ALPHA_FLAGS = "+read-aloud";
		expect(flagEnabledOr("read-aloud", () => false)).toBe(true);
	});

	it("with PostHog unset, an on-when-env flag whose env var is the word false reads off", () => {
		cfg.TRANSCRIPTION_MODEL = "false";
		expect(flagEnabledOr("dictation", () => false)).toBe(false);
	});

	it("with PostHog unset, a key the registry does not declare reads its caller's fallback", () => {
		expect(flagEnabledOr("not-a-registered-key", () => true)).toBe(true);
		expect(flagEnabledOr("not-a-registered-key", () => false)).toBe(false);
	});

	it("ALPHA_FLAGS -key turns off a default-on flag", () => {
		cfg.ALPHA_FLAGS = `-${onKey}`;
		expect(flagEnabledOr(onKey, () => false)).toBe(false);
	});

	it("ALPHA_FLAGS +key turns on a default-off flag and leaves every other flag at its default", () => {
		cfg.ALPHA_FLAGS = ` +${offKey} , -nothing-here `;
		expect(flagEnabledOr(offKey, () => false)).toBe(true);
		expect(flagEnabledOr(onKey, () => false)).toBe(true);
	});

	it("ALPHA_FLAGS +key on an on-when-env flag turns it on with its env unset", () => {
		cfg.ALPHA_FLAGS = "+dictation";
		expect(flagEnabledOr("dictation", () => false)).toBe(true);
	});

	it("a per-user flag with PostHog unset reads its self-host default, and ALPHA_FLAGS overrides it", async () => {
		expect(await flagEnabledForUser(onKey, "acct-1", {}, () => false)).toBe(true);
		cfg.ALPHA_FLAGS = `-${onKey}`;
		expect(await flagEnabledForUser(onKey, "acct-1", {}, () => false)).toBe(false);
		expect(getFeatureFlag).not.toHaveBeenCalled();
	});

	it("with PostHog unset, the safety, access and security flags still awaiting a decision read off, each though its code fallback is on", () => {
		const awaitingDecision = [
			"violence-recheck", "support-signal-classifier", "groundcheck", "guard-primary",
			"self-harm-distress-declines", "s1-safety-judge", "mila-sp-output-guard",
			"guard-history-cap", "workspace-org-creation", "document-attachments", "document-text-only", "mcp-servers",
		];
		for (const k of awaitingDecision) expect(flagEnabledOr(k, () => true), k).toBe(false);
	});

	it("with PostHog unset, agent-mode-access reads on for a signed-in account, so a self-host reaches the agent toggle once agent-mode is on", async () => {
		expect(await flagEnabledForUser("agent-mode-access", "acct-1", {}, () => false)).toBe(true);
		expect(getFeatureFlag).not.toHaveBeenCalled();
	});

	it("every registry key declares a self-host default", () => {
		for (const f of FLAG_KEYS) expect(f.selfHost, f.key).toBeDefined();
	});
});

describe("self-host defaults, PostHog configured", () => {
	beforeEach(() => {
		cfg.PUBLIC_POSTHOG_KEY = "phc_test";
	});

	it("with PostHog set, self-host defaults are ignored: a default-on flag reads its code fallback before the first poll", () => {
		expect(flagEnabledOr(onKey, () => false)).toBe(false);
		expect(flagEnabledOr(offKey, () => true)).toBe(true);
	});

	it("with PostHog set, ALPHA_FLAGS is ignored", () => {
		cfg.ALPHA_FLAGS = `+${offKey},-${onKey}`;
		expect(flagEnabledOr(offKey, () => false)).toBe(false);
		expect(flagEnabledOr(onKey, () => true)).toBe(true);
	});

	it("with PostHog set, a per-user flag asks PostHog and ignores the self-host default", async () => {
		getFeatureFlag.mockResolvedValue(false);
		expect(await flagEnabledForUser(onKey, "acct-1", {}, () => true)).toBe(false);
		expect(getFeatureFlag).toHaveBeenCalledTimes(1);
	});
});
