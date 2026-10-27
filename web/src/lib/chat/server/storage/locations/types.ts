// A place a person's files can live. Alpha storage (our bucket, under users/<id>/) is one;
// a bucket of their own on Hugging Face is another. Drive, Dropbox or an iOS-style per-file grant
// would each be an adapter behind this same interface, which is why `capabilities().grant` exists:
// it says how much of the provider this location can see, so the UI can say so. (CUR-2930)
import type { CustodialSubfolder } from "../custodialBucket";
import type { UploadOptions } from "../custodialStorage";

type LocationKind = "alpha" | "hf-bucket";

/** A named subfolder, or one chat's attachment folder, `conversations/<conversationId>/<sha>`. */
export type LocationFolder = CustodialSubfolder | `conversations/${string}`;

/** The id the API and UI use for Alpha storage, which has no `storage_locations` row. */
export const ALPHA_LOCATION_ID = "alpha";

/** A person links a handful of buckets at most; this bounds a scripted flood of rows. */
export const MAX_LINKED_LOCATIONS = 10;

type LocationCapabilities = {
	/** The provider can copy within this location without the bytes passing through us. */
	serverSideCopyWithin: boolean;
	/** The largest single file we will move into or out of this location. */
	maxTransferBytes: number;
	/** How much of the provider account this location reaches: one bucket, files the person picked, or
	 *  everything the credential can see. */
	grant: "bucket" | "per-file" | "all";
	/** The sizes `list` and `stat` report are what the store holds, which differs from what `read`
	 *  returns: Alpha storage seals files (CUR-4116), so its listing counts ciphertext. A size compared
	 *  with read bytes has to come from a read. */
	listsSealedSizes?: boolean;
};

/** One file, as a listing returns it. `path` round-trips to read, stat and delete on the same location. */
type LocationFile = { path: string; size: number };

export interface StorageLocation {
	readonly id: string;
	readonly kind: LocationKind;
	readonly label: string;
	capabilities(): LocationCapabilities;
	list(): Promise<LocationFile[]>;
	/** null when no such file exists. */
	stat(path: string): Promise<{ size: number; hash?: string } | null>;
	/** null when no such file exists. */
	read(path: string): Promise<Blob | null>;
	/** Screens then writes; returns the new file's path. Throws the typed errors guard.ts maps. A chat
	 *  attachment passes its own folder under `conversations/` (attachmentPath's layout). */
	write(folder: LocationFolder, name: string, content: Blob, opts: UploadOptions): Promise<string>;
	delete(path: string): Promise<void>;
}

/** Thrown when a location's provider refuses its credential or no longer has the bucket. The registry
 *  marks the location "needs-reconnect" and the route answers 409 with a plain sentence. */
export class LocationUnavailableError extends Error {
	name = "LocationUnavailableError";
	constructor(
		readonly locationId: string,
		message: string,
		options?: { cause?: unknown }
	) {
		super(message, options);
	}
}

/** Thrown for a location id that is not this person's (or does not exist). 404, never 403. */
export class UnknownLocationError extends Error {
	name = "UnknownLocationError";
}
