// The journeys page — six documented journeys, their recorded walkthroughs, and the grader's
// verdict on each, on one page somebody outside this repo can open (CUR-1524).
//
// The CI journey run executes the suite against develop's preview, keeps every tagged test's video,
// and grades each journey doc against its recordings. scripts/publish-journey-gallery.mjs writes that
// run into `config` and `files`; this page reads it.
//
// Gated on a staff role, same as every other panel under /chat/admin. Not because the
// verdicts are secret — because a preview deployment answers 200 to anyone, and an open page there
// publishes our walkthrough recordings to whoever guesses the path.

import type { PageServerLoad } from "./$types";
import { eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { getDb } from "$lib/chat/server/db/client";
import { configKv } from "$lib/chat/server/db/schema";
import { MANIFEST_KEY, withUndocumentedAsNotCovered, type JourneyManifest } from "$lib/chat/server/journeyGallery";
import { isAdminPermitted } from "$lib/chat/server/adminAuth";

// NO per-route `export const config` here — a per-route config splits the adapter-vercel build and
// drops the /chat base from route patterns. Rely on the 300s default.

async function readManifest(): Promise<JourneyManifest | null> {
	const db = getDb();
	const [row] = await db.select().from(configKv).where(eq(configKv.key, MANIFEST_KEY)).limit(1);
	const manifest = (row?.doc as unknown as JourneyManifest) ?? null;
	return manifest && { ...manifest, journeys: withUndocumentedAsNotCovered(manifest.journeys ?? []) };
}

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!(await isAdminPermitted({ cookies, locals }, { console: "view" }))) {
		return { needsLogin: true, signedIn: Boolean(locals.user), manifest: null, buildSha: null };
	}

	return {
		needsLogin: false,
		signedIn: Boolean(locals.user),
		manifest: await readManifest(),
		// The commit THIS page was built from. Comparing it to the manifest's own sha is the whole
		// staleness check, and it needs no GitHub call: the preview is built from the branch tip, so
		// a mismatch means the page is showing an older commit than the reader is looking at.
		buildSha: env.VERCEL_GIT_COMMIT_SHA ?? null,
	};
};
