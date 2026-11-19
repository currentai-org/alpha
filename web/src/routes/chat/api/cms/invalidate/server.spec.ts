// Chat's own CMS publish webhook: the address www forwards every publish to on the chat
// host, where it clears chat's cached CMS reads and re-syncs a published policy page.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: { CMS_REVALIDATE_SECRET: "test-secret" } }));
const { clearCmsReads, syncPolicyPageLogged } = vi.hoisted(() => ({
	clearCmsReads: vi.fn(),
	syncPolicyPageLogged: vi.fn(),
}));
vi.mock("$lib/website.server", () => ({ clearCmsReads }));
vi.mock("$lib/chat/server/rag/policyPageSync", () => ({
	isPolicyPagePath: (path: unknown) => path === "/privacy-notice",
	syncPolicyPageLogged,
}));

import { POST } from "./+server";

function publish(body: unknown, secret?: string) {
	// @ts-expect-error - RequestEvent is heavier than this test needs
	return POST({
		request: new Request("https://alpha.aipotluck.org/chat/api/cms/invalidate", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(secret !== undefined ? { "x-cms-revalidate-secret": secret } : {}),
			},
			body: JSON.stringify(body),
		}),
	});
}

const policyPage = (status: string) => ({
	collection: "pages",
	doc: { breadcrumbs: [{ url: "/privacy-notice" }], _status: status },
});

beforeEach(() => {
	clearCmsReads.mockReset().mockResolvedValue([["payload", "maintenance-banner"]]);
	syncPolicyPageLogged.mockReset().mockResolvedValue(undefined);
});

describe("POST /chat/api/cms/invalidate", () => {
	it("refuses a publish with no secret or the wrong one, and touches nothing", async () => {
		await expect(publish(policyPage("published"))).rejects.toMatchObject({ status: 401 });
		await expect(publish(policyPage("published"), "test-secreX")).rejects.toMatchObject({ status: 401 });
		expect(clearCmsReads).not.toHaveBeenCalled();
		expect(syncPolicyPageLogged).not.toHaveBeenCalled();
	});

	it("clears chat's cached CMS reads for the publish and answers with the keys it cleared", async () => {
		const body = { global: "chat-maintenance", doc: { enabled: true } };
		const res = await publish(body, "test-secret");
		expect(res.status).toBe(200);
		expect(clearCmsReads).toHaveBeenCalledWith(body);
		expect(await res.json()).toEqual({ invalidated: [["payload", "maintenance-banner"]] });
		expect(syncPolicyPageLogged).not.toHaveBeenCalled();
	});

	it("re-syncs a published policy page into chat's retrieval", async () => {
		await publish(policyPage("published"), "test-secret");
		await vi.waitFor(() => expect(syncPolicyPageLogged).toHaveBeenCalledWith("/privacy-notice"));
	});

	it("leaves retrieval alone for a draft save of a policy page, and for any other page", async () => {
		await publish(policyPage("draft"), "test-secret");
		await publish(
			{ collection: "pages", doc: { breadcrumbs: [{ url: "/about" }], _status: "published" } },
			"test-secret"
		);
		expect(syncPolicyPageLogged).not.toHaveBeenCalled();
	});
});
