/**
 * The site-wide invitation ceiling is shared by everyone, so it must not be reachable by a
 * couple of accounts made a day ago. The event store is an in-memory counter here, since the test is
 * about which allowance each account gets. `eventWindow.spec.ts` covers the SQL window. (CUR-4168)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const counts = new Map<string, number>();
const keyOf = (k: { type: string; userId: string }) => `${k.type}:${k.userId}`;
vi.mock("$lib/chat/server/db/eventWindow", () => ({
	underEventLimit: async (k: { type: string; userId: string }, max: number) =>
		(counts.get(keyOf(k)) ?? 0) < max,
	recordEvent: async (k: { type: string; userId: string }) => {
		counts.set(keyOf(k), (counts.get(keyOf(k)) ?? 0) + 1);
	},
}));

const {
	maxInvitesPerDay,
	workspaceInviteAllowed,
	recordWorkspaceInviteSend,
	siteInviteAllowed,
	recordSiteInviteSend,
} = await import("./workspaceInviteRate");

const DAY = 24 * 60 * 60_000;

beforeEach(() => {
	counts.clear();
	for (const k of Object.keys(cfg)) delete cfg[k];
});

describe("workspace invite allowance (CUR-4168)", () => {
	it("two day-old accounts sending until refused leave the site-wide ceiling open for everyone else", async () => {
		const dayOld = new Date(Date.now() - DAY);
		let sent = 0;
		for (const id of ["throwaway-1", "throwaway-2"]) {
			while (await workspaceInviteAllowed(id, dayOld)) {
				await recordWorkspaceInviteSend(id);
				await recordSiteInviteSend();
				sent++;
			}
		}
		expect(sent).toBe(10);
		expect(await siteInviteAllowed()).toBe(true);
	});

	it("the site-wide ceiling is a circuit breaker: it refuses the 501st invitation of a day, not the 31st (CUR-4172)", async () => {
		for (let i = 0; i < 499; i++) await recordSiteInviteSend();
		expect(await siteInviteAllowed()).toBe(true);
		await recordSiteInviteSend();
		expect(await siteInviteAllowed()).toBe(false);
	});

	it("an account older than a week keeps the full daily allowance", () => {
		expect(maxInvitesPerDay(new Date(Date.now() - 8 * DAY))).toBe(20);
		expect(maxInvitesPerDay(null)).toBe(20);
	});

	it("never gives a new account more than the full allowance, even when its own knob is set higher", () => {
		cfg.WORKSPACE_INVITE_MAX_PER_DAY = "3";
		cfg.WORKSPACE_INVITE_NEW_ACCOUNT_MAX_PER_DAY = "10";
		expect(maxInvitesPerDay(new Date())).toBe(3);
	});
});
