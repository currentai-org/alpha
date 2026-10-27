import { describe, it, expect, vi, beforeEach } from "vitest";

// multimodalMode reads MULTIMODAL_ENABLED through the `config` proxy; the server test setup mocks $env
// to a static snapshot, so mock `config` directly with a mutable object we can vary per test.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

// The FLAG is the gate now; drive its answer directly. flags.spec.ts covers the plane's polling.
const flagEnabledOrMock = vi.fn((_key: string, fallback: () => boolean) => fallback());
const guestSignInFlagValuesMock = vi.fn(
	async (_sessionId: string, _timeoutMs?: number): Promise<ReadonlyMap<string, boolean> | undefined> => undefined
);
const fuzzOverrideValueMock = vi.fn((_key: string): boolean | undefined => undefined);
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: flagEnabledOrMock,
	guestSignInFlagValues: guestSignInFlagValuesMock,
	fuzzOverrideValue: fuzzOverrideValueMock,
}));

// A flag ON with the deployment's consent missing must be LOUD, not silent — assert the warn fires.
const warnMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: warnMock, info: vi.fn(), error: vi.fn() },
}));

// Dynamic, inside the tests: a static import is hoisted above the mock factories and would evaluate
// the module before `cfg` exists. Same shape as agentMode.spec.ts.
const load = () => import("./multimodalMode");

beforeEach(async () => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	flagEnabledOrMock.mockReset();
	flagEnabledOrMock.mockImplementation((_key, fallback) => fallback());
	warnMock.mockReset();
	guestSignInFlagValuesMock.mockReset();
	guestSignInFlagValuesMock.mockResolvedValue(undefined);
	fuzzOverrideValueMock.mockReset();
	fuzzOverrideValueMock.mockReturnValue(undefined);
	// The misconfiguration warn is latched once per PROCESS, and `load()` returns the SAME cached module
	// to every test in this file — so without this reset the first test to enter that branch would be the
	// only one that ever sees a warn, and every later assertion on it would fail for a reason having
	// nothing to do with what it was testing.
	(await load()).__resetMultimodalWarnForTest();
});

describe("multimodalEnabled — the flag is the gate, MULTIMODAL_ENABLED is the deployment's consent (CUR-159)", () => {
	it("BOTH keys, or shut: flag on plus MULTIMODAL_ENABLED=true is the only combination that opens it", async () => {
		const { multimodalEnabled, MULTIMODAL_FLAG } = await load();
		flagEnabledOrMock.mockReturnValue(true);
		cfg.MULTIMODAL_ENABLED = "true";
		expect(multimodalEnabled()).toBe(true);
		expect(flagEnabledOrMock.mock.calls[0]![0]).toBe(MULTIMODAL_FLAG);
	});

	it("flag OFF keeps it shut even with MULTIMODAL_ENABLED=true — an env var is no longer the switch", async () => {
		const { multimodalEnabled, multimodalConfigured } = await load();
		flagEnabledOrMock.mockReturnValue(false);
		cfg.MULTIMODAL_ENABLED = "true";
		expect(multimodalEnabled()).toBe(false);
		// The point of the migration: before CUR-159 this env var alone opened every multimodal seam,
		// so a single Doppler edit was the whole disable. It no longer decides anything on its own.
		expect(multimodalConfigured()).toBe(true);
	});

	it("flag ON with MULTIMODAL_ENABLED unset is a LOUD misconfiguration, not a silent off", async () => {
		const { multimodalEnabled } = await load();
		flagEnabledOrMock.mockReturnValue(true);
		expect(multimodalEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0]![0]).toMatch(/MULTIMODAL_ENABLED is unset/);
	});

	it("falls back to OFF when PostHog has never been polled — a gated feature defaults closed", async () => {
		// flagEnabledOr invokes the fallback thunk when there is no snapshot; assert OURS returns false,
		// which is the property that keeps a cold start or a PostHog failure from opening the surface.
		const { multimodalEnabled } = await load();
		cfg.MULTIMODAL_ENABLED = "true";
		expect(multimodalEnabled()).toBe(false);
		const [, fallback] = flagEnabledOrMock.mock.calls[0]!;
		expect(fallback()).toBe(false);
	});

	it("warns ONCE per process, not once per read — the misconfigured branch is also the chattiest", async () => {
		// Eight seams call this gate, one of them per chat request and one per attachment download, and
		// the branch is entered by a PostHog flip that needs no deploy. Repeating a static config fact on
		// every read buries the line that matters. What must NOT change is that the first one still fires — a quiet misconfiguration is
		// the failure this whole branch exists to prevent.
		const { multimodalEnabled } = await load();
		flagEnabledOrMock.mockReturnValue(true);
		for (let i = 0; i < 20; i++) expect(multimodalEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledTimes(1);
	});

	it("treats anything other than the literal string true as no consent", async () => {
		const { multimodalEnabled } = await load();
		flagEnabledOrMock.mockReturnValue(true);
		for (const v of ["", "false", "1", "yes", "TRUE ", " true"]) {
			cfg.MULTIMODAL_ENABLED = v;
			// " true" and "TRUE " are trimmed+lowercased and DO count; the rest must not.
			expect(multimodalEnabled()).toBe(v.trim().toLowerCase() === "true");
		}
	});
});

describe("resolveForceMultimodal — a stored user override is not a second way in (CUR-159)", () => {
	it("THE HOLE THIS CLOSES: an override set while multimodal was on does not survive turning it off", async () => {
		// Nothing expires the stored setting, and prepareMessagesWithFiles formats files off the message
		// HISTORY — so an override gated only on !isHuggingChat would, after one on-then-off cycle, keep
		// sending images from conversations that already hold them, with the deployment gate shut.
		const { resolveForceMultimodal } = await load();
		expect(resolveForceMultimodal({ isHuggingChat: false, override: true })).toBe(false);
	});

	it("honours the override only when the deployment gate is open", async () => {
		const { resolveForceMultimodal } = await load();
		flagEnabledOrMock.mockReturnValue(true);
		cfg.MULTIMODAL_ENABLED = "true";
		expect(resolveForceMultimodal({ isHuggingChat: false, override: true })).toBe(true);
		expect(resolveForceMultimodal({ isHuggingChat: false, override: false })).toBe(false);
		expect(resolveForceMultimodal({ isHuggingChat: false, override: undefined })).toBe(false);
	});

	it("ignores stored overrides on HuggingChat, where capability comes from the upstream router", async () => {
		const { resolveForceMultimodal } = await load();
		flagEnabledOrMock.mockReturnValue(true);
		cfg.MULTIMODAL_ENABLED = "true";
		expect(resolveForceMultimodal({ isHuggingChat: true, override: true })).toBe(false);
	});
});

describe("modelTakesImagesNow — the model list is shared, the image answer is per visitor (CUR-2725)", () => {
	it("a model that reads images is refused images for a visitor the flag does not select (a guest on preview)", async () => {
		const { modelTakesImagesNow } = await load();
		cfg.MULTIMODAL_ENABLED = "true";
		flagEnabledOrMock.mockReturnValue(false);
		expect(modelTakesImagesNow({ multimodal: true })).toBe(false);
	});

	it("the same model takes images for a visitor the flag selects (a team account)", async () => {
		const { modelTakesImagesNow } = await load();
		cfg.MULTIMODAL_ENABLED = "true";
		flagEnabledOrMock.mockReturnValue(true);
		expect(modelTakesImagesNow({ multimodal: true })).toBe(true);
	});

	it("a text-only model never takes images, whoever asks", async () => {
		const { modelTakesImagesNow } = await load();
		cfg.MULTIMODAL_ENABLED = "true";
		flagEnabledOrMock.mockReturnValue(true);
		expect(modelTakesImagesNow({ multimodal: false })).toBe(false);
		expect(modelTakesImagesNow({})).toBe(false);
	});
});

describe("multimodalOnSignIn — would signing in give a guest images? (CUR-2949)", () => {
	it("says yes only when the flag answers on for this guest signed in, asked for this guest with a bounded wait (CUR-3015)", async () => {
		cfg.MULTIMODAL_ENABLED = "true";
		guestSignInFlagValuesMock.mockResolvedValue(new Map([["multimodal", true]]));
		expect(await (await load()).multimodalOnSignIn("session-a")).toBe(true);
		const [sessionId, timeoutMs] = guestSignInFlagValuesMock.mock.calls[0]!;
		expect(sessionId).toBe("session-a");
		expect(timeoutMs).toBe(1500);
	});

	it("says no when the flag is team-only, so a guest is not promised photos by signing in", async () => {
		cfg.MULTIMODAL_ENABLED = "true";
		guestSignInFlagValuesMock.mockResolvedValue(new Map([["multimodal", false]]));
		expect(await (await load()).multimodalOnSignIn("session-a")).toBe(false);
	});

	it("says no while the answer is unread, rather than guessing yes", async () => {
		cfg.MULTIMODAL_ENABLED = "true";
		expect(await (await load()).multimodalOnSignIn("session-a")).toBe(false);
	});

	it("says no on a deployment that does not serve images, whatever the flag answers", async () => {
		guestSignInFlagValuesMock.mockResolvedValue(new Map([["multimodal", true]]));
		expect(await (await load()).multimodalOnSignIn("session-a")).toBe(false);
	});

	it("follows a forced flag over PostHog's answer, so a request with multimodal forced off is not promised photos by signing in (CUR-3979)", async () => {
		cfg.MULTIMODAL_ENABLED = "true";
		guestSignInFlagValuesMock.mockResolvedValue(new Map([["multimodal", true]]));
		fuzzOverrideValueMock.mockImplementation((key) => (key === "multimodal" ? false : undefined));
		expect(await (await load()).multimodalOnSignIn("session-a")).toBe(false);
		expect(guestSignInFlagValuesMock).not.toHaveBeenCalled();
	});
});
