/**
 * resolvePreviewScreenStub is the only way a live request gets a screen that allows
 * everything. Every case is the same contract: the stub needs a preview (or development) deployment,
 * the fault-inject token, and `x-e2e-screen: stub` (not at develop.aipotluck.org) or `stub-tagged`
 * (SOL-178, there too), all at once, and any one missing returns false, the real screen. (CUR-3110)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.E2E_FAULT_INJECT_TOKEN = "test-secret-value";
	delete process.env.VERCEL_ENV;
	delete process.env.DEPLOY_ENV;
});

async function importSubject() {
	return import("./previewScreenStub");
}

function req({ token, screen, host = "aipotluck-abc123-current-ai.vercel.app" }: { token?: string; screen?: string; host?: string } = {}): Request {
	const headers = new Headers();
	if (token !== undefined) headers.set("x-e2e-fault-inject-token", token);
	if (screen !== undefined) headers.set("x-e2e-screen", screen);
	return new Request(`https://${host}/chat/conversation/abc123`, { method: "POST", headers });
}

const asked = () => req({ token: "test-secret-value", screen: "stub" });

describe("resolvePreviewScreenStub (CUR-3110)", () => {
	it("stubs a PR preview's send that carries the token and asks for the stub", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(asked(), "feature/cur-3110-x")).toBe(true);
	});

	it("keeps the real screen on develop.aipotluck.org, the URL people walk, header and token or not", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		const alias = req({ token: "test-secret-value", screen: "stub", host: "develop.aipotluck.org" });
		expect(await resolvePreviewScreenStub(alias, "develop")).toBe(false);
	});

	it("stubs a plain stub on a develop build reached at its own deployment URL, where CI runs (SOL-198)", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(asked(), "develop")).toBe(true);
	});

	it("stubs develop's send from a @stub-screen spec, which asks with stub-tagged (SOL-178)", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		const tagged = req({ token: "test-secret-value", screen: "stub-tagged" });
		expect(await resolvePreviewScreenStub(tagged, "develop")).toBe(true);
		expect(await resolvePreviewScreenStub(tagged, "feature/cur-3110-x")).toBe(true);
	});

	it("keeps the real screen in production even for stub-tagged with the token (SOL-178)", async () => {
		process.env.VERCEL_ENV = "production";
		const { resolvePreviewScreenStub } = await importSubject();
		const tagged = req({ token: "test-secret-value", screen: "stub-tagged" });
		expect(await resolvePreviewScreenStub(tagged, "main")).toBe(false);
	});

	it("keeps the real screen for stub-tagged without the token, develop included (SOL-178)", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(req({ token: "nope", screen: "stub-tagged" }), "develop")).toBe(false);
	});

	it("keeps the real screen in production, header and token or not", async () => {
		process.env.VERCEL_ENV = "production";
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(asked(), "main")).toBe(false);
	});

	it("keeps the real screen when the token is wrong", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(req({ token: "nope", screen: "stub" }), "pr")).toBe(false);
	});

	it("keeps the real screen when the send does not ask for the stub", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(req({ token: "test-secret-value" }), "pr")).toBe(false);
	});

	it("keeps the real screen when no token is configured on the deployment", async () => {
		process.env.VERCEL_ENV = "preview";
		delete cfg.E2E_FAULT_INJECT_TOKEN;
		const { resolvePreviewScreenStub } = await importSubject();
		expect(await resolvePreviewScreenStub(asked(), "pr")).toBe(false);
	});
});

describe("the stub screens (CUR-3110)", () => {
	it("allows an output batch, after a pause the release-timing specs can see", async () => {
		const { stubOutputScreen } = await importSubject();
		const t0 = performance.now();
		expect(await stubOutputScreen()).toEqual({ blocked: false, kind: null });
		// STUB_SCREEN_MS is 200; a few ms of timer slack below it.
		expect(performance.now() - t0).toBeGreaterThanOrEqual(195);
	});

	it("allows the input with no chunks screened, so its timing line shows the stub", async () => {
		const { stubGuardVerdict } = await importSubject();
		const v = await stubGuardVerdict();
		expect(v.contentPolicy).toEqual({ action: "allow" });
		expect(v.childSafety).toEqual({ flagged: false });
		expect(v.guardChunks).toBe(0);
	});
});
