/**
 * per-user throttle on workspace invitations. betterAuth.ts's own `tooManyRecentInvitationSends`
 * (CUR-550) is keyed on the invite's TARGET email — it stops a flood of resends to one arbitrary
 * inbox, but does nothing to stop one account spreading invites across many DIFFERENT target
 * addresses, especially once `organizationLimit` still allows several workspaces per user. This is
 * the missing dimension: keyed on the INVITING user, not the recipient.
 *
 * Counted through eventWindow.ts on the (user_id, type, expires_at) index, like every other limit on
 * the message_events table.
 *
 * FAIL OPEN, same posture as every other cap on this table: a DB blip must never block a legitimate
 * invite, so a count/insert error just logs and allows the send. (CUR-912)
 */
import { config } from "$lib/chat/server/config";
import { recordEvent, underEventLimit } from "$lib/chat/server/db/eventWindow";

const TYPE = "workspaceInvite";
const LABEL = "workspace-invite";
const WINDOW_MS = 24 * 60 * 60_000;

// Optional deploy knobs (read via Reflect.get so they need no committed .env entry).
// Default: 20 invites per 24h per user — generous for a real admin onboarding
// a team, small enough to bound a spread-across-many-addresses spam run.
//
// An account younger than a week gets 5. At 20, two fresh accounts (an email code each)
// spend the whole site-wide ceiling below and block every real admin's invites for the day; at 5 it
// takes six verified inboxes, and an established account keeps its full allowance. (CUR-4168)
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60_000;

export function maxInvitesPerDay(accountCreatedAt?: Date | string | null): number {
	const full = Number(Reflect.get(config, "WORKSPACE_INVITE_MAX_PER_DAY")) || 20;
	if (!accountCreatedAt) return full;
	const age = Date.now() - new Date(accountCreatedAt).getTime();
	if (!(age < NEW_ACCOUNT_MS)) return full;
	const fresh = Number(Reflect.get(config, "WORKSPACE_INVITE_NEW_ACCOUNT_MAX_PER_DAY")) || 5;
	return Math.min(full, fresh);
}

/** True if this user is under the recent-invite-send limit (allowed to send another). Fail-open. */
export async function workspaceInviteAllowed(
	userId: string | null | undefined,
	accountCreatedAt?: Date | string | null
): Promise<boolean> {
	if (!userId) return true;
	return underEventLimit({ type: TYPE, userId }, maxInvitesPerDay(accountCreatedAt), LABEL);
}

/** Record one workspace-invite send for this user (TTL = the window). Best-effort. */
export async function recordWorkspaceInviteSend(userId: string | null | undefined): Promise<void> {
	if (!userId) return;
	await recordEvent({ type: TYPE, userId }, WINDOW_MS, LABEL);
}

// Every cap above is keyed on something a spammer can multiply (accounts are an email code
// away). This one counts every invitation on the site under one fixed key, so the (user_id, type,
// expires_at) index serves it. It is a circuit breaker, not an allowance: real invitation volume is
// far below 500, so it is reached only by abuse. Invitation mail and sign-in codes share one Resend
// account, so sign-in codes get their own share (CUR-4172) and invites can never starve them. (CUR-3194)
const SITE_TYPE = "workspaceInviteSite";
const SITE_KEY = "site";

function maxSiteInvitesPerDay(): number {
	return Number(Reflect.get(config, "WORKSPACE_INVITE_SITE_MAX_PER_DAY")) || 500;
}

/** True while the whole site is under its daily invitation ceiling. Fail-open, like the per-user cap. */
export async function siteInviteAllowed(): Promise<boolean> {
	return underEventLimit({ type: SITE_TYPE, userId: SITE_KEY }, maxSiteInvitesPerDay(), LABEL);
}

/** Record one invitation against the site-wide ceiling. Best-effort. */
export async function recordSiteInviteSend(): Promise<void> {
	await recordEvent({ type: SITE_TYPE, userId: SITE_KEY }, WINDOW_MS, LABEL);
}
