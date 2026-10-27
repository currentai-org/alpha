// Who gets the staff tier. The contracts: a verified address on a team domain does; an
// unverified one, a look-alike domain, an e2e test account and a guest do not; the conversation cap
// for a team account is the staff tier's and never below the deployment's own. (CUR-4620)
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/config", () => ({ config: { USAGE_LIMITS: "{}", RATE_LIMIT: "" } }));

import { STAFF_TIER, TEAM_DOMAINS, isTeamAccount, isTestAccountEmail } from "./teamAccount";
import { conversationLimitFor } from "./usageLimits";

describe("isTeamAccount", () => {
	it("a verified currentai.org or publicai.co address is a team account, in any letter case", () => {
		expect(isTeamAccount({ email: "editor@currentai.org", emailVerified: true })).toBe(true);
		expect(isTeamAccount({ email: "Editor@PublicAI.co", emailVerified: true })).toBe(true);
		expect(TEAM_DOMAINS).toEqual(["currentai.org", "publicai.co"]);
	});

	it("an unverified team address is not, so an address nobody proved cannot claim the tier", () => {
		expect(isTeamAccount({ email: "editor@currentai.org", emailVerified: false })).toBe(false);
		expect(isTeamAccount({ email: "editor@currentai.org" })).toBe(false);
	});

	it("a look-alike or sub-domain is not a team domain", () => {
		for (const email of ["x@currentai.org.evil.com", "x@evilcurrentai.org", "x@mail.currentai.org", "currentai.org@gmail.com"]) {
			expect(isTeamAccount({ email, emailVerified: true }), email).toBe(false);
		}
	});

	it("an e2e test account on a team domain is not, so the scenario specs still meet the visitor limits", () => {
		expect(isTestAccountEmail("e2e-0f1e@currentai.org")).toBe(true);
		expect(isTeamAccount({ email: "e2e-0f1e@currentai.org", emailVerified: true })).toBe(false);
	});

	it("a guest is not", () => {
		expect(isTeamAccount(undefined)).toBe(false);
		expect(isTeamAccount(null)).toBe(false);
	});
});

describe("conversationLimitFor", () => {
	const team = { email: "editor@currentai.org", emailVerified: true };
	const stranger = { email: "someone@gmail.com", emailVerified: true };

	it("a team account may hold the staff tier's conversations, a non-team account the deployment's 100", () => {
		expect(conversationLimitFor(team, 100)).toBe(STAFF_TIER.conversations);
		expect(conversationLimitFor(stranger, 100)).toBe(100);
	});

	it("never lowers a deployment's own cap, and adds none where the deployment has none", () => {
		expect(conversationLimitFor(team, 5000)).toBe(5000);
		expect(conversationLimitFor(team, undefined)).toBeUndefined();
	});
});
