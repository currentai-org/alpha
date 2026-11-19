import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { json } from "$lib/chat/server/api/utils/json";
import { secretEquals } from "$lib/chat/server/crypto";
import { cmsPublished } from "$lib/chat/server/cmsPublish";
import type { RequestHandler } from "./$types";

// Chat's own CMS publish webhook. On the chat host, `/api/cms/invalidate` reroutes here
// (surface.ts), so it is the address www forwards every publish to, with the same body and the same
// shared secret Payload sent. On a build that serves the site too, the site's route at
// `/api/cms/invalidate` hands the publish to the same `cmsPublished` in process instead.
//
// It clears this instance's cached CMS reads and refreshes a published policy page in chat's
// retrieval. The site's CDN purge is not chat's: no chat page carries the CMS page cache tag.
export const POST: RequestHandler = async ({ request }) => {
	const secret = env.CMS_REVALIDATE_SECRET;
	if (!secret || !secretEquals(request.headers.get("x-cms-revalidate-secret"), secret)) {
		error(401, "Unauthorized");
	}
	const invalidated = await cmsPublished(await request.json());
	return json({ invalidated });
};
