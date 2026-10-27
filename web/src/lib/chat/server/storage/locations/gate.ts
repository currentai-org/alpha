import { deployEnv } from "$lib/chat/server/deployEnv";
import { flagEnabledForUser } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. Gates linking a person's own bucket, choosing a default location, and
 *  everything that reads or writes a linked location (CUR-2930). Person-scoped, and read only behind
 *  `custodial-storage-view`, since there is no storage surface to add a location to without it. */
export const STORAGE_LOCATIONS_FLAG = "storage-locations";

/** True only when PostHog said so; an unevaluable flag is off, as custodialStorageGate.ts argues. */
export async function storageLocationsEnabledForUser(accountId: string, email: string | undefined): Promise<boolean> {
	// The flag's release groups target `email` (team domains); without it every evaluation is false (CUR-3050).
	const enabled = await flagEnabledForUser(STORAGE_LOCATIONS_FLAG, accountId, {
		env: deployEnv() ?? "unknown",
		...(email ? { email } : {})
	});
	return enabled === true;
}
