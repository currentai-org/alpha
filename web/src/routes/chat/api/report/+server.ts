/**
 * General "report a problem with the chat" — the second report channel (not tied to a specific
 * answer). Writes through the SAME saveReport / `reports` table as the per-answer report button, so
 * both land in one pipeline and one admin view (/admin/reports). No conversation scope and no auth
 * wall (a guest can report a bug), mirroring the per-answer route's "present on every session".
 */
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { saveReport } from "$lib/chat/server/db/reports";
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";

const generalReportSchema = z.object({
	category: z.enum(["bug", "ux", "content", "other"]),
	detail: z.string().max(2000).nullish(),
});

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	let body: z.infer<typeof generalReportSchema>;
	try {
		body = generalReportSchema.parse(await request.json());
	} catch {
		throw error(400, "Pick a category for the problem.");
	}

	// The same limiter, keying and type as the per-answer report route, so a
	// script cannot fill the reports queue. A 429 here saves nothing.
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});

	try {
		await saveReport({
			category: body.category,
			detail: body.detail ?? undefined,
			userId: locals.user?._id?.toString(),
			sessionId: locals.sessionId,
		});
	} catch {
		throw error(500, "Failed to save report");
	}

	return json({ ok: true });
};
