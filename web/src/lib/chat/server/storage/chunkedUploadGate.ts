import { deployEnv } from "$lib/chat/server/deployEnv";
import { flagEnabledForUser } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. Lets My files take a file over the single-request 4.4 MB ceiling by
 *  sending it in chunks the server reassembles and checks whole (CUR-1780). Person-scoped, and read
 *  only behind `custodial-storage-view`, the surface it enlarges. */
export const CHUNKED_UPLOADS_FLAG = "chunked-uploads";

/** True only when PostHog said so; an unevaluable flag is off, as custodialStorageGate.ts argues. */
export async function chunkedUploadsEnabledForUser(accountId: string, email: string | undefined): Promise<boolean> {
	// Release groups target `email` (team domains), as storage-locations' do (CUR-3050).
	const enabled = await flagEnabledForUser(CHUNKED_UPLOADS_FLAG, accountId, {
		env: deployEnv() ?? "unknown",
		...(email ? { email } : {}),
	});
	return enabled === true;
}
