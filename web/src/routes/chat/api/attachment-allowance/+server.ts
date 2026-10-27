import { json } from "$lib/chat/server/api/utils/json";
import { attachmentAllowanceEnforced, attachmentAllowanceLeft } from "$lib/chat/server/db/attachmentAllowance";
import { hashIp } from "$lib/chat/server/db/ipHash";
import { logger } from "$lib/chat/server/logger";

/**
 * What this visitor can still attach in chat over the rolling 24 hours, for the composer to
 * check a file against when it is attached (`fetchAttachmentRoom`). parseRequest checks the same
 * allowance again at send. A failed count answers 204, and the composer lets the file through; so does
 * the `attachment-allowance` flag being off, since then nothing is refused (CUR-3600).
 * `private, no-store`: the answer is per visitor and changes with every send. A spent allowance is
 * logged with `network`, since the composer refuses at attach and nothing else would record whether a
 * guest's session or their network ran out (CUR-3600). (CUR-3235)
 */
export async function GET({ locals, getClientAddress }) {
	const headers = { "Cache-Control": "private, no-store" };
	if (!attachmentAllowanceEnforced()) return new Response(null, { status: 204, headers });
	const userId = locals.user?._id?.toString();
	const left = await attachmentAllowanceLeft(
		userId
			? { userId }
			: { guestSessionId: locals.sessionId, ipHash: hashIp(getClientAddress(), "rate-limit") ?? undefined }
	);
	if (!left) return new Response(null, { status: 204, headers });
	if (left.files <= 0 || left.bytes <= 0) {
		logger.info({ guest: !userId, network: left.network === true, at: "attach" }, "[attachment-allowance] refused");
	}
	return json(
		{
			files: left.files,
			bytes: left.bytes,
			guest: !userId,
			...(left.network ? { network: true } : {}),
			...(left.resetsAt ? { resetsInMs: Math.max(0, left.resetsAt.getTime() - Date.now()) } : {}),
		},
		{ headers }
	);
}
