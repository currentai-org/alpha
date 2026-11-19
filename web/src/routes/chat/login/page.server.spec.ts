import { describe, it, expect, vi, beforeEach } from "vitest";

// providers.huggingface must reflect real config, the same way google/github do, so an "always configured"
// assumption about Hugging Face cannot go unverified.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const oidConfig: { CLIENT_ID: string } = { CLIENT_ID: "" };
vi.mock("$lib/chat/server/oidcConfig", () => ({ OIDConfig: oidConfig }));

// the providers Better Auth registered, which decide whether the organisation button shows.
const registered: { ids: string[] } = { ids: [] };
vi.mock("$lib/chat/server/betterAuth", () => ({
	getAuth: () => ({ $context: Promise.resolve({ socialProviders: registered.ids.map((id) => ({ id })) }) }),
}));

// the user rows selfHostSignUp.ts reads to decide whether password sign-up is closed.
const accounts: { rows: { id: string }[] } = { rows: [] };
vi.mock("$lib/chat/server/db/client", () => {
	const query = { from: () => query, limit: async () => accounts.rows };
	return { schema: { user: { id: "id" } }, getDb: () => ({ select: () => query }) };
});

const { load } = await import("./+page.server");

type User = { id: string } | undefined;
function fakeEvent(opts?: { user?: User; next?: string }) {
	const url = new URL("https://develop.aipotluck.org/chat/login");
	if (opts?.next !== undefined) url.searchParams.set("next", opts.next);
	return { locals: { user: opts?.user }, url } as Parameters<typeof load>[0];
}

// `load`'s declared PageServerLoad type widens its return with `| void` (SvelteKit's generic default
// for an unparameterized load type) — never actually void here, since every reachable path returns
// `{ providers, next }` or throws via redirect. Narrow it once rather than casting
// per call.
async function loadProviders(
	opts?: Parameters<typeof fakeEvent>[0]
): Promise<{ providers: Record<string, boolean | string | null>; next?: string }> {
	return (await load(fakeEvent(opts))) as { providers: Record<string, boolean | string | null>; next?: string };
}

function catchRedirect(
	promise: ReturnType<typeof load>
): Promise<{ status?: number; location?: string }> {
	return Promise.resolve(promise).then(
		() => ({}),
		(e: unknown) => e as { status?: number; location?: string }
	);
}

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	oidConfig.CLIENT_ID = "";
	registered.ids = [];
});

describe("login +page.server load — providers reflect config, not an assumption", () => {
	it("offers the organisation's own login under the name its operator set, read from the same env betterAuth.ts registers it from", async () => {
		Object.assign(cfg, {
			OIDC_ISSUER: "https://login.example.org",
			OIDC_CLIENT_ID: "alpha",
			OIDC_CLIENT_SECRET: "s3cret",
			OIDC_PROVIDER_NAME: "Example Org",
		});
		registered.ids = ["org-oidc"];
		expect((await loadProviders()).providers.org).toBe("Example Org");
		registered.ids = [];
		expect(
			(await loadProviders()).providers.org,
			"a provider Better Auth skipped at startup (unreachable issuer, no JWKS) offers no button"
		).toBeNull();
		registered.ids = ["org-oidc"];
		delete cfg.OIDC_CLIENT_SECRET;
		expect((await loadProviders()).providers.org, "a half-set provider offers no button").toBeNull();
	});

	it("offers email and password only on a self-host with no mailer, and email codes everywhere else", async () => {
		cfg.ALPHA_EDITION = "selfhost";
		let data = (await load(fakeEvent())) as { emailSignIn: string };
		expect(data.emailSignIn).toBe("password");
		cfg.SMTP_URL = "smtp://mailpit:1025";
		data = (await load(fakeEvent())) as { emailSignIn: string };
		expect(data.emailSignIn, "a self-host with SMTP sends codes").toBe("code");
		delete cfg.SMTP_URL;
		cfg.ALPHA_EDITION = "hosted";
		data = (await load(fakeEvent())) as { emailSignIn: string };
		expect(data.emailSignIn, "a hosted deployment never offers a password").toBe("code");
	});

	it("says password sign-up is closed once an account exists on a mailless self-host, and open with ALPHA_OPEN_SIGNUP=true", async () => {
		cfg.ALPHA_EDITION = "selfhost";
		accounts.rows = [];
		let data = (await load(fakeEvent())) as { signUpClosed: boolean };
		expect(data.signUpClosed, "the first account can be created").toBe(false);
		accounts.rows = [{ id: "operator" }];
		data = (await load(fakeEvent())) as { signUpClosed: boolean };
		expect(data.signUpClosed, "a second sign-up is refused").toBe(true);
		cfg.ALPHA_OPEN_SIGNUP = "true";
		data = (await load(fakeEvent())) as { signUpClosed: boolean };
		expect(data.signUpClosed, "the operator reopened sign-up").toBe(false);
		delete cfg.ALPHA_OPEN_SIGNUP;
		cfg.ALPHA_EDITION = "hosted";
		data = (await load(fakeEvent())) as { signUpClosed: boolean };
		expect(data.signUpClosed, "a hosted deployment is never limited").toBe(false);
		accounts.rows = [];
	});

	it("offers no OAuth provider when none are configured", async () => {
		const result = await loadProviders();
		expect(result.providers).toEqual({ google: false, github: false, huggingface: false, org: null });
	});

	it("offers huggingface only when OIDConfig.CLIENT_ID is set, independently of google/github", async () => {
		oidConfig.CLIENT_ID = "hf-client-id";
		const result = await loadProviders();
		expect(result.providers).toEqual({ google: false, github: false, huggingface: true, org: null });
	});

	it("offers all three when all three are configured", async () => {
		cfg.GOOGLE_CLIENT_ID = "google-id";
		cfg.GITHUB_CLIENT_ID = "github-id";
		oidConfig.CLIENT_ID = "hf-client-id";
		const result = await loadProviders();
		expect(result.providers).toEqual({ google: true, github: true, huggingface: true, org: null });
	});
});

// The login load must honour `next`. A new visitor invited to a workspace signs up via this page,
// and the invitation-accept redirect that sent them here has to survive it: without it they land on the
// bare app root with no trace of the invitation. The sending side (workspace/accept/[id]'s own load, see
// its page.server.spec.ts) is the other half.
describe("login +page.server load — `next`", () => {
	it("returns a valid same-app `next` for an unauthenticated visitor to use once signed in", async () => {
		const result = await loadProviders({ next: "/chat/workspace/accept/inv-1" });
		expect(result.next).toBe("/chat/workspace/accept/inv-1");
	});

	it("is undefined when no `next` was given", async () => {
		const result = await loadProviders();
		expect(result.next).toBeUndefined();
	});

	// SAFETY: `next` is untrusted query-string input. Accepting an off-origin or protocol-relative
	// value here would make this page an open redirect once a real destination is wired up client-side.
	it("drops a `next` that isn't a same-app path — never a full URL", async () => {
		const result = await loadProviders({ next: "https://evil.example/phish" });
		expect(result.next).toBeUndefined();
	});

	it("drops a protocol-relative `next` (`//evil.example`)", async () => {
		const result = await loadProviders({ next: "//evil.example/phish" });
		expect(result.next).toBeUndefined();
	});

	it("drops a `next` outside the app's own base path", async () => {
		const result = await loadProviders({ next: "/other-app/page" });
		expect(result.next).toBeUndefined();
	});

	// On the chat surface `base` is "", so the prefix check alone would pass these.
	it("drops a protocol-relative, backslash or control-character `next` (open redirect), on either surface", async () => {
		for (const next of ["//evil.com/x", "/chat/\\evil.com", "/\\evil.com", "/chat/a\r\nSet-Cookie: x=1"]) {
			const result = await loadProviders({ next });
			expect(result.next, next).toBeUndefined();
		}
	});

	it("redirects an already-signed-in visitor to their valid `next`, not the bare root", async () => {
		const threw = await catchRedirect(
			load(fakeEvent({ user: { id: "u1" }, next: "/chat/workspace/accept/inv-1" }))
		);
		expect(threw.status).toBe(302);
		expect(threw.location).toBe("/chat/workspace/accept/inv-1");
	});

	it("redirects an already-signed-in visitor with no `next` to the bare root, unchanged", async () => {
		const threw = await catchRedirect(load(fakeEvent({ user: { id: "u1" } })));
		expect(threw.status).toBe(302);
		expect(threw.location).toBe("/chat/");
	});

	it("redirects an already-signed-in visitor with an invalid `next` to the bare root, not the invalid value", async () => {
		const threw = await catchRedirect(
			load(fakeEvent({ user: { id: "u1" }, next: "https://evil.example/phish" }))
		);
		expect(threw.status).toBe(302);
		expect(threw.location).toBe("/chat/");
	});
});
