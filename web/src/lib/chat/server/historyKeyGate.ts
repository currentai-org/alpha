// stage 2: enrolling and unlocking the conversation-history key in the browser.
//
// The `history-key-enrollment` flag gates every surface of it: the guest's silent device key, the
// signed-in recovery step, the unlock prompt in a new browser, and Settings → Account → Your key. The
// key route itself (api/v2/keys/history, stage 1) is not gated here; it answers only the caller's own
// key, and nothing calls it while this is off.
//
// A deployment with the flag on and no custodial storage refuses loudly: it logs once per instance and
// offers no surface. It never pretends to enroll, because a browser told its key was kept would believe
// its history could be sealed (design, "Keys").
import { flagEnabledOr } from "./flags";
import { logger } from "./logger";
import { custodialStorageConfigured } from "./storage/custodialStorage";
import { custodialStorageForGuestsEnabled } from "./storage/custodialStorageGate";

export const HISTORY_KEY_ENROLLMENT_FLAG = "history-key-enrollment";

let loggedNoStorage = false;
let loggedNoGuestStorage = false;

/**
 * May this request's visitor enroll or unlock a history key?
 *
 * @param signedIn - whether the request has an account. A guest is offered the silent device key only
 * where guests may keep a key at all (the route's own `custodialStorageForGuestsEnabled` check).
 */
export function historyKeyEnrollmentOffered(signedIn: boolean): boolean {
	if (!flagEnabledOr(HISTORY_KEY_ENROLLMENT_FLAG, () => false)) return false;
	if (!custodialStorageConfigured()) {
		if (!loggedNoStorage) {
			loggedNoStorage = true;
			logger.error(
				{ event: "history-key-enrollment-no-storage", flag: HISTORY_KEY_ENROLLMENT_FLAG },
				"[history-key] the enrollment flag is on but this deployment has no custodial storage: no history key can be kept, so enrollment is withheld"
			);
		}
		return false;
	}
	if (!signedIn && !custodialStorageForGuestsEnabled()) {
		if (!loggedNoGuestStorage) {
			loggedNoGuestStorage = true;
			logger.warn(
				{ event: "history-key-enrollment-no-guest-storage", flag: HISTORY_KEY_ENROLLMENT_FLAG },
				"[history-key] the enrollment flag is on but guests may not keep keys on this deployment: guests get no device key"
			);
		}
		return false;
	}
	return true;
}

