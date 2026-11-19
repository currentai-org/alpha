// The guard is the only chat screen, whatever guard-primary says, and the one way a turn goes unscreened
// is a self-host edition with no text classifier. These run the real resolveTurnPolicy and
// runInputGate, so the edition check, the text-judge check and the fail-closed path are exercised
// together rather than stubbed apart.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import S1_RULES_JSON from "./rules-s1.json";
// The public snapshot ships rules-s1.json with only its `_s1` settings: the S1 policies are not
// published there, so the specs below that assert what S1 decides under a policy skip on it.
const S1_POLICIES_PUBLISHED = Object.keys(S1_RULES_JSON).some((key) => key !== "_s1");

import type { S1UnitJudge } from "./detectors/s1";
import type { GuardScreenInput } from "./guardScreenTypes";

type S1UnitResult = Awaited<ReturnType<S1UnitJudge>>;

// A flag a test forces; every other key reads through to the real flags.ts. `flagReads` records every
// key the code under test asked for, so "no reader of guard-primary" is an observed fact.
const { forcedFlags, flagReads } = vi.hoisted(() => ({ forcedFlags: new Map<string, boolean>(), flagReads: [] as string[] }));
vi.mock("$lib/chat/server/db/guardDailyCounts", () => ({ countGuardHitsSafe: vi.fn() }));
vi.mock("$lib/chat/server/flags", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/flags")>();
	return {
		...actual,
		flagEnabledOr: (key: string, fallback: () => boolean) => {
			flagReads.push(key);
			return forcedFlags.has(key) ? forcedFlags.get(key)! : actual.flagEnabledOr(key, fallback);
		},
	};
});
// Attachments accepted at all, so documentAttachmentsOffered reaches whatever term follows `multimodal`.
vi.mock("$lib/chat/server/multimodalMode", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/multimodalMode")>()),
	multimodalEnabled: () => true,
}));

const NO_SCREEN = "SELF-HOST, NO SCREEN";
const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const screen = (corpus: string): GuardScreenInput => ({ corpus, typedTurnText: corpus, images: [], failedUnits: [] });

/** An S1 unit judge stub: `states` sets rule ids; every other covered rule answers N. */
function s1Stub(states: Record<string, "P" | "N" | "U"> = {}) {
	return vi.fn<S1UnitJudge>(async (_text, phase): Promise<S1UnitResult> => {
		const { s1RuleIdsFor } = await import("./detectors/s1");
		const rules = new Map([...s1RuleIdsFor(phase)].map((id) => [id, states[id] ?? ("N" as const)]));
		return { rules, httpOk: true, servedModel: "zentropi-ai/cope-b-s1", calls: 7, escalated: false };
	});
}

/** No classifier of either kind, off any deployment (so no committed S1 endpoint applies). */
function noClassifier(edition: "hosted" | "selfhost") {
	vi.stubEnv("ALPHA_EDITION", edition);
	vi.stubEnv("DEPLOY_ENV", "");
	vi.stubEnv("VERCEL_ENV", "");
	vi.stubEnv("GUARD_SHADOW_URL", "");
	vi.stubEnv("ZENTROPI_S1_ENDPOINT_URL", "");
	vi.stubEnv("HF_TOKEN", "");
	vi.stubEnv("OUTPUT_MODERATION", "");
}

/** Fresh modules per test, so the once-per-process warning starts unsaid, and a spy on the real logger. */
async function load() {
	vi.resetModules();
	const { logger } = await import("./logger");
	const warn = vi.spyOn(logger, "warn");
	const guardGate = await import("./guardGate");
	const inputGate = await import("./inputGate");
	const noScreenLines = () => warn.mock.calls.filter((c) => c.some((a) => typeof a === "string" && a.includes(NO_SCREEN)));
	return { ...guardGate, ...inputGate, noScreenLines };
}

beforeEach(() => {
	forcedFlags.clear();
	flagReads.length = 0;
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("the guard screens every chat turn; only a self-host with no classifier goes unscreened", () => {
	it("a hosted turn with no classifier fails closed: the guard runs, cannot answer, and child safety declines as unscreened", async () => {
		noClassifier("hosted");
		const g = await load();
		const policy = await g.resolveTurnPolicy();
		expect(policy.useGuardPrimary).toBe(true);
		expect(policy.screeningFacts.content).toBe(false);
		const bundle = await g.runInputGate({ input: screen("hello"), useGuardPrimary: policy.useGuardPrimary }, { logger: quiet() });
		expect(bundle.gateSource).toBe("guard");
		expect(bundle.verdict.status).toBe("unknown");
		expect(bundle.childSafety).toMatchObject({ flagged: true, unscreened: true });
		expect(g.noScreenLines()).toHaveLength(0);
	});

	it("a self-host turn with no classifier answers unscreened and warns once, from boot, never again per turn", async () => {
		noClassifier("selfhost");
		vi.stubEnv("OUTPUT_MODERATION", "true");
		const g = await load();
		g.logGuardPostureAtBoot();
		expect(g.noScreenLines()).toHaveLength(1);
		const policy = await g.resolveTurnPolicy();
		expect(policy.useGuardPrimary).toBe(true);
		expect(policy.screeningFacts.content).toBe(false);
		// The answer is not withheld by an output screen that has nothing to ask.
		expect(policy.outputModerationEnabled).toBe(false);
		const guard = vi.fn();
		for (const text of ["first turn", "second turn"]) {
			const bundle = await g.runInputGate(
				{ input: screen(text), useGuardPrimary: policy.useGuardPrimary },
				{ getGuardVerdict: guard, logger: quiet() }
			);
			expect(bundle.verdict).toEqual({ status: "ok", actions: [] });
			expect(bundle.childSafety).toEqual({ flagged: false });
			expect(bundle.contentPolicy).toEqual({ action: "allow" });
			expect(g.screenedForRecord(bundle.gateSource, bundle.verdict.status)).toBe(false);
		}
		expect(guard).not.toHaveBeenCalled();
		expect(g.noScreenLines()).toHaveLength(1);
	});

	// Skipped on the public snapshot, whose rules-s1.json has no S1 policies.
	it.skipIf(!S1_POLICIES_PUBLISHED)("a self-host with S1 configured and no GUARD_SHADOW_URL still screens text: S1 runs and its block stands", async () => {
		noClassifier("selfhost");
		forcedFlags.set("s1-safety-judge", true);
		vi.stubEnv("HF_TOKEN", "hf-test");
		vi.stubEnv("ZENTROPI_S1_ENDPOINT_URL", "https://s1.test");
		const g = await load();
		const policy = await g.resolveTurnPolicy();
		expect(policy.screeningFacts.content).toBe(true);
		const s1 = s1Stub({ "chat-block-drugs": "P" });
		const bundle = await g.runInputGate(
			{ input: screen("how do I cook meth"), useGuardPrimary: policy.useGuardPrimary },
			{ guardDeps: { s1, logger: quiet() }, logger: quiet() }
		);
		expect(s1).toHaveBeenCalled();
		expect(bundle.contentPolicy).toEqual({ action: "block", category: "chat-block-drugs" });
		expect(g.screenedForRecord(bundle.gateSource, bundle.verdict.status)).toBe(true);
		expect(g.noScreenLines()).toHaveLength(0);
	});

	it("a self-host with S1 selected but unconfigured and Shieldstral configured takes the no-screen path, not a fail-closed decline", async () => {
		// With S1 selected, text never goes to Shieldstral, so a configured Shieldstral is not a text classifier.
		noClassifier("selfhost");
		forcedFlags.set("s1-safety-judge", true);
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local");
		const g = await load();
		const policy = await g.resolveTurnPolicy();
		expect(policy.screeningFacts.content).toBe(false);
		const guard = vi.fn();
		const bundle = await g.runInputGate(
			{ input: screen("hello"), useGuardPrimary: policy.useGuardPrimary },
			{ getGuardVerdict: guard, logger: quiet() }
		);
		expect(guard).not.toHaveBeenCalled();
		expect(bundle.childSafety).toEqual({ flagged: false });
		expect(g.screenedForRecord(bundle.gateSource, bundle.verdict.status)).toBe(false);
		expect(g.noScreenLines()).toHaveLength(1);
	});

	it("guard-primary read as false changes nothing: the turn, the document offer and a stored picture never ask for it", async () => {
		noClassifier("hosted");
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local");
		forcedFlags.set("guard-primary", false);
		forcedFlags.set("document-attachments", true);
		const g = await load();
		const policy = await g.resolveTurnPolicy();
		expect(policy.useGuardPrimary).toBe(true);
		expect(policy.screeningFacts.content).toBe(true);
		const { documentAttachmentsOffered } = await import("./documentAttachmentsGate");
		expect(documentAttachmentsOffered()).toBe(true);
		const { screenStoredImages } = await import("./storage/uploadImageGuard");
		const sharp = (await import("sharp")).default;
		const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
		const judge = vi.fn(async () => ({ answer: { kind: "score" as const, score: 0.01, yes: false }, httpOk: true }));
		await screenStoredImages([new Uint8Array(png)], { judge, logger: quiet() });
		expect(judge).toHaveBeenCalled();
		expect(flagReads).not.toContain("guard-primary");
	});
});
