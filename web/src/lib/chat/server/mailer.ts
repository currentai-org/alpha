// Where this deployment's email goes: Resend's HTTP API, any SMTP server, or nowhere.
//
// Precedence, fixed and in this order:
//   1. RESEND_API_KEY set: Resend. Every hosted deployment of ours sets it, so www, develop and the
//      previews send exactly as before, whatever else is in their env.
//   2. else SMTP_URL set: that SMTP server, through nodemailer. A self-hosted Alpha's own mail server,
//      or any provider's SMTP relay (Resend's included).
//   3. else none. On the self-host edition (ALPHA_EDITION=selfhost) email-and-password sign-in takes
//      the place of the email code (emailPasswordSignIn below); anywhere else sign-in by email is down
//      and betterAuth.ts says so in its log.
import type { Transporter } from "nodemailer";
import { config } from "$lib/chat/server/config";
import { selfHostEdition } from "$lib/chat/server/edition";
import { sendViaResend } from "$lib/chat/server/resend";

export type MailTransport = "resend" | "smtp" | "none";

/** What the transport answered: a message id, or a status (0 for SMTP) and a capped copy of its refusal. */
export type MailResult =
	| { ok: true; via: Exclude<MailTransport, "none">; id: string }
	| { ok: false; via: Exclude<MailTransport, "none">; status: number; body: string };

function setting(name: "RESEND_API_KEY" | "SMTP_URL" | "SMTP_FROM"): string {
	return String(config[name] ?? "").trim();
}

/** The transport this deployment sends through, by the precedence at the top of this file. */
export function mailTransport(): MailTransport {
	if (setting("RESEND_API_KEY")) return "resend";
	if (setting("SMTP_URL")) return "smtp";
	return "none";
}

/**
 * Email-and-password sign-in is on exactly when this is a self-host edition with no mailer: nobody can
 * receive a code, so the code would lock everyone out. A hosted deployment never gets it, even with its
 * mail misconfigured, and a self-host that configures a mailer goes back to codes alone.
 */
export function emailPasswordSignIn(): boolean {
	return selfHostEdition() && mailTransport() === "none";
}

/**
 * The sender for SMTP: SMTP_FROM, else noreply at the host PUBLIC_ORIGIN names. Many servers refuse a
 * sender outside their own domain, which is what SMTP_FROM is for.
 */
function smtpFrom(): string {
	const explicit = setting("SMTP_FROM");
	if (explicit) return explicit;
	let host = "localhost";
	try {
		const origin = String(config.PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? "");
		if (origin) host = new URL(origin).hostname || host;
	} catch {
		// not a URL; keep localhost
	}
	return `Alpha <noreply@${host}>`;
}

let cached: { url: string; transport: Transporter } | undefined;

/**
 * One transport per SMTP_URL, so connections are reused rather than opened per message. nodemailer is
 * loaded on the first SMTP send, so a deployment on Resend never loads it: importing it eagerly sits
 * on betterAuth.ts's import graph and pushed several unit specs' first import past their 30 s timeout.
 */
async function smtpTransport(url: string): Promise<Transporter> {
	if (cached?.url !== url) {
		const { default: nodemailer } = await import("nodemailer");
		cached = { url, transport: nodemailer.createTransport(url) };
	}
	return cached.transport;
}

/**
 * Sends one plain-text email through the deployment's transport. Never throws: a refused or failed
 * send comes back as `ok: false` for the caller to log, and `null` means there is no transport.
 */
export async function sendMail(message: { to: string; subject: string; text: string }): Promise<MailResult | null> {
	const via = mailTransport();
	if (via === "none") return null;
	if (via === "resend") {
		try {
			const sent = await sendViaResend(message);
			return sent.ok ? { ok: true, via, id: sent.id } : { ok: false, via, status: sent.status, body: sent.body };
		} catch (err) {
			return { ok: false, via, status: 0, body: String((err as Error)?.message ?? err).slice(0, 500) };
		}
	}
	try {
		const info = await (await smtpTransport(setting("SMTP_URL"))).sendMail({ from: smtpFrom(), ...message });
		return { ok: true, via, id: String(info.messageId ?? "") };
	} catch (err) {
		// The server's own refusal text, capped. nodemailer's error messages carry the SMTP reply, not the
		// URL, so the password in SMTP_URL does not reach this line.
		const e = err as { message?: string; responseCode?: number };
		return { ok: false, via, status: e.responseCode ?? 0, body: String(e.message ?? err).slice(0, 500) };
	}
}
