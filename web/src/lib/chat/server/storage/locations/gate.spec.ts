import { beforeEach, describe, expect, it, vi } from "vitest";

// Stands in for PostHog's evaluation of `storage-locations` (flag 934504): its release groups need
// `env = preview` AND a team-domain `email`. A gate that leaves out either property can never be on.
const teamOnPreview = async (_key: string, _distinctId: string, props: Record<string, string>) =>
	props.env === "preview" && /@(currentai\.org|publicai\.co)$/.test(props.email ?? "");
const { flagEnabledForUser } = vi.hoisted(() => ({ flagEnabledForUser: vi.fn() }));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledForUser }));
vi.mock("$lib/chat/server/deployEnv", () => ({ deployEnv: () => "preview" }));

const { storageLocationsEnabledForUser, STORAGE_LOCATIONS_FLAG } = await import("./gate");

beforeEach(() => {
	flagEnabledForUser.mockReset();
	flagEnabledForUser.mockImplementation(teamOnPreview);
});

describe("storageLocationsEnabledForUser (CUR-3050)", () => {
	it("sends the account's email to PostHog, so a team account on preview gets the flag", async () => {
		expect(await storageLocationsEnabledForUser("acct-1", "someone@currentai.org")).toBe(true);
		expect(flagEnabledForUser).toHaveBeenCalledWith(STORAGE_LOCATIONS_FLAG, "acct-1", {
			env: "preview",
			email: "someone@currentai.org",
		});
	});

	it("stays off for an email outside the team domains", async () => {
		expect(await storageLocationsEnabledForUser("acct-2", "someone@example.com")).toBe(false);
	});

	it("stays off and sends no email key when the account has none", async () => {
		expect(await storageLocationsEnabledForUser("acct-3", undefined)).toBe(false);
		expect(flagEnabledForUser.mock.calls[0][2]).not.toHaveProperty("email");
	});

	it("treats an unevaluable flag as off", async () => {
		flagEnabledForUser.mockResolvedValueOnce(undefined);
		expect(await storageLocationsEnabledForUser("acct-4", "someone@currentai.org")).toBe(false);
	});
});
