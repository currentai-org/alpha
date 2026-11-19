import { describe, it, expect, vi, beforeEach } from "vitest";

// Which transport a deployment's mail takes, and what each one is handed.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const smtpSend = vi.fn();
const createTransport = vi.fn((_url: string) => ({ sendMail: smtpSend }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// mailer.ts keeps one transport per SMTP_URL, so each SMTP test below names its own host.
const { mailTransport, emailPasswordSignIn, sendMail } = await import("./mailer");

const message = { to: "person@alpha.test", subject: "Your Alpha sign-in code", text: "Your sign-in code is 123456." };

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	smtpSend.mockReset();
	createTransport.mockClear();
	fetchMock.mockReset();
});

describe("mailTransport: Resend, else SMTP_URL, else none", () => {
	it("keeps a hosted deployment on Resend even when SMTP_URL is also set", () => {
		cfg.RESEND_API_KEY = "re_test_key";
		cfg.SMTP_URL = "smtp://mailpit:1025";
		expect(mailTransport()).toBe("resend");
	});

	it("uses SMTP_URL when no Resend key is set", () => {
		cfg.SMTP_URL = "smtp://mailpit:1025";
		expect(mailTransport()).toBe("smtp");
	});

	it("reads blank values as unset", () => {
		cfg.RESEND_API_KEY = "  ";
		cfg.SMTP_URL = "";
		expect(mailTransport()).toBe("none");
	});
});

describe("emailPasswordSignIn: only a self-host edition with no mailer", () => {
	it("is on for ALPHA_EDITION=selfhost with neither RESEND_API_KEY nor SMTP_URL", () => {
		cfg.ALPHA_EDITION = "selfhost";
		expect(emailPasswordSignIn()).toBe(true);
	});

	it("stays off on a self-host that has a mailer, which signs in with codes", () => {
		cfg.ALPHA_EDITION = "selfhost";
		cfg.SMTP_URL = "smtp://mailpit:1025";
		expect(emailPasswordSignIn()).toBe(false);
	});

	it("stays off (fail closed) on a hosted or unset edition, even with no mailer at all", () => {
		cfg.ALPHA_EDITION = "hosted";
		expect(emailPasswordSignIn()).toBe(false);
		delete cfg.ALPHA_EDITION;
		expect(emailPasswordSignIn()).toBe(false);
	});
});

describe("sendMail", () => {
	it("returns null and sends nothing with no transport", async () => {
		expect(await sendMail(message)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("sends through Resend's API, never SMTP, when RESEND_API_KEY is set", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		cfg.SMTP_URL = "smtp://mailpit:1025";
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));
		expect(await sendMail(message)).toEqual({ ok: true, via: "resend", id: "resend-1" });
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.resend.com/emails");
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("sends through the SMTP server SMTP_URL names, from SMTP_FROM, with the message unchanged", async () => {
		cfg.SMTP_URL = "smtp://user:pw@mailpit:1025";
		cfg.SMTP_FROM = "Alpha <noreply@alpha.test>";
		smtpSend.mockResolvedValueOnce({ messageId: "<m1@alpha.test>" });
		expect(await sendMail(message)).toEqual({ ok: true, via: "smtp", id: "<m1@alpha.test>" });
		expect(createTransport).toHaveBeenCalledWith("smtp://user:pw@mailpit:1025");
		expect(smtpSend).toHaveBeenCalledWith({ from: "Alpha <noreply@alpha.test>", ...message });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reuses one transport across sends to the same SMTP_URL", async () => {
		cfg.SMTP_URL = "smtp://reuse:1025";
		smtpSend.mockResolvedValue({ messageId: "x" });
		await sendMail(message);
		await sendMail(message);
		expect(createTransport).toHaveBeenCalledTimes(1);
	});

	it("reports an SMTP refusal as ok:false with the reply code, never throws", async () => {
		cfg.SMTP_URL = "smtp://refuse:1025";
		smtpSend.mockRejectedValueOnce(Object.assign(new Error("550 relay denied"), { responseCode: 550 }));
		expect(await sendMail(message)).toEqual({ ok: false, via: "smtp", status: 550, body: "550 relay denied" });
	});
});

describe("the SMTP sender", () => {
	it("defaults to noreply at PUBLIC_ORIGIN's host when SMTP_FROM is unset", async () => {
		cfg.SMTP_URL = "smtp://from:1025";
		cfg.PUBLIC_ORIGIN = "https://chat.example.com";
		smtpSend.mockResolvedValueOnce({ messageId: "x" });
		await sendMail(message);
		expect(smtpSend.mock.calls[0][0].from).toBe("Alpha <noreply@chat.example.com>");
	});
});
