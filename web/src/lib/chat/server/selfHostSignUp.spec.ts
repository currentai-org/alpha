import { describe, it, expect, vi, beforeEach } from "vitest";

// Password sign-up on a self-host with no mailer closes after the first account.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

// The user rows the hooks see, and the rows they delete. Only the query shapes selfHostSignUp.ts uses.
let rows: { id: string }[] = [];
const deleted: string[] = [];
vi.mock("$lib/chat/server/db/client", () => {
	const user = { id: "id", createdAt: "created_at" };
	const query = { from: () => query, where: () => query, limit: async () => rows };
	return {
		schema: { user },
		getDb: () => ({
			select: () => query,
			delete: () => ({
				where: async () => {
					deleted.push("row");
				},
			}),
		}),
	};
});

const {
	signUpGate,
	passwordSignUpClosed,
	refuseClosedSignUp,
	undoLosingFirstSignUp,
} = await import("./selfHostSignUp");
const { SIGN_UP_CLOSED_CODE } = await import("$lib/chat/signUpClosed");

const signUp = { path: "/sign-up/email" };

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	rows = [];
	deleted.length = 0;
});

describe("signUpGate", () => {
	it("leaves a deployment without password sign-in alone (hosted behaves as before)", () => {
		expect(signUpGate({ passwordSignIn: false, openSignUp: false, accountExists: true })).toBe("not-limited");
	});

	it("is open for the first account on a mailless self-host", () => {
		expect(signUpGate({ passwordSignIn: true, openSignUp: false, accountExists: false })).toBe("open");
	});

	it("is closed once any account exists, unless ALPHA_OPEN_SIGNUP opens it", () => {
		expect(signUpGate({ passwordSignIn: true, openSignUp: false, accountExists: true })).toBe("closed");
		expect(signUpGate({ passwordSignIn: true, openSignUp: true, accountExists: true })).toBe("open");
	});
});

describe("passwordSignUpClosed with an account on the stack: only ALPHA_OPEN_SIGNUP=true reopens it", () => {
	beforeEach(() => {
		cfg.ALPHA_EDITION = "selfhost";
		rows = [{ id: "operator" }];
	});

	it.each([
		["true", false],
		[" TRUE ", false],
		["", true],
		["1", true],
		["yes", true],
	])("ALPHA_OPEN_SIGNUP=%j -> closed %s", async (value, closed) => {
		cfg.ALPHA_OPEN_SIGNUP = value;
		expect(await passwordSignUpClosed()).toBe(closed);
	});

	it("never closes a hosted deployment or a self-host with a mailer, which have no password sign-up", async () => {
		cfg.ALPHA_EDITION = "hosted";
		expect(await passwordSignUpClosed()).toBe(false);
		cfg.ALPHA_EDITION = "selfhost";
		cfg.SMTP_URL = "smtp://mailpit:1025";
		expect(await passwordSignUpClosed()).toBe(false);
	});
});

describe("the hooks on Better Auth's user creation", () => {
	beforeEach(() => {
		cfg.ALPHA_EDITION = "selfhost";
	});

	it("lets the first password account through and reports sign-up open", async () => {
		await expect(refuseClosedSignUp(signUp)).resolves.toBeUndefined();
		expect(await passwordSignUpClosed()).toBe(false);
	});

	it("refuses a password sign-up once an account exists, with the code the sign-in page shows", async () => {
		rows = [{ id: "operator" }];
		expect(await passwordSignUpClosed()).toBe(true);
		await expect(refuseClosedSignUp(signUp)).rejects.toMatchObject({
			statusCode: 403,
			body: { code: SIGN_UP_CLOSED_CODE },
		});
	});

	it("leaves other routes that create users alone (OAuth, email code)", async () => {
		rows = [{ id: "operator" }];
		await expect(refuseClosedSignUp({ path: "/callback/:id" })).resolves.toBeUndefined();
		await expect(refuseClosedSignUp(undefined)).resolves.toBeUndefined();
	});

	it("leaves a hosted deployment alone even with accounts", async () => {
		cfg.ALPHA_EDITION = "hosted";
		rows = [{ id: "someone" }];
		await expect(refuseClosedSignUp(signUp)).resolves.toBeUndefined();
		expect(await passwordSignUpClosed()).toBe(false);
	});

	it("undoes the losing one of two first sign-ups at once: deletes its row and refuses it", async () => {
		const created = { id: "late", createdAt: new Date() };
		rows = [{ id: "early" }];
		await expect(undoLosingFirstSignUp(created, signUp)).rejects.toMatchObject({ statusCode: 403 });
		expect(deleted).toHaveLength(1);
	});

	it("keeps the account when no older one exists", async () => {
		await expect(undoLosingFirstSignUp({ id: "first", createdAt: new Date() }, signUp)).resolves.toBeUndefined();
		expect(deleted).toHaveLength(0);
	});
});
