/**
 * MULTIMODAL ENFORCEMENT.
 *
 * Every multimodal / file I/O path — image+file upload, file download, voice/audio input — is BLOCKED
 * at the SERVER, not merely hidden in the UI. Hiding a button is not enforcement: a crafted request
 * could still upload a file or post an image, so each seam checks the gate and rejects.
 *
 * The gate is `multimodalEnabled()` in $lib/chat/server/multimodalMode: a PostHog flag, with
 * MULTIMODAL_ENABLED as the deployment's statement that it will serve images and audio (CUR-159). An
 * env var alone would leave the feature shut by an undecided default, one config edit from live.
 *
 * This re-export lets the seams keep one import. It is a function, because a constant would freeze the
 * answer at module init, which the flag plane exists to avoid.
 */
export {
	multimodalEnabled,
	multimodalConfigured,
	multimodalOnSignIn,
	modelTakesImagesNow,
	MULTIMODAL_FLAG,
} from "./multimodalMode";
