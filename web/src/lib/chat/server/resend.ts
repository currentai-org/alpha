// The one call every Resend email goes through, with the sender address and the test domain none of
// them goes to. Its own module so a sender outside betterAuth.ts (newDeviceNotice.ts) shares it without
// importing the auth instance's module graph. Each caller keeps its own log lines and error reporting.
import { config } from "$lib/chat/server/config";

const RESEND_FROM = "AI Potluck <noreply@mail.aipotluck.org>";

/**
 * True for an address on `example.org`, which e2e suites use for every disposable test account.
 * IANA-reserved (RFC 2606) with a null MX (RFC 7505), so no real person holds one and a send there
 * only spends Resend's daily cap. Every Resend sender checks this before calling Resend (CUR-1254, CUR-1930).
 */
export function isReservedTestAddress(email: string): boolean {
	return email.toLowerCase().endsWith("@example.org");
}

/** What Resend answered: its message id, or the status and a capped copy of the body it refused with. */
export type ResendResult = { ok: true; id: string } | { ok: false; status: number; body: string };

/** Sends one plain-text email from RESEND_FROM. Throws only when the request itself fails. */
export async function sendViaResend(message: { to: string; subject: string; text: string }): Promise<ResendResult> {
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: RESEND_FROM, to: [message.to], subject: message.subject, text: message.text }),
	});
	if (!res.ok) {
		// Capped, not logged verbatim — this is a third party's response body, and an unbounded log
		// field is its own small liability regardless of what Resend happens to put in it today.
		return { ok: false, status: res.status, body: (await res.text().catch(() => "")).slice(0, 500) };
	}
	const { id } = (await res.json()) as { id: string };
	return { ok: true, id };
}
