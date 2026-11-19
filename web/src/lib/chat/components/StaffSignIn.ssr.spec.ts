import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import StaffSignIn from "./StaffSignIn.svelte";

vi.mock("$app/state", () => ({ page: { url: new URL("http://localhost/chat/admin/reports") } }));

const text = (props: Record<string, unknown>) =>
	render(StaffSignIn, { props: props as never }).body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the staff sign-in message names why a signed-in account was refused", () => {
	it("names the operator role and the page when the role lacks that page's permission, and never says 'no staff role'", () => {
		const out = text({ signedIn: true, role: "operator", panel: "Reports" });
		expect(out).toContain("Your operator role doesn't include Reports");
		expect(out).not.toContain("no staff role");
	});

	it("says 'no staff role' only for a signed-in account that holds none", () => {
		expect(text({ signedIn: true, role: null })).toContain("Your account has no staff role");
		expect(text({ signedIn: true })).toContain("Your account has no staff role");
	});

	it("asks a signed-out visitor to sign in", () => {
		expect(text({ signedIn: false, role: null })).toContain("Sign in with an account");
	});
});
