import { describe, it, expect, vi, beforeEach } from "vitest";

const pageData: { loginEnabled: boolean; automaticLogin: boolean; user: unknown } = {
	loginEnabled: false,
	automaticLogin: false,
	user: null,
};
const gotoMock = vi.fn();

vi.mock("$app/navigation", () => ({ goto: (...args: unknown[]) => gotoMock(...args) }));
vi.mock("$app/state", () => ({
	page: {
		get data() {
			return pageData;
		},
		url: new URL("https://example.test/chat"),
	},
}));

const { requireAuthUser } = await import("./auth");

describe("requireAuthUser — sign-in must be MANDATORY, not merely offered, to force a redirect", () => {
	beforeEach(() => {
		gotoMock.mockClear();
		pageData.loginEnabled = false;
		pageData.automaticLogin = false;
		pageData.user = null;
	});

	it("does not redirect when sign-in is merely configured but not mandatory (CUR-246's env=preview case)", () => {
		pageData.loginEnabled = true;
		pageData.automaticLogin = false;
		expect(requireAuthUser()).toBe(false);
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it("redirects when sign-in is both configured and mandatory, for a signed-out visitor", () => {
		pageData.loginEnabled = true;
		pageData.automaticLogin = true;
		expect(requireAuthUser()).toBe(true);
		expect(gotoMock).toHaveBeenCalledOnce();
		expect(gotoMock.mock.calls[0][0]).toContain("/login?next=");
	});

	it("does not redirect a signed-in user even when sign-in is mandatory", () => {
		pageData.loginEnabled = true;
		pageData.automaticLogin = true;
		pageData.user = { id: "u1" };
		expect(requireAuthUser()).toBe(false);
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it("does not redirect when sign-in isn't configured at all", () => {
		pageData.loginEnabled = false;
		pageData.automaticLogin = false;
		expect(requireAuthUser()).toBe(false);
		expect(gotoMock).not.toHaveBeenCalled();
	});
});
