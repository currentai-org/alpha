import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { AttachmentReadError, downloadFile } from "$lib/chat/server/files/downloadFile";
import { hubBusyResponse } from "$lib/chat/server/storage/hubBusy";
import { STORAGE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";
import { multimodalEnabled } from "$lib/chat/server/textOnly";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import mimeTypes from "mime-types";

/** A bucket that failed twice for a reason other than a throttle; asking again can work. */
const ATTACHMENT_UNREADABLE_MESSAGE = "We couldn't read this file right now. Try again in a minute.";

export const GET: RequestHandler = async ({ locals, params, request }) => {
	// File download is disabled unless multimodal is enabled. With upload blocked there are no
	// files to serve anyway, but enforce the seam so a crafted hash can't probe stored blobs. Gated.
	if (!multimodalEnabled()) {
		error(403, "File download is disabled — this alpha is text-only.");
	}

	const sha256 = z.string().parse(params.sha256);

	const userId = locals.user?._id ?? locals.sessionId;

	// check user
	if (!userId) {
		error(401, "Unauthorized");
	}

	const convId = new ObjectId(z.string().parse(params.id));

	// check if the user has access to the conversation
	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	// The reference's own name locates the owner's My files copy (CUR-2183).
	const ref = conv.messages.flatMap((m) => m.files ?? []).find((f) => f.value === sha256);
	const fault = await resolveFaultInjection(request);
	let file: Awaited<ReturnType<typeof downloadFile>>;
	try {
		file = await downloadFile(sha256, convId, {
			ownerId: conv.userId?.toString(),
			guestSessionId: conv.userId ? conv.formerGuestSessionId : conv.sessionId,
			name: ref?.name,
			mime: ref?.mime,
			location: ref?.location,
			...(fault === "storage_hub_read_rate_limited" ? { fault } : {}),
		});
	} catch (e) {
		// The bucket errored on both reads. A throttle waits for the token's window to reset;
		// anything else is still worth one more try, and neither is a 500. (CUR-3680)
		if (!(e instanceof AttachmentReadError)) throw e;
		return hubBusyResponse(e, STORAGE_BUSY_MESSAGE, "files") ?? error(503, ATTACHMENT_UNREADABLE_MESSAGE);
	}
	const { value, mime } = file;

	const b64Value = Buffer.from(value, "base64");
	return new Response(b64Value, {
		headers: {
			"Content-Type": mime ?? "application/octet-stream",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
			"Content-Disposition": `attachment; filename="${sha256.slice(0, 8)}.${
				mime ? mimeTypes.extension(mime) || "bin" : "bin"
			}"`,
			"Content-Length": b64Value.length.toString(),
			"Accept-Range": "bytes",
		},
	});
};
