import { type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { requireExportUser } from "$lib/chat/server/dataPortability";
import { hasSealedFields } from "$lib/chat/crypto/sealedShape";

// The account's sealed conversations exactly as stored. The export routes
// beside this one cannot read a sealed message or title, so the account page fetches these, opens them
// with the person's history key, and writes their text into the file it downloads. Nothing opened ever
// comes back to the server. Not rate-limited apart from the export itself: it hands back ciphertext the
// owner can already read one conversation at a time.
export const GET: RequestHandler = async ({ locals }) => {
	requireExportUser(locals.user);
	const conversations = await collections.conversations.find({ ...authCondition(locals) }).toArray();
	return superjsonResponse(
		{
			conversations: conversations.filter(hasSealedFields).map((c) => ({
				id: c._id.toString(),
				title: c.title,
				sealedTitle: c.sealedTitle,
				sealedTitleRev: c.sealedTitleRev,
				model: c.model,
				createdAt: c.createdAt,
				updatedAt: c.updatedAt,
				messages: c.messages,
			})),
		},
		{ headers: { "Cache-Control": "private, no-store" } }
	);
};
