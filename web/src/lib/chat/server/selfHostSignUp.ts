// Who may create a password account on a self-hosted Alpha with no mailer.
//
// With no mailer, password sign-in replaces the email code (mailer.ts emailPasswordSignIn) and nobody
// verifies an address. Open WebUI's default is followed: the first account on the stack is the
// operator's, and sign-up closes after it (its signup route turns ENABLE_SIGNUP off once the first user
// exists). ALPHA_OPEN_SIGNUP=true keeps sign-up open. Only Better Auth's /sign-up/email route is
// limited: Google, GitHub, Hugging Face and the organisation's own login are separate choices the
// operator makes by registering a client, and a hosted deployment never has password sign-up at all.
import { and, eq, lt, or } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { config } from "$lib/chat/server/config";
import { getDb, schema } from "$lib/chat/server/db/client";
import { emailPasswordSignIn } from "$lib/chat/server/mailer";
import { SIGN_UP_CLOSED_CODE, SIGN_UP_CLOSED_MESSAGE } from "$lib/chat/signUpClosed";

/** The Better Auth route a password account is created on. */
const PASSWORD_SIGN_UP_PATH = "/sign-up/email";


/** True only for ALPHA_OPEN_SIGNUP="true" (case and surrounding space ignored). */
function openSignUpSetting(value: unknown): boolean {
	return String(value ?? "").trim().toLowerCase() === "true";
}

/**
 * The decision itself, kept pure so it can be tested without a database:
 * - not a mailless self-host: "not-limited" (hosted keeps its own sign-in, unchanged);
 * - ALPHA_OPEN_SIGNUP=true: "open";
 * - otherwise "open" for the first account and "closed" once any account exists.
 */
export function signUpGate(input: {
	passwordSignIn: boolean;
	openSignUp: boolean;
	accountExists: boolean;
}): "not-limited" | "open" | "closed" {
	if (!input.passwordSignIn) return "not-limited";
	if (input.openSignUp) return "open";
	return input.accountExists ? "closed" : "open";
}

/** Does this deployment limit password sign-up to the first account? */
function signUpLimited(): boolean {
	return emailPasswordSignIn() && !openSignUpSetting(Reflect.get(config, "ALPHA_OPEN_SIGNUP"));
}

async function anyAccountExists(): Promise<boolean> {
	const rows = await getDb().select({ id: schema.user.id }).from(schema.user).limit(1);
	return rows.length > 0;
}

/** For the sign-in page: is password sign-up closed on this deployment right now? */
export async function passwordSignUpClosed(): Promise<boolean> {
	if (!signUpLimited()) return false;
	return (
		signUpGate({ passwordSignIn: true, openSignUp: false, accountExists: await anyAccountExists() }) ===
		"closed"
	);
}

function closed(): APIError {
	// 403 is safe here only while emailAndPassword keeps autoSignIn on and requireEmailVerification off:
	// with either changed, Better Auth's sign-up route answers a 403 from user creation with its generic
	// "duplicate" success (better-auth api/routes/sign-up.mjs), and the refusal would go silent.
	return new APIError("FORBIDDEN", { code: SIGN_UP_CLOSED_CODE, message: SIGN_UP_CLOSED_MESSAGE });
}

/** databaseHooks.user.create.before: refuse a password sign-up once an account exists. */
export async function refuseClosedSignUp(ctx: { path?: string } | null | undefined): Promise<void> {
	if (ctx?.path !== PASSWORD_SIGN_UP_PATH || !signUpLimited()) return;
	if (await anyAccountExists()) throw closed();
}

/**
 * databaseHooks.user.create.after: two first sign-ups at once both pass the check above, so the one that
 * finds an older account removes its own row and is refused, the same insert-then-check Open WebUI uses
 * for its first admin. The ordering is (created_at, id), so exactly one of them stays. The row has no
 * account or session yet: Better Auth links the password only after this hook returns.
 */
export async function undoLosingFirstSignUp(
	created: { id: string; createdAt: Date },
	ctx: { path?: string } | null | undefined
): Promise<void> {
	if (ctx?.path !== PASSWORD_SIGN_UP_PATH || !signUpLimited()) return;
	const { user } = schema;
	const older = await getDb()
		.select({ id: user.id })
		.from(user)
		.where(
			or(
				lt(user.createdAt, created.createdAt),
				and(eq(user.createdAt, created.createdAt), lt(user.id, created.id))
			)
		)
		.limit(1);
	if (older.length === 0) return;
	await getDb().delete(user).where(eq(user.id, created.id));
	throw closed();
}
