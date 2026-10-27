import { describe, it, expect, vi, beforeEach } from "vitest";

// providers.huggingface must reflect real config, the same way google/github do, so an "always configured"
// assumption about Hugging Face cannot go unverified (CUR-605).
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const oidConfig: { CLIENT_ID: string } = { CLIENT_ID: "" };
vi.mock("$lib/chat/server/oidcConfig", () => ({ OIDConfig: oidConfig }));

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
): Promise<{ providers: Record<string, boolean>; next?: string }> {
	return (await load(fakeEvent(opts))) as { providers: Record<string, boolean>; next?: string };
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
});

describe("login +page.server load — providers reflect config, not an assumption", () => {
	it("offers no OAuth provider when none are configured", async () => {
		const result = await loadProviders();
		expect(result.providers).toEqual({ google: false, github: false, huggingface: false });
	});

	it("offers huggingface only when OIDConfig.CLIENT_ID is set, independently of google/github", async () => {
		oidConfig.CLIENT_ID = "hf-client-id";
		const result = await loadProviders();
		expect(result.providers).toEqual({ google: false, github: false, huggingface: true });
	});

	it("offers all three when all three are configured", async () => {
		cfg.GOOGLE_CLIENT_ID = "google-id";
		cfg.GITHUB_CLIENT_ID = "github-id";
		oidConfig.CLIENT_ID = "hf-client-id";
		const result = await loadProviders();
		expect(result.providers).toEqual({ google: true, github: true, huggingface: true });
	});
});

// The login load must honour `next`. A new visitor invited to a workspace signs up via this page,
// and the invitation-accept redirect that sent them here has to survive it: without it they land on the
// bare app root with no trace of the invitation. The sending side (workspace/accept/[id]'s own load, see
// its page.server.spec.ts) is the other half. (CUR-960)
describe("login +page.server load — `next` (CUR-960)", () => {
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

	// On the chat surface `base` is "", so the prefix check alone would pass these. (CUR-4448)
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
