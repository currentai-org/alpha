import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// agentMode reads AGENT_SERVICE_URL through the `config` proxy; the server test setup mocks $env to a
// static snapshot, so mock `config` directly with a mutable object we can vary per test.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

// Both gates read AGENT_MODE_FLAG through `flagEnabledOr` (CUR-1440). Mocked per-test rather than
// stubbed once: the flag is now a gate in its own right, so "the flag is on" has to be an explicit
// precondition of every test about the OTHER gates instead of an accident of module state.
const flagEnabledOrMock = vi.fn((_key: string, _fallback: () => boolean) => true);
// The per-account read (CUR-1440). Returns `boolean | undefined` — `undefined` is PostHog declining to
// answer, which the gate must treat as denial, so the mock's default is deliberately NOT a boolean.
const flagEnabledForUserMock =
	vi.fn<(key: string, id: string, props: Record<string, unknown>) => Promise<boolean | undefined>>();
// agentModeEnabledForUser() now awaits this before reading the flag, same as every other
// per-request flag consumer. Mocked resolved so existing tests don't need to know it exists; the
// dedicated test below asserts the call itself and its ordering. (CUR-1572)
const ensureFlagsPolledMock = vi.fn().mockResolvedValue(undefined);
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (key: string, fallback: () => boolean) => flagEnabledOrMock(key, fallback),
	flagEnabledForUser: (key: string, id: string, props: Record<string, unknown>) =>
		flagEnabledForUserMock(key, id, props),
	ensureFlagsPolled: () => ensureFlagsPolledMock(),
}));

/** A signed-in account. Synthetic values on purpose — WHICH accounts are allowed lives in the flag's
 *  release conditions in PostHog, never in this repo (flags.ts, "Do not rebuild the tester path"). */
const signedIn = {
	sessionId: "sess-1",
	isAdmin: false,
	user: { _id: { toString: () => "acct-1" }, email: "someone@example.test", emailVerified: true },
} as unknown as App.Locals;

/** No account — a visitor with only a client-supplied session cookie. */
const anonymous = { sessionId: "sess-1", isAdmin: false } as unknown as App.Locals;

// A missing URL on preview must be LOUD, not silent — assert the warn fires.
const warnMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: warnMock, info: vi.fn(), error: vi.fn() },
}));

const savedDeployEnv = process.env.DEPLOY_ENV;
const savedVercelEnv = process.env.VERCEL_ENV;

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	warnMock.mockReset();
	ensureFlagsPolledMock.mockReset();
	ensureFlagsPolledMock.mockResolvedValue(undefined);
	// Flag ON unless a test says otherwise — see the mock's comment.
	flagEnabledOrMock.mockReset();
	flagEnabledOrMock.mockImplementation(() => true);
	// Account allowed unless a test says otherwise, same reasoning as the flag above.
	flagEnabledForUserMock.mockReset();
	flagEnabledForUserMock.mockResolvedValue(true);
	delete process.env.DEPLOY_ENV;
	process.env.VERCEL_ENV = "preview";
});

afterEach(() => {
	if (savedDeployEnv === undefined) delete process.env.DEPLOY_ENV;
	else process.env.DEPLOY_ENV = savedDeployEnv;
	if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = savedVercelEnv;
});

describe("agentModeEnabled — the flag and deployEnv() both gate, the URL is config (CUR-770, CUR-1440)", () => {
	it("is ON on preview when a service URL is configured", async () => {
		cfg.AGENT_SERVICE_URL = "https://agent.test";
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(true);
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("is ON on production when the flag is on and a service URL is configured", async () => {
		cfg.AGENT_SERVICE_URL = "https://agent.test";
		process.env.VERCEL_ENV = "production";
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(true);
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("is OFF outside preview/production, even with a URL set — the deploy-env boundary, not a flag rollback", async () => {
		cfg.AGENT_SERVICE_URL = "https://agent.test";
		process.env.VERCEL_ENV = "development";
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
	});

	it("is OFF when neither DEPLOY_ENV nor VERCEL_ENV names a recognised environment", async () => {
		cfg.AGENT_SERVICE_URL = "https://agent.test";
		delete process.env.VERCEL_ENV;
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
	});

	// A missing URL on preview is NOT a silent off. It is a loud config error.
	it("preview with URL unset is a LOUD config error, not a silent toggle — withheld + warned", async () => {
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledOnce();
		expect(warnMock.mock.calls[0]![0]).toContain("AGENT_SERVICE_URL");
	});

	it("whitespace-only URL counts as unset — same loud config error", async () => {
		cfg.AGENT_SERVICE_URL = "   ";
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledOnce();
	});

	it("never warns outside preview/production — the deploy env is checked first", async () => {
		cfg.AGENT_SERVICE_URL = "https://agent.test";
		process.env.VERCEL_ENV = "development";
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("production with URL unset is the same loud config error as preview", async () => {
		process.env.VERCEL_ENV = "production";
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledOnce();
		expect(warnMock.mock.calls[0]![0]).toContain("AGENT_SERVICE_URL");
	});

	it("agentServiceUrl returns the address itself, trimmed — a URL, not a gate", async () => {
		cfg.AGENT_SERVICE_URL = "  https://agent.test  ";
		const { agentServiceUrl } = await import("./agentMode");
		expect(agentServiceUrl()).toBe("https://agent.test");
	});
});

describe("agentModeEnabledForUser — same two gates as agentModeEnabled() (CUR-771, CUR-1440)", () => {
	it("preview → true", async () => {
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(true);
	});

	// CUR-1572. Vercel Cron never fires on Preview, so `refreshFlags()` — the only other caller of
	// this poll — never runs there. Without ensuring it here, a cold Preview instance whose first
	// request lands on a page load reads `agent-mode` off an empty snapshot and silently denies an
	// allowed account.
	it("polls the flag snapshot before reading it, so a cold Preview instance doesn't deny on an empty cache", async () => {
		const { agentModeEnabledForUser } = await import("./agentMode");
		await agentModeEnabledForUser(signedIn);
		expect(ensureFlagsPolledMock).toHaveBeenCalledOnce();
		const pollOrder = ensureFlagsPolledMock.mock.invocationCallOrder[0]!;
		const readOrder = flagEnabledOrMock.mock.invocationCallOrder[0]!;
		expect(pollOrder).toBeLessThan(readOrder);
	});

	it("does not poll outside preview/production — the deploy-env check still comes first", async () => {
		process.env.VERCEL_ENV = "development";
		const { agentModeEnabledForUser } = await import("./agentMode");
		await agentModeEnabledForUser(signedIn);
		expect(ensureFlagsPolledMock).not.toHaveBeenCalled();
	});

	it("production → true when the flag is on", async () => {
		process.env.VERCEL_ENV = "production";
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(true);
	});

	it("outside preview/production → false, with no per-visitor escape hatch left to try", async () => {
		// No per-tester path exists (CUR-1278), so outside preview and production the deploy env alone
		// decides, whoever is signed in.
		process.env.VERCEL_ENV = "development";
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
	});
});

// THE CONTRACT THIS BLOCK PINS: turning the flag off HIDES agent mode, on production and preview
// alike, with no deploy (CUR-1440). A hardcoded `env in [preview, production]` check in either gate
// would make the flag vestigial, so a product decision to hide the feature could not be carried out by
// flipping it. These tests fail if anyone hardcodes the env check.
//
// Each asserts the flag is off BY ITSELF — service URL configured, env allowed, nothing else wrong.
describe("the flag hides agent mode without a deploy (CUR-1440)", () => {
	it("production is OFF when the flag is off, though the env is allowed and the URL is set", async () => {
		process.env.VERCEL_ENV = "production";
		cfg.AGENT_SERVICE_URL = "https://agent.example";
		flagEnabledOrMock.mockImplementation(() => false);
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
	});

	it("preview is OFF when the flag is off — hidden in both envs, not just production", async () => {
		process.env.VERCEL_ENV = "preview";
		cfg.AGENT_SERVICE_URL = "https://agent.example";
		flagEnabledOrMock.mockImplementation(() => false);
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
	});

	it("the per-user gate is OFF on production when the flag is off", async () => {
		process.env.VERCEL_ENV = "production";
		flagEnabledOrMock.mockImplementation(() => false);
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
	});

	it("the per-user gate is OFF on preview when the flag is off", async () => {
		process.env.VERCEL_ENV = "preview";
		flagEnabledOrMock.mockImplementation(() => false);
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
	});

	it("both gates read the flag by its registry key, not a literal typed twice", async () => {
		process.env.VERCEL_ENV = "production";
		cfg.AGENT_SERVICE_URL = "https://agent.example";
		const { agentModeEnabled, agentModeEnabledForUser, AGENT_MODE_FLAG } = await import("./agentMode");
		agentModeEnabled();
		await agentModeEnabledForUser(signedIn);
		expect(flagEnabledOrMock.mock.calls.map(([key]) => key)).toEqual([
			AGENT_MODE_FLAG,
			AGENT_MODE_FLAG,
		]);
	});

	it("falls back to HIDDEN, so a cold start or a flag PostHog never returns cannot expose it", async () => {
		// `flagEnabledOr` calls the thunk when it has never polled successfully, and again when it has
		// polled but the key is absent — the two paths that closed this gate invisibly in CUR-770.
		// Passing `() => false` is what makes both of them land on hidden rather than on exposed.
		process.env.VERCEL_ENV = "production";
		cfg.AGENT_SERVICE_URL = "https://agent.example";
		flagEnabledOrMock.mockImplementation((_key, fallback) => fallback());
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
	});

	it("does not blame a missing URL when the feature is simply switched off", async () => {
		// The flag is checked before the URL on purpose: a deliberate off is not a config error, and
		// logging one would send whoever reads it looking for a Doppler problem that isn't there.
		process.env.VERCEL_ENV = "production";
		flagEnabledOrMock.mockImplementation(() => false);
		const { agentModeEnabled } = await import("./agentMode");
		expect(agentModeEnabled()).toBe(false);
		expect(warnMock).not.toHaveBeenCalled();
	});
});

// THE CONTRACT: which ACCOUNTS see agent mode is a per-person PostHog evaluation against a SECOND
// key, keyed on the account's real id (CUR-1440). This is what lets the feature be hidden from
// everyone while staying usable by named accounts — the thing a single deployment-wide flag cannot
// express, because it is read with no person attached.
//
// The denial cases are the point. CUR-1278 deleted a per-tester path that fed PostHog a name the
// visitor typed, so the flag answered a question about whoever asked; and CUR-770 closed a gate
// invisibly when PostHog went quiet. Both failure shapes get a test here.
describe("agentModeEnabledForUser — per-account access (CUR-1440)", () => {
	it("is ON for an allowed account", async () => {
		process.env.VERCEL_ENV = "preview";
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(true);
	});

	it("is OFF for an account PostHog does not select, on an env where the feature exists", async () => {
		process.env.VERCEL_ENV = "preview";
		flagEnabledForUserMock.mockResolvedValue(false);
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
	});

	it("DENIES when PostHog declines to answer, rather than assuming the account is allowed", async () => {
		// `flagEnabledForUser` returns undefined when it has no client or the request failed. Reading
		// that as permission is the CUR-770 mistake pointed the other way: it would hand the feature to
		// everyone at the moment we stopped being able to tell who should have it.
		process.env.VERCEL_ENV = "preview";
		flagEnabledForUserMock.mockResolvedValue(undefined);
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
	});

	it("DENIES an anonymous visitor without evaluating anything against their session cookie", async () => {
		// The cookie is client-supplied. Passing it as a distinct id is exactly the defect CUR-1278
		// removed, so assert no per-person read happens at all — not merely that the answer is false.
		process.env.VERCEL_ENV = "preview";
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(anonymous)).resolves.toBe(false);
		expect(flagEnabledForUserMock).not.toHaveBeenCalled();
	});

	it("evaluates against the account's real id, and sends the email for release conditions to match", async () => {
		process.env.VERCEL_ENV = "preview";
		const { agentModeEnabledForUser, AGENT_MODE_ACCESS_FLAG } = await import("./agentMode");
		await agentModeEnabledForUser(signedIn);
		expect(flagEnabledForUserMock).toHaveBeenCalledWith(AGENT_MODE_ACCESS_FLAG, "acct-1", {
			email: "someone@example.test",
			env: "preview",
		});
	});

	it("sends no email for an unverified address on a team domain, so a team-only rule cannot match it (CUR-3182)", async () => {
		process.env.VERCEL_ENV = "preview";
		const { agentModeEnabledForUser, AGENT_MODE_ACCESS_FLAG } = await import("./agentMode");
		const unverified = {
			user: { _id: { toString: () => "acct-2" }, email: "someone@currentai.org", emailVerified: false },
		} as unknown as App.Locals;
		await agentModeEnabledForUser(unverified);
		expect(flagEnabledForUserMock).toHaveBeenCalledWith(AGENT_MODE_ACCESS_FLAG, "acct-2", {
			email: "",
			env: "preview",
		});
	});

	it("reads a DIFFERENT key from the deployment gate, so narrowing access cannot unregister the model", async () => {
		process.env.VERCEL_ENV = "preview";
		const { agentModeEnabledForUser, AGENT_MODE_FLAG, AGENT_MODE_ACCESS_FLAG } =
			await import("./agentMode");
		expect(AGENT_MODE_ACCESS_FLAG).not.toBe(AGENT_MODE_FLAG);
		await agentModeEnabledForUser(signedIn);
		expect(flagEnabledForUserMock.mock.calls[0]?.[0]).toBe(AGENT_MODE_ACCESS_FLAG);
		expect(flagEnabledOrMock.mock.calls[0]?.[0]).toBe(AGENT_MODE_FLAG);
	});

	it("makes NO per-person request where the deployment flag is off — that is what keeps it off real traffic", async () => {
		// The deployment read is checked first on purpose. With `agent-mode` off on production, a
		// production request costs zero PostHog round-trips; without that ordering, every chat page
		// load would pay one.
		process.env.VERCEL_ENV = "production";
		flagEnabledOrMock.mockImplementation(() => false);
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
		expect(flagEnabledForUserMock).not.toHaveBeenCalled();
	});

	it("makes no per-person request outside preview/production either", async () => {
		process.env.VERCEL_ENV = "development";
		const { agentModeEnabledForUser } = await import("./agentMode");
		await expect(agentModeEnabledForUser(signedIn)).resolves.toBe(false);
		expect(flagEnabledForUserMock).not.toHaveBeenCalled();
	});
});
