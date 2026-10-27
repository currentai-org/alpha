import { m } from '$lib/paraglide/messages.js';
// (account, location id) → a StorageLocation, or a typed refusal. The only place a sealed
// credential is opened, and the place a location's "needs-reconnect" status is written, so a broken
// location reads the same everywhere it is shown. (CUR-2930)
import { logger } from "$lib/chat/server/logger";
import {
	getStorageLocation,
	getStoragePreferences,
	listStorageLocations,
	setLastUsedStorageLocation,
	setStorageLocationCredential,
	setStorageLocationStatus,
	type StorageLocationRow,
} from "$lib/chat/server/db/storageLocations";
import { custodialLocation } from "./custodialLocation";
import { hfBucketLocation } from "./hfBucketLocation";
import { freshGrant, OAuthGrantError, parseGrant, serializeGrant, storageOAuthApp } from "./hfOAuth";
import { credentialSecret, open, seal, SealedSecretError } from "./sealedSecret";
import {
	ALPHA_LOCATION_ID,
	LocationUnavailableError,
	UnknownLocationError,
	type StorageLocation,
} from "./types";

export const ASK_EVERY_TIME = "ask";
/** The default for an account that never chose: wherever its most recent upload went. (CUR-3077) */
export const LAST_USED = "last";

export { credentialSecret };

/** Marks the location for reconnecting whenever its provider refuses it, then rethrows, and marks it
 *  answering again the first time a call succeeds after that, so "Reconnect" clears on its own. */
function watched(userId: string, loc: StorageLocation, status: StorageLocationRow["status"]): StorageLocation {
	let current = status;
	const guard =
		<A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
		async (...a: A): Promise<R> => {
			try {
				const result = await fn(...a);
				if (current === "needs-reconnect") {
					current = "ok";
					await setStorageLocationStatus(userId, loc.id, "ok", null).catch((err) =>
						logger.warn({ err }, "[storage-locations] could not record ok")
					);
				}
				return result;
			} catch (e) {
				if (e instanceof LocationUnavailableError) {
					await setStorageLocationStatus(userId, loc.id, "needs-reconnect", e.message).catch((err) =>
						logger.warn({ err }, "[storage-locations] could not record needs-reconnect")
					);
				}
				throw e;
			}
		};
	return {
		...loc,
		list: guard(loc.list),
		stat: guard(loc.stat),
		read: guard(loc.read),
		write: guard(loc.write),
		delete: guard(loc.delete),
	};
}

function reconnectMessage(row: StorageLocationRow): string {
	return row.config.grant === "oauth"
		? "This location needs reconnecting: use Connect Hugging Face again."
		: "This location needs reconnecting: paste a fresh token for it.";
}

/**
 * The access token a row's credential stands for. A pasted token is the credential itself. An OAuth
 * grant is renewed when it is within a minute of expiry, and the renewal is sealed back into the row.
 *
 * Two requests can renew the same grant at once. If Hugging Face rotates refresh tokens, the slower one
 * is refused because its refresh token was already spent, so a refused renewal re-reads the row and uses
 * what the faster request stored before calling the location broken.
 */
async function accessToken(userId: string, row: StorageLocationRow): Promise<string> {
	const plaintext = open(row.credential, credentialSecret());
	const grant = parseGrant(plaintext);
	if (!grant) return plaintext;
	try {
		const fresh = await freshGrant(grant);
		if (fresh !== grant) {
			await setStorageLocationCredential(userId, row.id, seal(serializeGrant(fresh), credentialSecret()));
		}
		return fresh.access;
	} catch (e) {
		if (!(e instanceof OAuthGrantError)) throw e;
		const reread = await getStorageLocation(userId, row.id);
		if (reread && reread.credential !== row.credential) {
			const other = parseGrant(open(reread.credential, credentialSecret()));
			if (other && other.expiresAt > Date.now()) return other.access;
		}
		throw e;
	}
}

async function fromRow(userId: string, row: StorageLocationRow): Promise<StorageLocation> {
	if (row.kind !== "hf-bucket") throw new UnknownLocationError(`unknown location kind ${row.kind}`);
	let token: string;
	try {
		token = await accessToken(userId, row);
	} catch (e) {
		if (e instanceof SealedSecretError || e instanceof OAuthGrantError) {
			throw new LocationUnavailableError(row.id, reconnectMessage(row), { cause: e });
		}
		throw e;
	}
	return hfBucketLocation({
		id: row.id,
		label: row.label,
		userId,
		repo: row.config.repo,
		prefix: row.config.prefix,
		token,
	});
}

/** Alpha storage for "alpha" or nothing; else this account's own linked location, or UnknownLocationError. */
export async function resolveLocation(userId: string, id?: string | null): Promise<StorageLocation> {
	if (!id || id === ALPHA_LOCATION_ID) return custodialLocation(userId);
	const row = await getStorageLocation(userId, id);
	if (!row) throw new UnknownLocationError("no such location");
	try {
		return watched(userId, await fromRow(userId, row), row.status);
	} catch (e) {
		if (e instanceof LocationUnavailableError) {
			await setStorageLocationStatus(userId, row.id, "needs-reconnect", e.message).catch((err) =>
				logger.warn({ err }, "[storage-locations] could not record needs-reconnect")
			);
		}
		throw e;
	}
}

/** Thrown when the default is "ask" and the upload named no location: the client must ask first. */
export class LocationChoiceRequiredError extends Error {
	name = "LocationChoiceRequiredError";
}

/**
 * Where an upload that names no location goes, before any credential is opened. Returns
 * "ask", "alpha" or a location id; the id may name a location that is no longer linked, which only an
 * explicit default can do, and the caller refuses that loudly.
 *
 * - No saved default is "Last used": the most recent upload's location while it is still linked,
 *   else Alpha storage.
 * - "ask" asks only when there is a choice. With Alpha storage the only place, it is Alpha storage. (CUR-3077)
 */
function uploadTarget(
	prefs: { defaultLocation: string | null; lastUsedLocation: string | null },
	linkedIds: readonly string[]
): string {
	const choice = prefs.defaultLocation ?? LAST_USED;
	if (choice === ASK_EVERY_TIME) return linkedIds.length > 0 ? ASK_EVERY_TIME : ALPHA_LOCATION_ID;
	if (choice === LAST_USED) {
		const last = prefs.lastUsedLocation;
		return last && linkedIds.includes(last) ? last : ALPHA_LOCATION_ID;
	}
	return choice;
}

/**
 * Where an upload goes: the location the request named, else the account's default (uploadTarget). A
 * default that points at a broken or vanished location throws LocationUnavailableError; it never
 * falls back to Alpha storage without saying so. "Last used" pointing at a linked location whose
 * credential stopped working throws the same way.
 */
export async function resolveUploadLocation(userId: string, requested?: string | null): Promise<StorageLocation> {
	if (requested) return resolveLocation(userId, requested);
	const [prefs, rows] = await Promise.all([getStoragePreferences(userId), listStorageLocations(userId)]);
	const target = uploadTarget(prefs, rows.map((r) => r.id));
	if (target === ASK_EVERY_TIME) throw new LocationChoiceRequiredError("choose where this file goes");
	if (target === ALPHA_LOCATION_ID) return custodialLocation(userId);
	if (!rows.some((r) => r.id === target)) {
		throw new LocationUnavailableError(target, "Your default location isn't linked any more. Pick another in Storage settings.");
	}
	return resolveLocation(userId, target);
}

/** Records where an upload went, for "Last used". A failed write is logged, never the (CUR-3077)
 *  upload's failure: the file is already stored. */
export async function recordUpload(userId: string, locationId: string): Promise<void> {
	await setLastUsedStorageLocation(userId, locationId).catch((err) =>
		logger.warn({ err }, "[storage-locations] could not record the last-used location")
	);
}

type LocationSummary = {
	id: string;
	kind: "alpha" | "hf-bucket";
	label: string;
	detail: string;
	status: "ok" | "needs-reconnect";
	lastError: string | null;
	/** How Alpha holds access, so a broken location offers the right fix: Connect again, or a new token. */
	grant: "alpha" | "token" | "oauth";
};

export type LocationsSummary = {
	locations: LocationSummary[];
	/** The saved choice: "last" (also when never chosen), "alpha", "ask" or a location id. */
	defaultLocation: string;
	/** Where "Last used" points right now. */
	lastUsed: string;
	/** Where an upload that names no location goes now ("ask" only when there is a choice). */
	uploadsGoTo: string;
	/** Whether the storage OAuth app is configured, so the page can offer Connect Hugging Face (CUR-2932). */
	connectAvailable: boolean;
};

/** Alpha storage first, then each linked location, for the settings list. Opens no credential. */
export async function summarizeLocations(userId: string): Promise<LocationsSummary> {
	const [rows, prefs] = await Promise.all([listStorageLocations(userId), getStoragePreferences(userId)]);
	const ids = rows.map((r) => r.id);
	const connectAvailable = storageOAuthApp() !== null;
	if (!connectAvailable) {
		logger.warn("[storage-locations] HF_STORAGE_OAUTH_CLIENT_ID/SECRET unset; Connect Hugging Face is not offered");
	}
	return {
		defaultLocation: prefs.defaultLocation ?? LAST_USED,
		lastUsed: uploadTarget({ ...prefs, defaultLocation: LAST_USED }, ids),
		uploadsGoTo: uploadTarget(prefs, ids),
		connectAvailable,
		locations: [
			{
				id: ALPHA_LOCATION_ID,
				kind: "alpha",
				label: m.storage_alphaLabel(),
				detail: m.storage_alphaDetail(),
				status: "ok",
				lastError: null,
				grant: "alpha",
			},
			...rows.map((r) => ({
				id: r.id,
				kind: "hf-bucket" as const,
				label: r.label,
				detail: `huggingface.co/${r.config.repo}${r.config.prefix ? `/${r.config.prefix.replace(/\/$/, "")}` : ""}`,
				status: (r.status === "needs-reconnect" ? "needs-reconnect" : "ok") as LocationSummary["status"],
				lastError: r.lastError,
				grant: r.config.grant ?? "token",
			})),
		],
	};
}
