/**
 * Public contribution capture for the "what happens after the chat" paths, mirroring the Vercel
 * app's app/(chat)/api/contribute/route.ts, and for "tell us you want to help with [language] data"
 * (`data_interest`), which stores a language and an optional email, and for "know a model that does
 * [language] well?" (`model_suggestion`), which stores the language, the model as written and an
 * optional email. No auth wall (an attendee may submit straight from the
 * welcome overlay), but we attach the guest session's userId if one exists, and rate-limit per IP.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { saveContribution, countContributionsByIpSince } from "$lib/chat/server/db/contributions";

// Hard-coded to match the Vercel app's LIMITS.contributionsPerDayPerIp (chat/lib/limits.ts).
// No env needed for parity.
const CONTRIB_CAP = 30;

const contributeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.enum(["subscribe", "contribute"]),
		email: z.string().email().max(256),
		name: z.string().max(200).nullish(),
		organization: z.string().max(200).nullish(),
		contributionType: z.enum(["compute", "data", "code", "funding", "other"]).nullish(),
		detail: z.string().max(2000).nullish(),
	}),
	// "Tell us you want to help with [language] data": counted per language, email optional.
	z.object({
		kind: z.literal("data_interest"),
		language: z.string().regex(/^[a-z]{3}(-[A-Za-z0-9]{2,8})?$/),
		// "My language isn't listed" (language `und`): the name as the person wrote it, kept in `detail`.
		languageName: z.string().trim().min(1).max(120).nullish(),
		email: z
			.string()
			.email()
			.max(256)
			.nullish()
			.or(z.literal("").transform(() => null)),
	}),
	// "Know a model that does [language] well?": the model as the person wrote it, kept in `detail`.
	z.object({
		kind: z.literal("model_suggestion"),
		language: z.string().regex(/^[a-z]{3}(-[A-Za-z0-9]{2,8})?$/),
		model: z.string().trim().min(1).max(200),
		email: z
			.string()
			.email()
			.max(256)
			.nullish()
			.or(z.literal("").transform(() => null)),
	}),
]);

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	let body: z.infer<typeof contributeSchema>;
	try {
		body = contributeSchema.parse(await request.json());
	} catch {
		throw error(400, "A kind is required, with a valid email or, for data interest, a language.");
	}

	// Per-IP daily cap before insert. Fail OPEN on any cap-check exception — we'd rather lose
	// spam protection than drop a real contributor's submission (matches the Vercel contract).
	const ip = getClientAddress();
	if (ip) {
		try {
			const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
			const n = await countContributionsByIpSince(ip, since);
			if (n >= CONTRIB_CAP) {
				throw error(429, "Too many submissions today.");
			}
		} catch (e) {
			// Re-throw the 429 (it's a SvelteKit HttpError with a numeric status); swallow anything else.
			if (e && typeof e === "object" && "status" in e && e.status === 429) {
				throw e;
			}
		}
	}

	// Best-effort attribution — never block a submission on the session lookup.
	let userId: string | null = null;
	try {
		userId = locals.user?._id?.toString() ?? locals.sessionId ?? null;
	} catch {
		userId = null;
	}

	try {
		await saveContribution(
			body.kind === "model_suggestion"
				? {
						kind: body.kind,
						language: body.language,
						detail: body.model,
						email: body.email ?? null,
						userId,
						ip: ip ?? null,
					}
				: body.kind === "data_interest"
				? {
						kind: body.kind,
						language: body.language,
						detail: body.languageName ?? null,
						email: body.email ?? null,
						userId,
						ip: ip ?? null,
					}
				: {
						kind: body.kind,
						email: body.email,
						name: body.name ?? null,
						organization: body.organization ?? null,
						contributionType: body.kind === "contribute" ? (body.contributionType ?? null) : null,
						detail: body.detail ?? null,
						userId,
						ip: ip ?? null,
					}
		);
	} catch {
		throw error(500, "Failed to save contribution");
	}

	return json({ ok: true });
};
