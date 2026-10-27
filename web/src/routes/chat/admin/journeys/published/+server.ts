// What this deployment can actually see among the published journeys, as JSON, so a publisher can
// check its own write landed where a reader will look for it.
//
// A deployment can read a branch-scoped database override that differs from the one a publisher
// resolves from the shared config, and neither end can see the mismatch: the publish succeeds while
// the page, truthfully reporting the database it can see, says no run was ever published. The CI run
// therefore resolves its config from Vercel scoped to the ref, so both ends read one authority, and
// this route lets a publisher confirm it.
// This endpoint is the proof rather than the assumption: after publishing, CI fetches this through
// the real deployment URL and fails if the sha it gets back is not the sha it just wrote. A future
// divergence then breaks the run that caused it, naming both sides, instead of surfacing days later
// as a page that looks merely empty.
//
// It deliberately returns no findings, no titles and no filenames — only enough to answer "is the
// run I just published the run this deployment serves". Anything more would make this a second,
// less considered copy of the page's own loader.

import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { getDb } from "$lib/chat/server/db/client";
import { configKv } from "$lib/chat/server/db/schema";
import { MANIFEST_KEY, type JourneyManifest } from "$lib/chat/server/journeyGallery";
import { isAdminPermitted } from "$lib/chat/server/adminAuth";

export const GET: RequestHandler = async ({ cookies, locals }) => {
	// 404, not 401, matching the video route: an unauthenticated caller learns nothing about
	// whether this deployment has published journeys at all.
	if (!(await isAdminPermitted({ cookies, locals }, { console: "view" }))) error(404, "Not found");

	const db = getDb();
	const [row] = await db.select().from(configKv).where(eq(configKv.key, MANIFEST_KEY)).limit(1);
	const manifest = (row?.doc as unknown as JourneyManifest) ?? null;

	return json({
		// null rather than an omitted field, so a caller comparing shas sees "this deployment has
		// no run" as a value it must handle rather than as undefined matching undefined.
		sha: manifest?.run?.sha ?? null,
		ranAt: manifest?.run?.ranAt ?? null,
		journeys: manifest?.journeys?.length ?? 0,
		buildSha: env.VERCEL_GIT_COMMIT_SHA ?? null,
	});
};
