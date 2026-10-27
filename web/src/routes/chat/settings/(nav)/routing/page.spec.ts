import { describe, expect, it, vi } from "vitest";
import { isRedirect } from "@sveltejs/kit";

// The routing lab is developer-only: a production build (`dev` false) lets an admin in and sends
// every other visitor who has the URL to Settings, the same gate as its Dev-badged nav entry.
vi.mock("$app/environment", () => ({ dev: false, browser: false, building: false, version: "test" }));

const { load } = await import("./+page");

const run = (isAdmin: boolean) => load({ parent: async () => ({ isAdmin }) } as unknown as Parameters<typeof load>[0]);

describe("/chat/settings/routing on a production build", () => {
	it("redirects a visitor who is not an admin to Settings, so the lab is not live on prod", async () => {
		const thrown = await run(false).then(
			() => undefined,
			(e: unknown) => e
		);
		expect(isRedirect(thrown), "a non-admin reached the routing lab on a production build").toBe(true);
		expect(thrown).toMatchObject({ status: 302, location: expect.stringMatching(/\/settings$/) });
	});

	it("opens for an admin", async () => {
		await expect(run(true)).resolves.toEqual({});
	});
});
