import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { json } from "$lib/chat/server/api/utils/json";
import { createStorageLocation, listStorageLocations } from "$lib/chat/server/db/storageLocations";
import {
	normalizePrefix,
	parseBucketRepo,
	verifyBucketLink,
} from "$lib/chat/server/storage/locations/hfBucketLocation";
import { credentialSecret, summarizeLocations } from "$lib/chat/server/storage/locations/registry";
import { seal } from "$lib/chat/server/storage/locations/sealedSecret";
import { MAX_LINKED_LOCATIONS } from "$lib/chat/server/storage/locations/types";

import { requireLocationsAccess, storageFailure } from "../guard";

// The places this account's files can live. GET lists them (Alpha storage first) with the
// default marked; POST links a Hugging Face bucket of the person's own with a token they paste.
// The token is checked against the Hub, sealed (sealedSecret.ts), and never sent back. (CUR-2930)

const LinkBody = z.object({
	bucket: z.string().min(1).max(300),
	folder: z.string().max(200).optional().default(""),
	token: z.string().min(8).max(500),
	label: z.string().trim().max(80).optional(),
});

export const GET: RequestHandler = async ({ locals }) => {
	const accountId = await requireLocationsAccess(locals);
	return json(await summarizeLocations(accountId));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const accountId = await requireLocationsAccess(locals);
	const parsed = LinkBody.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Give a bucket name and a token.");
	const { bucket, folder, token, label } = parsed.data;

	const repo = parseBucketRepo(bucket);
	if (!repo) error(400, "That doesn't look like a bucket name. It should look like your-name/bucket-name.");
	const prefix = normalizePrefix(folder);
	if (prefix === null) error(400, "That folder name has characters a bucket path can't hold.");

	const linked = await listStorageLocations(accountId);
	// A second row for the same place would list it twice and let a move copy a file onto itself.
	if (linked.some((l) => l.config.repo === repo && l.config.prefix === prefix)) {
		error(409, "That bucket folder is already linked.");
	}
	if (linked.length >= MAX_LINKED_LOCATIONS) {
		error(400, `You can link up to ${MAX_LINKED_LOCATIONS} locations.`);
	}

	try {
		await verifyBucketLink(repo, prefix, token.trim());
	} catch (e) {
		return storageFailure(e);
	}
	const row = await createStorageLocation({
		userId: accountId,
		kind: "hf-bucket",
		label: label || repo.replace(/^buckets\//, ""),
		config: { repo, prefix },
		credential: seal(token.trim(), credentialSecret()),
	});
	return json({ id: row.id }, { status: 201 });
};
